/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * mgu_renderer.c - UxPlay's renderer API (renderers/video_renderer.h, audio_renderer.h, mux_renderer.h)
 * for the iDrive 7 head unit, stage 1: no GStreamer, nothing is shown or played. It counts what the
 * iPhone sends and reports it on stdout, one line a second while a stream runs, each line
 * "MGU {json}", read by the service (native/aurelm-airplay-probe, receiver mode):
 *
 *   {"ev":"client","model":"iPhone18,2","name":"..."}           the client that connected
 *   {"ev":"video","codec":"h264","w":..,"h":..,"sw":..,"sh":..} the stream's size (source and shown)
 *   {"ev":"start"} / {"ev":"stop"}                               the video pipeline
 *   {"ev":"audio","ct":..}                                       the audio stream's compression type
 *   {"ev":"stats","frames":..,"fps":..,"kbps":..,"idr":..,"sps":..,"audio":..}
 *
 * Stage 2 hands the H.264 (Annex B, decrypted, SPS+PPS before each IDR) to the GPU decoder instead.
 */
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <pthread.h>
#include <time.h>
#include <glib.h>
#include "../lib/logger.h"
#include "../renderers/video_renderer.h"
#include "../renderers/audio_renderer.h"
#include "../renderers/mux_renderer.h"

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static struct {
    uint64_t frames, bytes, idr, sps, audio_packets, audio_bytes;
    uint64_t win_frames, win_bytes;
    double win_start;
    bool running;
} st;

