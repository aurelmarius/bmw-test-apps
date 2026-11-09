// SPDX-License-Identifier: GPL-3.0-or-later
/* emby-player - plays one Emby stream on the head unit: MPEG-TS on stdin, the picture on the GPU into mgu-render's
 * frame file, the sound into SmartXbar's CarLife input.
 *
 * The Emby service (native/aurelm-emby) fetches the stream (the server transcodes what the profile does not take to
 * H.264 up to 1080p with AAC or AC-3, in MPEG-TS) and writes it to our stdin; a seek or another film is a new
 * player. Started as root, it creates the frame file (owned by nobody, which mgu-render takes) and then becomes
 * MGU_RUN_AS with the groups in MGU_GROUPS (video: the GPU's render node; mgu_alsa: the sound devices) before it
 * reads a byte of the stream; it refuses to run as root.
 *
 *   demux (main thread)  libavformat's mpegts demuxer on stdin -> a video and an audio queue (bounded: the
 *                        stream waits in the pipe, and so in the server's socket, when we are ahead)
 *   video thread         Moonride's MSDK decoder (decoder_msdk.cpp, our copy: display order, fit whole), each
 *                        picture into the frame file when the clock reaches it; late ones are decoded without
 *                        a picture (no VPP, no copy)
 *   audio thread         libavcodec (aac, ac3, eac3) -> stereo S16 at the volume -> ALSA, kept on the clock
 *                        (late sound dropped, early sound waited for); the device NONBLOCKING, as the
 *                        AirPlay receiver's: an input nobody reads (the speakers not connected) never parks it
 *   the clock            the monotonic clock from the first picture's timestamp; stopped while paused or while
 *                        the stream runs dry (buffering, until 1 s is queued again)
 *
 * Control (fd 3, one per line): pause | resume | volume <0..1> | quit
 * Events (stdout, one per line): MGU {json}: open, decoder, audio, tick (each 500 ms), end, error
 *
 * MGU_VIDEO_PATH  the frame file (default /dev/shm/mgu-video-aurelm-emby)
 * MGU_VIDEO_SIZE  WxH, the output (default 1920x720, the centre screen)
 * MGU_VIDEO_OFF   set: no decoder (a PC: pictures are only timed and counted)
 * MGU_AUDIO       alsa:<device> (default alsa:plug:smartx:CarLifeMedia_CF_48_STEREO) | null | wav:<path> (tests)
 * MGU_ALSA_US     the ALSA buffer in us (default 64000)
 */
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <math.h>
#include <pwd.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
}

#include "decoder_msdk.h"
#include "mgvf.h"
#include "mfx/mfxvideo.h"

/* decoder_msdk.cpp asks this for HEVC only; the profile asks the server for H.264 */
int hevc_plugin(mfxSession s, void *plugin) { (void) s; (void) plugin; return -1; }

namespace {

/* ---------- events ---------- */
std::mutex g_out_mu;
void event(const char *fmt, ...) {
    char buf[2048];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    std::lock_guard<std::mutex> l(g_out_mu);
    fprintf(stdout, "MGU %s\n", buf);
    fflush(stdout);
}
/* s as a JSON string's body */
std::string js(const std::string &s) {
    std::string o;
    for (char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += c; }
        else if ((unsigned char) c < 0x20) o += ' ';
        else o += c;
    }
    return o;
}

double mono() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}
void sleep_s(double s) {
    if (s <= 0) return;
    struct timespec ts;
    ts.tv_sec = (time_t) s;
    ts.tv_nsec = (long) ((s - ts.tv_sec) * 1e9);
    nanosleep(&ts, nullptr);
}

std::atomic<bool> g_quit(false);

/* ---------- the clock ---------- */
class Clock {
public:
    /* media seconds now; before the start, the start value */
    double now() {
        std::lock_guard<std::mutex> l(mu_);
        return running_locked() ? base_ + (mono() - t0_) : base_;
    }
    bool started() { std::lock_guard<std::mutex> l(mu_); return started_; }
    bool paused() { std::lock_guard<std::mutex> l(mu_); return paused_; }
    bool stalled() { std::lock_guard<std::mutex> l(mu_); return stalled_; }
    /* the first one wins */
    void start(double media) {
        {
            std::lock_guard<std::mutex> l(mu_);
            if (started_) return;
            started_ = true;
            base_ = media;
            t0_ = mono();
        }
        cv_.notify_all();
    }
    void set_paused(bool p) { set(&paused_, p); }
    void set_stalled(bool s) { set(&stalled_, s); }
    /* waits until started, at most `s` seconds; true when started */
    bool wait_start(double s) {
        std::unique_lock<std::mutex> l(mu_);
        cv_.wait_for(l, std::chrono::milliseconds((int) (s * 1000)), [&] { return started_ || g_quit.load(); });
        return started_;
    }

private:
    bool running_locked() const { return started_ && !paused_ && !stalled_; }
    void set(bool *flag, bool v) {
        std::lock_guard<std::mutex> l(mu_);
        if (*flag == v) return;
        const bool was = running_locked();
        if (was) base_ += mono() - t0_;   /* freeze where it is */
        *flag = v;
        if (running_locked()) t0_ = mono();
    }
    std::mutex mu_;
    std::condition_variable cv_;
    bool started_ = false, paused_ = false, stalled_ = false;
    double base_ = 0, t0_ = 0;
};
Clock g_clock;

