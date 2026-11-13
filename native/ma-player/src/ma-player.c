/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ma-player - the sound of the Music Assistant service (native/aurelm-music) on the iDrive 7 head unit (MGU).
 *
 * The service's Sendspin client receives the music from Music Assistant (Opus packets, or PCM) and hands it over on
 * stdin, framed; this program decodes it and writes it to ALSA, into SmartXbar's CarLife input (source 287), which
 * the app routes to the main speakers (car_audio.js), as Emby's and TVH Player's players do.
 *
 * Frames on stdin: u8 type, u32 big-endian length, the payload:
 *   'F' format   "<codec> <rate> <channels> <bits>"   codec opus | pcm (s16le); a new format closes and reopens
 *   'A' audio    one Opus packet, or PCM bytes
 *   'V' volume   "<0..1>" (text)
 *   'C' clear    drop what ALSA still holds (a seek, a new track chosen, a pause)
 *   'Q' quit
 * Events on stdout, one line each: MGU {"ev":"open"|"error"|"tick"|"end", ...}
 *
 * Runs as: started as root by the service, it becomes MGU_RUN_AS (nobody) with the groups in MGU_GROUPS (mgu_alsa:
 * the sound devices; the smartx plugin refuses root and the tools' uids, Emby 0.2.1) before it reads a byte, and
 * refuses to go on as root. libasound is opened at run time (dlopen), so the binary links only the C library.
 *
 *   MGU_AUDIO   alsa:<device> (default alsa:plug:smartx:CarLifeMedia_CF_48_STEREO) | wav:<path> (tests) | null
 *   MGU_ALSA_US the ALSA buffer in microseconds (default 120000)
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <grp.h>
#include <poll.h>
#include <pwd.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#include "opus.h"

#define MAX_FRAME (1 << 20)
#define MAX_PCM 5760   /* 120 ms at 48 kHz: the largest Opus frame */

/* ---------------------------------------------------------------- events */
static void event(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void event(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fputs("MGU ", stdout);
    vfprintf(stdout, fmt, ap);
    fputc('\n', stdout);
    fflush(stdout);
    va_end(ap);
}
static long long now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

/* ---------------------------------------------------------------- the output: ALSA, a WAV file, or nothing */
typedef struct snd_pcm snd_pcm_t;
static struct {
    void *lib;
    int (*open)(snd_pcm_t **, const char *, int, int);
    int (*set_params)(snd_pcm_t *, int, int, unsigned, unsigned, int, unsigned);
    long (*writei)(snd_pcm_t *, const void *, unsigned long);
    int (*recover)(snd_pcm_t *, int, int);
    int (*drop)(snd_pcm_t *);
    int (*prepare)(snd_pcm_t *);
    int (*close)(snd_pcm_t *);
    const char *(*strerror)(int);
} A;
enum { OUT_ALSA, OUT_WAV, OUT_NULL };
static int out_kind = OUT_ALSA;
static const char *out_target = "plug:smartx:CarLifeMedia_CF_48_STEREO";
static snd_pcm_t *pcm;
static FILE *wav;
static unsigned long long wav_bytes;
static unsigned cur_rate, cur_ch;
static long long played_frames, underruns, dropped;

static int alsa_load(void) {
    if (A.lib) return 0;
    A.lib = dlopen("libasound.so.2", RTLD_NOW);
    if (!A.lib) { event("{\"ev\":\"error\",\"error\":\"dlopen libasound.so.2: %s\"}", dlerror()); return -1; }
#define SYM(f, n) if (!(*(void **)&A.f = dlsym(A.lib, n))) { event("{\"ev\":\"error\",\"error\":\"libasound has no %s\"}", n); return -1; }
    SYM(open, "snd_pcm_open") SYM(set_params, "snd_pcm_set_params") SYM(writei, "snd_pcm_writei")
    SYM(recover, "snd_pcm_recover") SYM(drop, "snd_pcm_drop") SYM(prepare, "snd_pcm_prepare")
    SYM(close, "snd_pcm_close") SYM(strerror, "snd_strerror")
#undef SYM
    return 0;
}

static void wav_header(FILE *f, unsigned rate, unsigned ch, unsigned long long bytes) {
    unsigned char h[44];
    unsigned data = bytes > 0xffffffd0ULL ? 0xffffffd0U : (unsigned)bytes;
    memcpy(h, "RIFF", 4); unsigned v = 36 + data; memcpy(h + 4, &v, 4); memcpy(h + 8, "WAVEfmt ", 8);
    v = 16; memcpy(h + 16, &v, 4); unsigned short s = 1; memcpy(h + 20, &s, 2); s = (unsigned short)ch; memcpy(h + 22, &s, 2);
    memcpy(h + 24, &rate, 4); v = rate * ch * 2; memcpy(h + 28, &v, 4); s = (unsigned short)(ch * 2); memcpy(h + 32, &s, 2);
    s = 16; memcpy(h + 34, &s, 2); memcpy(h + 36, "data", 4); memcpy(h + 40, &data, 4);
    fseek(f, 0, SEEK_SET); fwrite(h, 1, 44, f); fseek(f, 0, SEEK_END);
}

static void out_close(void) {
    if (pcm) { A.drop(pcm); A.close(pcm); pcm = NULL; }
    if (wav) { wav_header(wav, cur_rate, cur_ch, wav_bytes); fclose(wav); wav = NULL; }
}

static int out_open(unsigned rate, unsigned ch) {
    out_close();
    cur_rate = rate; cur_ch = ch;
    if (out_kind == OUT_NULL) { event("{\"ev\":\"open\",\"out\":\"null\",\"rate\":%u,\"channels\":%u}", rate, ch); return 0; }
    if (out_kind == OUT_WAV) {
        wav = fopen(out_target, "wb");
        if (!wav) { event("{\"ev\":\"error\",\"error\":\"wav %s: %s\"}", out_target, strerror(errno)); return -1; }
        wav_bytes = 0; wav_header(wav, rate, ch, 0);
        event("{\"ev\":\"open\",\"out\":\"wav\",\"rate\":%u,\"channels\":%u}", rate, ch);
        return 0;
    }
    if (alsa_load()) return -1;
    int rc = A.open(&pcm, out_target, 0 /* playback */, 0 /* blocking */);
    if (rc < 0) { event("{\"ev\":\"error\",\"error\":\"snd_pcm_open %s: %s\"}", out_target, A.strerror(rc)); pcm = NULL; return -1; }
    const char *us = getenv("MGU_ALSA_US");
    /* S16_LE = 2, RW_INTERLEAVED = 3, soft resample on (44.1 kHz into the 48 kHz device) */
    rc = A.set_params(pcm, 2, 3, ch, rate, 1, us ? (unsigned)atoi(us) : 120000);
    if (rc < 0) { event("{\"ev\":\"error\",\"error\":\"snd_pcm_set_params: %s\"}", A.strerror(rc)); A.close(pcm); pcm = NULL; return -1; }
    event("{\"ev\":\"open\",\"out\":\"alsa\",\"device\":\"%s\",\"rate\":%u,\"channels\":%u}", out_target, rate, ch);
    return 0;
}

static float volume = 1.0f;

/* frames of interleaved s16 at the current format, the volume applied in place */
static void out_write(int16_t *s, long frames) {
    if (frames <= 0) return;
    if (volume < 0.999f) {
        long n = frames * cur_ch;
        for (long i = 0; i < n; i++) s[i] = (int16_t)(s[i] * volume);
    }
    if (out_kind == OUT_NULL) { played_frames += frames; return; }
    if (out_kind == OUT_WAV) { if (wav) { fwrite(s, 2 * cur_ch, (size_t)frames, wav); wav_bytes += (unsigned long long)frames * 2 * cur_ch; } played_frames += frames; return; }
    if (!pcm) { dropped += frames; return; }
    while (frames > 0) {
        long w = A.writei(pcm, s, (unsigned long)frames);
        if (w == -EAGAIN) continue;
        if (w < 0) {
            if (w == -EPIPE) underruns++;
            if (A.recover(pcm, (int)w, 1) < 0) { event("{\"ev\":\"error\",\"error\":\"snd_pcm_writei: %s\"}", A.strerror((int)w)); dropped += frames; return; }
            continue;
        }
        played_frames += w; frames -= w; s += w * cur_ch;
    }
}

/* ---------------------------------------------------------------- the input */
static int read_full(unsigned char *b, size_t n) {
    size_t got = 0;
    while (got < n) {
        ssize_t r = read(0, b + got, n - got);
        if (r == 0) return 0;
        if (r < 0) { if (errno == EINTR) continue; return -1; }
        got += (size_t)r;
    }
    return 1;
}

static int drop_root(void) {
    const char *who = getenv("MGU_RUN_AS"), *groups = getenv("MGU_GROUPS");
    if (getuid() != 0) return 0;
    if (!who || !*who) { event("{\"ev\":\"error\",\"error\":\"refusing to play as root: MGU_RUN_AS not set\"}"); return -1; }
    struct passwd *pw = getpwnam(who);
    if (!pw) { event("{\"ev\":\"error\",\"error\":\"no user %s\"}", who); return -1; }
    gid_t gl[16]; int n = 0;
    if (groups) {
        char buf[256]; strncpy(buf, groups, sizeof buf - 1); buf[sizeof buf - 1] = 0;
        for (char *save = NULL, *g = strtok_r(buf, ",", &save); g && n < 16; g = strtok_r(NULL, ",", &save)) {
            struct group *gr = getgrnam(g);
            if (gr) gl[n++] = gr->gr_gid;
        }
    }
    if (setgroups((size_t)n, gl) || setgid(pw->pw_gid) || setuid(pw->pw_uid)) { event("{\"ev\":\"error\",\"error\":\"dropping root: %s\"}", strerror(errno)); return -1; }
    if (getuid() == 0 || geteuid() == 0) { event("{\"ev\":\"error\",\"error\":\"still root\"}"); return -1; }
    return 0;
}

int main(void) {
    signal(SIGPIPE, SIG_IGN);
    const char *o = getenv("MGU_AUDIO");
    if (o && !strncmp(o, "wav:", 4)) { out_kind = OUT_WAV; out_target = o + 4; }
    else if (o && !strcmp(o, "null")) out_kind = OUT_NULL;
    else if (o && !strncmp(o, "alsa:", 5)) out_target = o + 5;
    if (drop_root()) return 2;

    static unsigned char buf[MAX_FRAME];
    static int16_t pcmbuf[MAX_PCM * 2];
    OpusDecoder *dec = NULL;
    int codec = 0;   /* 0 none, 1 opus, 2 pcm */
    unsigned ch = 2;
    long long last_tick = now_ms(), packets = 0, bad = 0;
    long long ticked_played = -1;
    for (;;) {
        unsigned char h[5];
        /* a second without input (the end of the music, a pause): the tick still goes out, once */
        struct pollfd pf = { 0, POLLIN, 0 };
        int pr = poll(&pf, 1, 1000);
        if (pr == 0) {
            if (played_frames != ticked_played) {
                ticked_played = played_frames; last_tick = now_ms();
                event("{\"ev\":\"tick\",\"played\":%lld,\"packets\":%lld,\"bad\":%lld,\"underruns\":%lld,\"dropped\":%lld,\"idle\":true}", played_frames, packets, bad, underruns, dropped);
            }
            continue;
        }
        int r = read_full(h, 5);
        if (r <= 0) break;
        unsigned len = ((unsigned)h[1] << 24) | ((unsigned)h[2] << 16) | ((unsigned)h[3] << 8) | h[4];
        if (len > MAX_FRAME) { event("{\"ev\":\"error\",\"error\":\"frame of %u bytes\"}", len); break; }
        if (len && read_full(buf, len) <= 0) break;
        switch (h[0]) {
        case 'F': {
            char c[16] = {0}; unsigned rate = 48000, bits = 16; ch = 2;
            buf[len < MAX_FRAME ? len : MAX_FRAME - 1] = 0;
            if (sscanf((char *)buf, "%15s %u %u %u", c, &rate, &ch, &bits) < 3 || ch < 1 || ch > 2) { event("{\"ev\":\"error\",\"error\":\"bad format\"}"); codec = 0; break; }
            if (dec) { opus_decoder_destroy(dec); dec = NULL; }
            if (!strcmp(c, "opus")) {
                int err = 0;
                dec = opus_decoder_create(48000, (int)ch, &err);
                if (!dec) { event("{\"ev\":\"error\",\"error\":\"opus: %s\"}", opus_strerror(err)); codec = 0; break; }
                codec = 1; rate = 48000;
            } else if (!strcmp(c, "pcm") && bits == 16) codec = 2;
            else { event("{\"ev\":\"error\",\"error\":\"unsupported format %s/%u\"}", c, bits); codec = 0; break; }
            if (out_open(rate, ch)) codec = 0;
            break;
        }
        case 'A':
            if (!codec) { dropped++; break; }
            packets++;
            if (codec == 1) {
                int n = opus_decode(dec, buf, (opus_int32)len, pcmbuf, MAX_PCM, 0);
                if (n < 0) { bad++; break; }
                out_write(pcmbuf, n);
            } else {
                long frames = (long)(len / (2 * ch));
                /* aligned copy: the frame buffer is bytes */
                long done = 0;
                while (done < frames) {
                    long n = frames - done > MAX_PCM ? MAX_PCM : frames - done;
                    memcpy(pcmbuf, buf + done * 2 * ch, (size_t)(n * 2 * ch));
                    out_write(pcmbuf, n);
                    done += n;
                }
            }
            break;
        case 'V': {
            buf[len < MAX_FRAME ? len : MAX_FRAME - 1] = 0;
            float v = (float)atof((char *)buf);
            volume = v < 0 ? 0 : v > 1 ? 1 : v;
            break;
        }
        case 'C':
            if (pcm) { A.drop(pcm); A.prepare(pcm); }
            if (dec) opus_decoder_ctl(dec, OPUS_RESET_STATE);
            break;
        case 'Q':
            goto end;
        default:
            break;
        }
        long long t = now_ms();
        if (t - last_tick >= 1000) {
            last_tick = t; ticked_played = played_frames;
            event("{\"ev\":\"tick\",\"played\":%lld,\"packets\":%lld,\"bad\":%lld,\"underruns\":%lld,\"dropped\":%lld}", played_frames, packets, bad, underruns, dropped);
        }
    }
end:
    out_close();
    if (dec) opus_decoder_destroy(dec);
    event("{\"ev\":\"end\",\"played\":%lld}", played_frames);
    return 0;
}