static double now_s(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

/* one line, flushed (stdout is a pipe to the service) */
static void emit(const char *fmt, ...) G_GNUC_PRINTF(1, 2);
static void emit(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fputs("MGU ", stdout);
    vfprintf(stdout, fmt, ap);
    fputc('\n', stdout);
    fflush(stdout);
    va_end(ap);
}

/* JSON string body: quotes, backslashes and control characters left out */
static void clean(char *out, size_t n, const char *in) {
    size_t j = 0;
    for (size_t i = 0; in && in[i] && j + 1 < n; i++) {
        unsigned char c = (unsigned char) in[i];
        if (c < 0x20 || c == '"' || c == '\\') continue;
        out[j++] = (char) c;
    }
    out[j] = 0;
}

static void stats_locked(double t) {
    double dt = t - st.win_start;
    if (dt < 1.0) return;
    emit("{\"ev\":\"stats\",\"frames\":%llu,\"fps\":%.1f,\"kbps\":%.0f,\"idr\":%llu,\"sps\":%llu,\"audio\":%llu}",
         (unsigned long long) st.frames, st.win_frames / dt, st.win_bytes * 8.0 / 1000.0 / dt,
         (unsigned long long) st.idr, (unsigned long long) st.sps, (unsigned long long) st.audio_packets);
    st.win_frames = st.win_bytes = 0;
    st.win_start = t;
}

/* ---------------- video ---------------- */

bool gstreamer_init() { return true; }
bool gstreamer_decoder_check(const char *decoder) { (void) decoder; return true; }

void video_renderer_init(logger_t *logger, const char *server_name, videoflip_t videoflip[2], const char *parser, const char *rtp_pipeline,
                         const char *decoder, const char *converter, const char *videosink, const char *videosink_options,
                         bool initial_fullscreen, bool video_sync, bool h265_support, bool coverart_support,
                         guint playbin_version, const char *uri) {
    (void) logger; (void) server_name; (void) videoflip; (void) parser; (void) rtp_pipeline; (void) decoder; (void) converter;
    (void) videosink; (void) videosink_options; (void) initial_fullscreen; (void) video_sync; (void) h265_support;
    (void) coverart_support; (void) playbin_version;
    if (uri) emit("{\"ev\":\"hls\"}");
}

void video_renderer_start() {
    pthread_mutex_lock(&mu);
    st.running = true;
    st.win_start = now_s();
    st.win_frames = st.win_bytes = 0;
    pthread_mutex_unlock(&mu);
    emit("{\"ev\":\"start\"}");
}

void video_renderer_stop() {
    pthread_mutex_lock(&mu);
    bool was = st.running;
    st.running = false;
    pthread_mutex_unlock(&mu);
    if (was) emit("{\"ev\":\"stop\",\"frames\":%llu}", (unsigned long long) st.frames);
}

void video_renderer_set_device_model(const char *model, const char *name) {
    char m[64], n[96];
    clean(m, sizeof m, model);
    clean(n, sizeof n, name);
    emit("{\"ev\":\"client\",\"model\":\"%s\",\"name\":\"%s\"}", m, n);
}

void video_renderer_set_track_metadata(const char *title, const char *artist, const char *album) { (void) title; (void) artist; (void) album; }
void video_renderer_pause() {}
void video_renderer_hls_ready() {}
void video_renderer_seek(float position) { (void) position; }
void video_renderer_set_start(float position) { (void) position; }
void video_renderer_resume() {}
int video_renderer_cycle() { return 0; }
bool video_renderer_is_paused() { return false; }
bool video_renderer_eos_watch() { return false; }

uint64_t video_renderer_render_buffer(unsigned char *data, int *data_len, int *nal_count, uint64_t *ntp_time) {
    (void) nal_count; (void) ntp_time;
    int len = data_len ? *data_len : 0;
    bool idr = false, sps = false;
    /* Annex B: 00 00 00 01 <nal header> */
    for (int i = 0; i + 4 < len; i++) {
        if (data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 0 && data[i + 3] == 1) {
            int type = data[i + 4] & 0x1f;
            if (type == 5) idr = true;
            if (type == 7) sps = true;
            i += 3;
        }
    }
    pthread_mutex_lock(&mu);
    st.frames++; st.win_frames++;
    st.bytes += len; st.win_bytes += len;
    if (idr) st.idr++;
    if (sps) st.sps++;
    stats_locked(now_s());
    pthread_mutex_unlock(&mu);
    return 0;
}

void video_renderer_display_jpeg(const void *data, int *data_len) { (void) data; (void) data_len; }
void video_renderer_flush() {}
unsigned int video_renderer_listen(void *loop, int id) { (void) loop; (void) id; return 0; }
void video_renderer_destroy() { video_renderer_stop(); }
bool waiting_for_x11_window() { return false; }

bool video_get_playback_info(double *duration, double *position, double *seek_start, double *seek_duration, float *rate,
                             bool *buffer_empty, bool *buffer_full) {
    if (duration) *duration = 0;
    if (position) *position = 0;
    if (seek_start) *seek_start = 0;
    if (seek_duration) *seek_duration = 0;
    if (rate) *rate = 0;
    if (buffer_empty) *buffer_empty = true;
    if (buffer_full) *buffer_full = false;
    return false;
}

int video_renderer_choose_codec_and_size(bool video_is_jpeg, bool video_is_h265, video_geometry_t *g) {
    if (video_is_jpeg) { emit("{\"ev\":\"video\",\"codec\":\"jpeg\"}"); return 0; }
    emit("{\"ev\":\"video\",\"codec\":\"%s\",\"w\":%d,\"h\":%d,\"sw\":%d,\"sh\":%d}", video_is_h265 ? "h265" : "h264",
         g ? g->width : 0, g ? g->height : 0, g ? g->width_source : 0, g ? g->height_source : 0);
    return 0;
}

void video_renderer_hls_set_volume(double volume) { (void) volume; }
void video_renderer_set_window_handle(uintptr_t handle) { (void) handle; }

/* ---------------- audio ---------------- */

void audio_renderer_init(logger_t *logger, const char *audiosink, const bool *audio_sync, const bool *video_sync, const char *artp_pipeline) {
    (void) logger; (void) audiosink; (void) audio_sync; (void) video_sync; (void) artp_pipeline;
}
void audio_renderer_start(unsigned char *compression_type) {
    emit("{\"ev\":\"audio\",\"ct\":%d}", compression_type ? (int) *compression_type : -1);
}
void audio_renderer_stop() {}
void audio_renderer_render_buffer(unsigned char *data, int *data_len, unsigned short *seqnum, uint64_t *ntp_time) {
    (void) data; (void) seqnum; (void) ntp_time;
    pthread_mutex_lock(&mu);
    st.audio_packets++;
    st.audio_bytes += data_len ? *data_len : 0;
    if (!st.running) stats_locked(now_s());   /* audio alone (no mirror video): still report */
    pthread_mutex_unlock(&mu);
}
void audio_renderer_set_volume(double volume) { (void) volume; }
void audio_renderer_flush() {}
void audio_renderer_destroy() {}
unsigned int audio_renderer_listen(void *loop, int id) { (void) loop; (void) id; return 0; }

/* ---------------- recording (-mp4): not on the head unit ---------------- */

void mux_renderer_init(logger_t *logger, const char *filename, bool use_audio, bool use_video) {
    (void) logger; (void) filename; (void) use_audio; (void) use_video;
}
void mux_renderer_choose_audio_codec(unsigned char audio_ct) { (void) audio_ct; }
void mux_renderer_choose_video_codec(bool is_h265) { (void) is_h265; }
void mux_renderer_push_video(unsigned char *data, int data_len, uint64_t ntp_time) { (void) data; (void) data_len; (void) ntp_time; }
void mux_renderer_push_audio(unsigned char *data, int data_len, uint64_t ntp_time) { (void) data; (void) data_len; (void) ntp_time; }
void mux_renderer_stop(void) {}
void mux_renderer_destroy(void) {}