/* ---------- the queues ---------- */
struct Packet {
    std::vector<uint8_t> data;
    double pts = NAN;   /* media seconds, NAN unknown */
    double dur = 0;
};
class Queue {
public:
    void push(Packet &&p) {
        {
            std::lock_guard<std::mutex> l(mu_);
            bytes_ += p.data.size();
            if (!isnan(p.pts)) { if (isnan(first_)) first_ = p.pts; last_ = p.pts; }
            q_.push_back(std::move(p));
        }
        cv_.notify_all();
    }
    /* false: the stream ended and the queue is empty (or quit) */
    bool pop(Packet *out, double wait_s) {
        std::unique_lock<std::mutex> l(mu_);
        cv_.wait_for(l, std::chrono::milliseconds((int) (wait_s * 1000)), [&] { return !q_.empty() || eof_ || g_quit.load(); });
        if (q_.empty()) { empty_ = true; return false; }
        *out = std::move(q_.front());
        q_.pop_front();
        bytes_ -= out->data.size();
        first_ = NAN;
        for (auto &p : q_) if (!isnan(p.pts)) { first_ = p.pts; break; }
        if (q_.empty()) last_ = NAN;
        return true;
    }
    void end() { { std::lock_guard<std::mutex> l(mu_); eof_ = true; } cv_.notify_all(); }
    void wake() { cv_.notify_all(); }
    bool eof() { std::lock_guard<std::mutex> l(mu_); return eof_; }
    bool drained() { std::lock_guard<std::mutex> l(mu_); return eof_ && q_.empty(); }
    size_t bytes() { std::lock_guard<std::mutex> l(mu_); return bytes_; }
    size_t count() { std::lock_guard<std::mutex> l(mu_); return q_.size(); }
    /* seconds between the first and the last timestamp queued */
    double span() { std::lock_guard<std::mutex> l(mu_); return isnan(first_) || isnan(last_) ? 0 : last_ - first_; }

private:
    std::mutex mu_;
    std::condition_variable cv_;
    std::deque<Packet> q_;
    size_t bytes_ = 0;
    double first_ = NAN, last_ = NAN;
    bool eof_ = false, empty_ = false;
};
Queue g_vq, g_aq;
bool g_has_video = false, g_has_audio = false;

const double kAhead = 6.0;              /* seconds queued before the demuxer waits */
const size_t kMaxBytes = 40u << 20;     /* or this many bytes */
const double kRefill = 1.0;             /* buffering ends with this much queued */
const double kLate = 0.12;              /* a picture later than this is not shown */

/* a queue ran dry while the stream goes on: the clock stops until it refills */
void starved() {
    if (g_clock.started() && !g_clock.paused() && !g_vq.eof() && !g_clock.stalled()) g_clock.set_stalled(true);
}

/* ---------- stats ---------- */
std::atomic<unsigned long long> s_shown(0), s_late(0), s_decerr(0), s_vpk(0), s_apk(0), s_aplayed(0), s_alate(0),
    s_aunread(0), s_axrun(0), s_aerr(0), s_bytes(0);
std::atomic<int> s_adev_ms(-1);
double g_first_pts = NAN;   /* the stream's first timestamp: positions are counted from it */
std::mutex g_first_mu;
void note_first(double pts) {
    std::lock_guard<std::mutex> l(g_first_mu);
    if (isnan(g_first_pts) || pts < g_first_pts) g_first_pts = pts;
}
double first_pts() { std::lock_guard<std::mutex> l(g_first_mu); return isnan(g_first_pts) ? 0 : g_first_pts; }

/* ---------- video ---------- */
bool g_video_off = false;
ytdec::Mgvf g_mgvf;
std::string g_video_path = "/dev/shm/mgu-video-aurelm-emby";
uint32_t g_vw = 1920, g_vh = 720;
const double kPtsOffset = 20.0;   /* timestamps given to MSDK: never negative (B frames before the first I) */

