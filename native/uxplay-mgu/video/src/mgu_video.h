// SPDX-License-Identifier: GPL-3.0-or-later
/* mgu_video.cpp's C interface, for renderer/mgu_renderer.c */
#ifndef MGU_VIDEO_H
#define MGU_VIDEO_H
#ifdef __cplusplus
extern "C" {
#endif
/* one access unit; returns 1 the first time the decoder opened, -1 the first time it could not
 * (mgu_video_error() says why), else 0. shown/errors: totals so far. */
int mgu_video_frame(const unsigned char *data, int len, unsigned long long *shown, unsigned long long *errors);
void mgu_video_stop(void);
void mgu_video_close(void);
const char *mgu_video_error(void);
const char *mgu_video_path(void);
void mgu_video_size(unsigned *w, unsigned *h);
#ifdef __cplusplus
}
#endif
#endif