/* waits until the clock reaches pts; false: quit */
bool wait_until(double pts) {
    for (;;) {
        if (g_quit) return false;
        const double d = pts - g_clock.now();
        if (d <= 0.002) return true;
        sleep_s(d > 0.02 ? 0.02 : d);
    }
}

void video_thread() {
    woc::Decoder dec;
    bool open = false;
    if (!g_video_off) {
        std::string err;
        open = dec.init("/dev/dri/renderD128", g_vw, g_vh, false, &err);
        if (open) event("{\"ev\":\"decoder\",\"ok\":true,\"path\":\"%s\",\"w\":%u,\"h\":%u}", js(g_video_path).c_str(), g_vw, g_vh);
        else event("{\"ev\":\"decoder\",\"ok\":false,\"error\":\"%s\"}", js(err).c_str());
    } else event("{\"ev\":\"decoder\",\"ok\":false,\"error\":\"off (MGU_VIDEO_OFF)\"}");
    bool lastLate = false;
    unsigned long long errors = 0;
    auto show = [&](double pts, const woc::VideoFrame *f) {
        if (!g_clock.started()) g_clock.start(pts);
        if (!f || !f->y) {   /* decoded without a picture (it was late) */
            if (f) { s_late++; lastLate = true; }
            else if (wait_until(pts)) s_shown++;   /* no decoder: timed and counted */
            return;
        }
        if (!wait_until(pts - 0.004)) return;
        const double late = g_clock.now() - pts;
        if (late > kLate) { s_late++; lastLate = true; return; }
        lastLate = false;
        ytdec::nv12_to_i420(f->y, f->uv, f->pitch, f->w, f->h, g_mgvf.begin());
        g_mgvf.commit();
        s_shown++;
    };
    Packet p;
    for (;;) {
        if (g_quit) break;
        if (!g_vq.pop(&p, 0.25)) {
            if (g_vq.drained() || g_quit) break;
            starved();
            continue;
        }
        const double pts = isnan(p.pts) ? NAN : p.pts;
        if (!open) {
            if (!isnan(pts)) show(pts, nullptr);
            continue;
        }
        /* a picture already late is decoded (the next ones refer to it) without VPP and its copy */
        const bool picture = !(g_clock.started() && !isnan(pts) && (lastLate || g_clock.now() - pts > kLate));
        std::string err;
        const int64_t ms = isnan(pts) ? -1 : (int64_t) ((pts - first_pts() + kPtsOffset) * 1000.0);
        const bool ok = dec.feed(p.data.data(), p.data.size(), [&](const woc::VideoFrame &f) {
            const double fp = f.pts_ms < 0 ? g_clock.now() : f.pts_ms / 1000.0 - kPtsOffset + first_pts();
            show(fp, &f);
        }, &err, true, picture, ms);
        if (!ok) {
            s_decerr++;
            if (++errors <= 3 || errors % 100 == 0) fprintf(stderr, "emby-player: video: %s\n", err.c_str());
        }
        if (picture == false) lastLate = false;   /* try a picture again with the next one */
    }
    if (open) {
        if (!g_quit) dec.flush([&](const woc::VideoFrame &f) {
            const double fp = f.pts_ms < 0 ? g_clock.now() : f.pts_ms / 1000.0 - kPtsOffset + first_pts();
            show(fp, &f);
        });
        dec.shutdown();
    }
}

/* ---------- audio ---------- */
typedef struct snd_pcm snd_pcm_t;
struct Alsa {
    int (*open)(snd_pcm_t **, const char *, int, int);
    int (*set_params)(snd_pcm_t *, int, int, unsigned, unsigned, int, unsigned);
    long (*writei)(snd_pcm_t *, const void *, unsigned long);
    int (*recover)(snd_pcm_t *, int, int);
    int (*delay)(snd_pcm_t *, long *);
    int (*drop)(snd_pcm_t *);
    int (*prepare)(snd_pcm_t *);
    int (*close)(snd_pcm_t *);
    const char *(*strerror)(int);
} A;
const int kPlayback = 0, kS16LE = 2, kRwInterleaved = 3, kNonblock = 1;
std::atomic<int> g_volume_milli(1000);

enum Out { NUL, WAV, ALSA };
struct AudioOut {
    Out kind = NUL;
    std::string target, err;
    snd_pcm_t *pcm = nullptr;
    FILE *wav = nullptr;
    uint32_t wav_bytes = 0;
    unsigned rate = 0;
    bool dropped = false;   /* paused: the device's buffer thrown away, prepared again on resume */

    unsigned buffer_us() { const char *e = getenv("MGU_ALSA_US"); return e && atoi(e) > 0 ? (unsigned) atoi(e) : 64000; }
    void wav_header(uint32_t data) {
        const uint32_t br = rate * 4, riff = 36 + data, fmt = 16;
        const uint16_t pcm_ = 1, ch = 2, ba = 4, bits = 16;
        fseek(wav, 0, SEEK_SET);
        fwrite("RIFF", 1, 4, wav); fwrite(&riff, 4, 1, wav); fwrite("WAVEfmt ", 1, 8, wav);
        fwrite(&fmt, 4, 1, wav); fwrite(&pcm_, 2, 1, wav); fwrite(&ch, 2, 1, wav); fwrite(&rate, 4, 1, wav);
        fwrite(&br, 4, 1, wav); fwrite(&ba, 2, 1, wav); fwrite(&bits, 2, 1, wav); fwrite("data", 1, 4, wav);
        fwrite(&data, 4, 1, wav);
        fseek(wav, 0, SEEK_END);
    }
    bool open(unsigned r) {
        rate = r;
        const char *e = getenv("MGU_AUDIO");
        std::string s = e && *e ? e : "alsa:plug:smartx:CarLifeMedia_CF_48_STEREO";
        if (s == "null") { kind = NUL; target = "null"; return true; }
        if (s.compare(0, 4, "wav:") == 0 && s.size() > 4) {
            kind = WAV; target = s.substr(4);
            wav = fopen(target.c_str(), "wb");
            if (!wav) { err = "cannot create " + target; return false; }
            wav_header(0);
            return true;
        }
        if (s.compare(0, 5, "alsa:") != 0 || s.size() <= 5) { err = "MGU_AUDIO not understood: " + s; return false; }
        kind = ALSA; target = s.substr(5);
        void *h = dlopen("libasound.so.2", RTLD_NOW);
        if (!h) { err = std::string("dlopen libasound.so.2: ") + dlerror(); return false; }
#define SYM(f, n) (*(void **) &A.f = dlsym(h, n))
        if (!(SYM(open, "snd_pcm_open") && SYM(set_params, "snd_pcm_set_params") && SYM(writei, "snd_pcm_writei") &&
              SYM(recover, "snd_pcm_recover") && SYM(delay, "snd_pcm_delay") && SYM(drop, "snd_pcm_drop") &&
              SYM(prepare, "snd_pcm_prepare") && SYM(close, "snd_pcm_close") && SYM(strerror, "snd_strerror"))) {
            err = "libasound.so.2 lacks a symbol";
            return false;
        }
#undef SYM
        int rc = A.open(&pcm, target.c_str(), kPlayback, kNonblock);
        if (rc < 0) { err = "snd_pcm_open " + target + ": " + A.strerror(rc); pcm = nullptr; return false; }
        rc = A.set_params(pcm, kS16LE, kRwInterleaved, 2, rate, 1, buffer_us());
        if (rc < 0) { err = std::string("snd_pcm_set_params: ") + A.strerror(rc); A.close(pcm); pcm = nullptr; return false; }
        return true;
    }
    /* seconds of sound the device holds */
    double delay() {
        if (kind != ALSA || !pcm) return 0;
        long d = 0;
        if (A.delay(pcm, &d) != 0 || d < 0) return 0;
        s_adev_ms = (int) (d * 1000.0 / rate);
        return (double) d / rate;
    }
    void pause() {
        if (kind == ALSA && pcm && !dropped) { A.drop(pcm); dropped = true; }
    }
    /* writes n frames; false: the device does not take them (nobody reads it) */
    bool write(const int16_t *s, unsigned long n) {
        if (kind == WAV && wav) { fwrite(s, 4, n, wav); wav_bytes += (uint32_t) (4 * n); return true; }
        if (kind != ALSA || !pcm) return true;
        if (dropped) { A.prepare(pcm); dropped = false; }
        double waited = 0;
        while (n > 0 && !g_quit) {
            long w = A.writei(pcm, s, n);
            if (w == -EAGAIN) {
                if (waited > 0.25) return false;   /* not read: the speakers not connected (yet) */
                sleep_s(0.005); waited += 0.005;
                continue;
            }
            if (w < 0) { s_axrun++; if (A.recover(pcm, (int) w, 1) < 0) return false; continue; }
            s += w * 2; n -= (unsigned long) w;
        }
        return true;
    }
    void close() {
        if (pcm) { A.close(pcm); pcm = nullptr; }
        if (wav) { wav_header(wav_bytes); fclose(wav); wav = nullptr; }
    }
};

/* the downmix weights of one input channel into left and right */
void weights(AVChannel c, float *l, float *r) {
    const float k = 0.7071f;
    switch (c) {
    case AV_CHAN_FRONT_LEFT: case AV_CHAN_FRONT_LEFT_OF_CENTER: case AV_CHAN_WIDE_LEFT: *l = 1; *r = 0; break;
    case AV_CHAN_FRONT_RIGHT: case AV_CHAN_FRONT_RIGHT_OF_CENTER: case AV_CHAN_WIDE_RIGHT: *l = 0; *r = 1; break;
    case AV_CHAN_FRONT_CENTER: *l = *r = k; break;
    case AV_CHAN_LOW_FREQUENCY: case AV_CHAN_LOW_FREQUENCY_2: *l = *r = 0; break;
    case AV_CHAN_BACK_LEFT: case AV_CHAN_SIDE_LEFT: *l = k; *r = 0; break;
    case AV_CHAN_BACK_RIGHT: case AV_CHAN_SIDE_RIGHT: *l = 0; *r = k; break;
    default: *l = *r = 0.5f; break;
    }
}

/* a decoded frame -> stereo S16 at the volume; more than two channels are mixed down */
void to_stereo(const AVFrame *f, std::vector<int16_t> *out) {
    const int n = f->nb_samples, ch = f->ch_layout.nb_channels > 0 ? f->ch_layout.nb_channels : 2;
    std::vector<float> wl(ch), wr(ch);
    if (ch == 1) { wl[0] = wr[0] = 1; }
    else if (ch == 2) { wl[0] = 1; wr[0] = 0; wl[1] = 0; wr[1] = 1; }
    else {
        float sl = 0;
        for (int c = 0; c < ch; c++) {
            weights(av_channel_layout_channel_from_index(&f->ch_layout, (unsigned) c), &wl[c], &wr[c]);
            sl += wl[c];
        }
        const float norm = sl > 1 ? 1.0f / sqrtf(sl) : 1.0f;   /* louder than a plain sum's normalisation, clipped */
        for (int c = 0; c < ch; c++) { wl[c] *= norm; wr[c] *= norm; }
    }
    const float v = g_volume_milli.load() / 1000.0f;
    out->resize((size_t) n * 2);
    for (int i = 0; i < n; i++) {
        float L = 0, R = 0;
        for (int c = 0; c < ch; c++) {
            float x;
            switch (f->format) {
            case AV_SAMPLE_FMT_FLTP: x = ((const float *) f->extended_data[c])[i]; break;
            case AV_SAMPLE_FMT_FLT: x = ((const float *) f->extended_data[0])[i * ch + c]; break;
            case AV_SAMPLE_FMT_S16P: x = ((const int16_t *) f->extended_data[c])[i] / 32768.0f; break;
            case AV_SAMPLE_FMT_S16: x = ((const int16_t *) f->extended_data[0])[i * ch + c] / 32768.0f; break;
            case AV_SAMPLE_FMT_S32P: x = ((const int32_t *) f->extended_data[c])[i] / 2147483648.0f; break;
            case AV_SAMPLE_FMT_S32: x = ((const int32_t *) f->extended_data[0])[i * ch + c] / 2147483648.0f; break;
            default: x = 0; break;
            }
            L += x * wl[c]; R += x * wr[c];
        }
        L *= v; R *= v;
        (*out)[(size_t) i * 2] = L >= 1 ? 32767 : L <= -1 ? -32768 : (int16_t) lrintf(L * 32767.0f);
        (*out)[(size_t) i * 2 + 1] = R >= 1 ? 32767 : R <= -1 ? -32768 : (int16_t) lrintf(R * 32767.0f);
    }
}

AVCodecParameters *g_apar = nullptr;
AVRational g_atb = {1, 90000};

void audio_thread() {
    const AVCodec *codec = avcodec_find_decoder(g_apar->codec_id);
    AVCodecContext *ctx = codec ? avcodec_alloc_context3(codec) : nullptr;
    if (!ctx || avcodec_parameters_to_context(ctx, g_apar) < 0 || avcodec_open2(ctx, codec, nullptr) < 0) {
        event("{\"ev\":\"audio\",\"ok\":false,\"error\":\"no decoder for %s\"}", avcodec_get_name(g_apar->codec_id));
        if (ctx) avcodec_free_context(&ctx);
        /* the queue is still emptied, so the demuxer never waits for us */
        Packet p;
        while (g_aq.pop(&p, 0.25) || !g_aq.drained()) if (g_quit) break;
        return;
    }
    ctx->pkt_timebase = g_atb;
    AVPacket *pkt = av_packet_alloc();
    AVFrame *fr = av_frame_alloc();
    AudioOut out;
    bool opened = false, failed = false;
    std::vector<int16_t> buf;
    double next = NAN;   /* the timestamp after the last frame: frames without one follow it */
    Packet p;
    for (;;) {
        if (g_quit) break;
        if (!g_aq.pop(&p, 0.25)) {
            if (g_aq.drained() || g_quit) break;
            if (!g_has_video) starved();
            continue;
        }
        if (av_new_packet(pkt, (int) p.data.size()) < 0) { s_aerr++; continue; }
        memcpy(pkt->data, p.data.data(), p.data.size());
        pkt->pts = isnan(p.pts) ? AV_NOPTS_VALUE : (int64_t) llround(p.pts / av_q2d(g_atb));
        int rc = avcodec_send_packet(ctx, pkt);
        av_packet_unref(pkt);
        if (rc < 0) { s_aerr++; continue; }
        while (avcodec_receive_frame(ctx, fr) == 0) {
            const unsigned rate = fr->sample_rate > 0 ? (unsigned) fr->sample_rate : 48000;
            double pts = fr->pts != AV_NOPTS_VALUE ? fr->pts * av_q2d(g_atb) : next;
            if (isnan(pts)) pts = g_clock.now();
            const double dur = (double) fr->nb_samples / rate;
            next = pts + dur;
            if (!opened && !failed) {
                if (out.open(rate)) {
                    opened = true;
                    event("{\"ev\":\"audio\",\"ok\":true,\"device\":\"%s\",\"codec\":\"%s\",\"rate\":%u,\"channels\":%d}",
                          js(out.target).c_str(), avcodec_get_name(g_apar->codec_id), rate, fr->ch_layout.nb_channels);
                } else {
                    failed = true;
                    event("{\"ev\":\"audio\",\"ok\":false,\"error\":\"%s\"}", js(out.err).c_str());
                }
            }
            /* with a picture, the picture starts the clock; without one (or none for 3 s), the sound does */
            if (!g_clock.started() && !(g_has_video && g_clock.wait_start(3.0))) g_clock.start(pts);
            while (g_clock.paused() && !g_quit) { out.pause(); sleep_s(0.02); }
            to_stereo(fr, &buf);
            av_frame_unref(fr);
            if (!opened) continue;
            size_t skip = 0, n = buf.size() / 2;
            /* where the device is: what it holds plays first */
            double ahead = pts - (g_clock.now() + out.delay());
            if (ahead + dur < -0.05) { s_alate++; continue; }      /* all of it late */
            if (ahead < -0.04) {                                     /* its start late: cut */
                skip = (size_t) (-ahead * rate);
                if (skip >= n) { s_alate++; continue; }
            }
            /* early: wait (also while paused or buffering, the clock stands) */
            while (!g_quit && (ahead = pts - (g_clock.now() + out.delay())) > 0.04) {
                if (g_clock.paused()) out.pause();
                sleep_s(ahead > 0.06 ? 0.02 : ahead - 0.02);
            }
            if (out.write(buf.data() + skip * 2, n - skip)) s_aplayed++;
            else s_aunread++;
        }
    }
    out.close();
    av_frame_free(&fr);
    av_packet_free(&pkt);
    avcodec_free_context(&ctx);
}

/* ---------- control ---------- */
void control_thread() {
    /* read(2), not stdio: a FILE locked in fgets would hold exit()'s flush of every stream */
    std::string buf;
    char chunk[256];
    for (;;) {
        const ssize_t n = read(3, chunk, sizeof chunk);
        if (n < 0 && errno == EINTR) { if (g_quit) break; continue; }
        if (n <= 0) break;
        buf.append(chunk, (size_t) n);
        size_t i;
        while ((i = buf.find('\n')) != std::string::npos) {
            const std::string line = buf.substr(0, i);
            buf.erase(0, i + 1);
            if (line == "pause") g_clock.set_paused(true);
            else if (line == "resume") g_clock.set_paused(false);
            else if (!line.compare(0, 7, "volume ")) {
                const double v = atof(line.c_str() + 7);
                g_volume_milli = (int) ((v < 0 ? 0 : v > 1 ? 1 : v) * 1000);
            } else if (line == "quit") { g_quit = true; g_vq.wake(); g_aq.wake(); return; }
        }
        if (buf.size() > 4096) buf.clear();
    }
    /* the service went (its end of the pipe closed): so do we */
    g_quit = true;
    g_vq.wake(); g_aq.wake();
}

/* ---------- the stream ---------- */
int read_stdin(void *opaque, uint8_t *buf, int size) {
    (void) opaque;
    for (;;) {
        if (g_quit) return AVERROR_EOF;
        const ssize_t n = read(0, buf, (size_t) size);
        if (n > 0) { s_bytes += (unsigned long long) n; return (int) n; }
        if (n == 0) return AVERROR_EOF;
        if (errno == EINTR) continue;
        return AVERROR(errno);
    }
}

/* waits while enough is queued; false: quit */
bool room() {
    for (;;) {
        if (g_quit) return false;
        const double span = std::max(g_vq.span(), g_aq.span());
        if (span < kAhead && g_vq.bytes() + g_aq.bytes() < kMaxBytes) return true;
        if (g_clock.stalled()) g_clock.set_stalled(false);   /* full: whatever ran dry is back */
        sleep_s(0.01);
    }
}

void refill_check() {
    if (!g_clock.stalled()) return;
    const double span = g_has_video ? g_vq.span() : g_aq.span();
    if (span >= kRefill || g_vq.eof()) g_clock.set_stalled(false);
}

const char *state() {
    if (!g_clock.started()) return "starting";
    if (g_clock.paused()) return "paused";
    if (g_clock.stalled()) return "buffering";
    return "playing";
}

void tick_thread() {
    while (!g_quit) {
        for (int i = 0; i < 10 && !g_quit; i++) sleep_s(0.05);
        if (g_quit) break;
        const double t = g_clock.started() ? g_clock.now() - first_pts() : 0;
        event("{\"ev\":\"tick\",\"t\":%.3f,\"state\":\"%s\",\"shown\":%llu,\"late\":%llu,\"decerr\":%llu,\"aplayed\":%llu,"
              "\"alate\":%llu,\"aunread\":%llu,\"axrun\":%llu,\"adev\":%d,\"buffered\":%.2f,\"kbytes\":%llu}",
              t < 0 ? 0 : t, state(), s_shown.load(), s_late.load(), s_decerr.load(), s_aplayed.load(), s_alate.load(),
              s_aunread.load(), s_axrun.load(), s_adev_ms.load(), std::max(g_vq.span(), g_aq.span()), s_bytes.load() / 1024);
    }
}

/* As root: becomes MGU_RUN_AS (a name or a number) with MGU_GROUPS; exits rather than stay root */
void drop_root() {
    const char *who = getenv("MGU_RUN_AS");
    if (!who || getuid() != 0) return;
    uid_t uid;
    gid_t gid;
    char *end = nullptr;
    const unsigned long num = strtoul(who, &end, 10);
    if (*who && end && !*end) { uid = (uid_t) num; gid = (gid_t) num; }
    else {
        struct passwd *pw = getpwnam(who);
        if (!pw) { fprintf(stderr, "emby-player: no user %s: refusing to run as root\n", who); _exit(126); }
        uid = pw->pw_uid; gid = pw->pw_gid;
    }
    gid_t gs[16];
    int n = 0;
    char list[256];
    snprintf(list, sizeof list, "%s", getenv("MGU_GROUPS") ? getenv("MGU_GROUPS") : "");
    for (char *save = nullptr, *t = strtok_r(list, ",", &save); t && n < 16; t = strtok_r(nullptr, ",", &save)) {
        struct group *g = getgrnam(t);
        if (g) gs[n++] = g->gr_gid;
    }
    if (setgroups((size_t) n, gs) != 0 || setgid(gid) != 0 || setuid(uid) != 0 || getuid() == 0 || geteuid() == 0) {
        fprintf(stderr, "emby-player: cannot run as %s: refusing to run as root\n", who);
        _exit(126);
    }
    fprintf(stderr, "emby-player: running as uid %u with %d groups\n", (unsigned) uid, n);
}

void on_term(int) { g_quit = true; }

}  // namespace

int main() {
    signal(SIGPIPE, SIG_IGN);
    /* no SA_RESTART: a read of the stream waiting for data returns, and the player ends */
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_term;
    sigaction(SIGTERM, &sa, nullptr);
    sigaction(SIGINT, &sa, nullptr);
    /* the frame file, while root: owned by nobody, which mgu-render takes */
    g_video_off = getenv("MGU_VIDEO_OFF") != nullptr;
    if (const char *p = getenv("MGU_VIDEO_PATH")) if (*p) g_video_path = p;
    if (const char *sz = getenv("MGU_VIDEO_SIZE")) {
        unsigned w = 0, h = 0;
        if (sscanf(sz, "%ux%u", &w, &h) == 2 && w >= 16 && h >= 16 && w <= 2048 && h <= 2048) g_vw = w & ~1u, g_vh = h & ~1u;
    }
    std::string ferr;
    if (!g_video_off) {
        std::string warn;
        if (!g_mgvf.open(g_video_path.c_str(), g_vw, g_vh, 3, &ferr, &warn)) g_video_off = true;
        else if (!warn.empty()) fprintf(stderr, "emby-player: %s\n", warn.c_str());
    }
    drop_root();
    if (!ferr.empty()) event("{\"ev\":\"decoder\",\"ok\":false,\"error\":\"frame file: %s\"}", js(ferr).c_str());
    std::thread ctl;
    if (fcntl(3, F_GETFD) != -1) ctl = std::thread(control_thread);
    else ctl = std::thread([] {});

    av_log_set_level(AV_LOG_ERROR);
    AVFormatContext *fmt = avformat_alloc_context();
    const int iosz = 64 * 1024;
    AVIOContext *io = avio_alloc_context((unsigned char *) av_malloc(iosz), iosz, 0, nullptr, read_stdin, nullptr, nullptr);
    fmt->pb = io;
    /* small: the picture starts sooner (the server's stream is a known kind) */
    fmt->probesize = 256 * 1024;
    fmt->max_analyze_duration = AV_TIME_BASE / 2;
    const AVInputFormat *ts = av_find_input_format("mpegts");
    int rc = avformat_open_input(&fmt, nullptr, ts, nullptr);
    if (rc < 0 || avformat_find_stream_info(fmt, nullptr) < 0) {
        char e[128];
        av_strerror(rc, e, sizeof e);
        event("{\"ev\":\"error\",\"error\":\"the stream does not open: %s\"}", js(rc < 0 ? e : "no stream information").c_str());
        g_quit = true;
        ctl.detach();
        g_mgvf.close();
        return 2;
    }
    const int vi = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    const int ai = av_find_best_stream(fmt, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
    AVStream *vs = vi >= 0 ? fmt->streams[vi] : nullptr, *as = ai >= 0 ? fmt->streams[ai] : nullptr;
    if (vs && vs->codecpar->codec_id != AV_CODEC_ID_H264) {
        event("{\"ev\":\"error\",\"error\":\"video %s: only H.264 plays here (the server should have transcoded it)\"}", avcodec_get_name(vs->codecpar->codec_id));
        vs = nullptr;
    }
    g_has_video = vs != nullptr;
    g_has_audio = as != nullptr;
    if (as) { g_apar = as->codecpar; g_atb = as->time_base; }
    event("{\"ev\":\"open\",\"video\":%s%s%s,\"audio\":%s%s%s}",
          vs ? "{\"codec\":\"h264\",\"w\":" : "null", vs ? std::to_string(vs->codecpar->width).c_str() : "",
          vs ? (",\"h\":" + std::to_string(vs->codecpar->height) + "}").c_str() : "",
          as ? "{\"codec\":\"" : "null", as ? avcodec_get_name(as->codecpar->codec_id) : "",
          as ? ("\",\"rate\":" + std::to_string(as->codecpar->sample_rate) + ",\"channels\":" + std::to_string(as->codecpar->ch_layout.nb_channels) + "}").c_str() : "");
    if (!g_has_video && !g_has_audio) {
        event("{\"ev\":\"error\",\"error\":\"no picture or sound in the stream\"}");
        g_quit = true;
    }
    std::thread vt, at, tt(tick_thread);
    if (g_has_video) vt = std::thread(video_thread); else g_vq.end();
    if (g_has_audio) at = std::thread(audio_thread); else g_aq.end();

    AVPacket *pkt = av_packet_alloc();
    while (!g_quit) {
        if (!room()) break;
        rc = av_read_frame(fmt, pkt);
        if (rc < 0) break;
        AVStream *s = fmt->streams[pkt->stream_index];
        if ((s == vs || s == as) && pkt->size > 0) {
            Packet p;
            p.data.assign(pkt->data, pkt->data + pkt->size);
            if (pkt->pts != AV_NOPTS_VALUE) p.pts = pkt->pts * av_q2d(s->time_base);
            else if (pkt->dts != AV_NOPTS_VALUE) p.pts = pkt->dts * av_q2d(s->time_base);
            p.dur = pkt->duration * av_q2d(s->time_base);
            if (!isnan(p.pts) && (s == vs || !g_has_video)) note_first(p.pts);
            if (s == vs) { s_vpk++; g_vq.push(std::move(p)); }
            else { s_apk++; g_aq.push(std::move(p)); }
            refill_check();
        }
        av_packet_unref(pkt);
    }
    av_packet_free(&pkt);
    g_vq.end(); g_aq.end();
    if (g_clock.stalled()) g_clock.set_stalled(false);
    if (vt.joinable()) vt.join();
    if (at.joinable()) at.join();
    const bool ended = !g_quit;
    const double t = g_clock.started() ? g_clock.now() - first_pts() : 0;
    if (ended) event("{\"ev\":\"end\",\"t\":%.3f,\"shown\":%llu,\"late\":%llu,\"aplayed\":%llu}", t < 0 ? 0 : t, s_shown.load(), s_late.load(), s_aplayed.load());
    g_quit = true;
    tt.join();
    ctl.detach();   /* blocked in a read of fd 3: the exit ends it */
    avformat_close_input(&fmt);
    if (io) { av_freep(&io->buffer); avio_context_free(&io); }
    g_mgvf.close();
    return 0;
}
