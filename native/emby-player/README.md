# emby-player

The player of the Emby cast service (`native/aurelm-emby`): one Emby stream on the iDrive 7 head unit (MGU). MPEG-TS
comes in on stdin (the service fetches it from the Emby server and hands it over). The picture is decoded on the
GPU into mgu-render's frame file, and the sound goes into SmartXbar's CarLife input. A seek or another film starts
a new player.

| Part | Does |
|---|---|
| demux | libavformat's mpegts demuxer on stdin (1 MiB read to find the streams; a sound stream that shows up later, as Emby's transcoder may write it, is taken when it does), a video and an audio queue (6 s or 40 MiB at most: when the player is ahead, the stream waits in the pipe and so in the server's socket) |
| picture | `src/decoder_msdk.cpp`: our copy of Moonride's MSDK decoder (VA-API on `/dev/dri/renderD128`), changed in two ways: frames come out in **display order** (films have B frames; the AirPlay receiver's copy decodes in decoding order) and a film is **fitted whole** (black bars, never cropped). VPP fits the picture into 1920x720, and each picture goes into the frame file (`/dev/shm/mgu-video-aurelm-emby`, MGVF, 3 slots, I420) when the clock reaches it. A picture already late is decoded without VPP and without its copy. |
| sound | libavcodec's aac, ac3 and eac3 decoders, mixed down to stereo S16 at the volume, written to ALSA `plug:smartx:CarLifeMedia_CF_48_STEREO` (libasound opened at run time, the device non-blocking, as the AirPlay receiver's). The sound is kept on the clock: late sound is dropped, early sound waits. |
| clock | monotonic, from the first picture's timestamp. It stops while paused, and while the stream runs dry (buffering, until 1 s is queued again). |

The NAL framing (`nal_reader.cpp`), the frame-file writer (`mgvf.cpp`), the MSDK headers and the ABI lists and
checks are the AirPlay receiver's, read from `native/uxplay-mgu/video` by the Makefile. They are not copied and not
changed.

**Runs as.** The service starts it as root. It creates the frame file, owned by nobody (mgu-render takes that),
then becomes `MGU_RUN_AS` (nobody, as the AirPlay receiver: the smartx sound plugin refused uid 13101 in the car) with the groups in `MGU_GROUPS` (`video`: the GPU's render node;
`mgu_alsa`: the sound devices), before it reads a byte of the stream. It refuses to run as root. It has the
service's limits: its cgroup, nice 10, and `LimitCORE=1` (no core dump to the crash handler; the tool lists
`emby-player` in `crashNames`).

**Ending.** Told to end (`quit`, SIGTERM, the service gone), it closes the sound device first and is gone within
2.5 s however far it got; the log says what was still running.

**Control** (fd 3, one per line): `pause`, `resume`, `volume <0..1>`, `quit`. **Events** (stdout):
`MGU {json}` with `open` (the streams), `decoder`, `audio`, `tick` (every 500 ms: position, state, pictures
shown and late, sound played, dropped and unread, buffered seconds), `end` and `error`.

| Variable | |
|---|---|
| `MGU_VIDEO_PATH` | the frame file (default `/dev/shm/mgu-video-aurelm-emby`) |
| `MGU_VIDEO_SIZE` | `WxH` of the output (default `1920x720`, the centre screen) |
| `MGU_VIDEO_OFF` | set: no decoder (a PC); pictures are only timed and counted |
| `MGU_AUDIO` | `alsa:<device>` (default), `null`, or `wav:<path>` (tests) |
| `MGU_ALSA_US` | the ALSA buffer in µs (default 64000) |

## Build

```sh
sh native/emby-player/build.sh    # -> native/emby-player/build/emby-player (needs git, python3, Docker)
python3 tools/pack_tools.py       # packs it into the aurelm-emby tool
```

The build runs in ubuntu:18.04 (glibc 2.27, as the unit), with FFmpeg n6.1.2 at the AirPlay receiver's pinned
commit. FFmpeg is configured with only the mpegts demuxer, the h264, aac and ac3 parsers, and the aac, ac3 and
eac3 decoders, and linked statically, as are libstdc++ and libgcc. `build.sh` refuses a binary that:
- asks for another loader than the unit's `/lib/ld-linux-x86-64.so.2`;
- needs glibc newer than 2.25. `powf` and `log2f` are bound to their older versions (`src/glibc_compat.c`);
- does not start in ubuntu:18.04;
- imports something the unit's `libmfxhw64`, `libva` or `libva-drm` do not export (`woc_abi.py`).

**Tests.** `node tests/emby_service.test.js` plays `tests/fixtures/emby_sample.ts` (3 s, H.264 with B frames, AAC)
through the service with this binary when it is built (`MGU_VIDEO_OFF`, the sound into a WAV file).

**Checked off the car:** the build and its checks; real-time playback; pause; buffering after a gap in the stream;
AC-3 5.1 mixed down; the drop from root to another uid with the frame file owned by nobody.

**Checked in the car (0.2.0):** the GPU decoder and the picture (H.264 1920x1080 from the server). As uid 13101 the
sound did not open (`snd_pcm_open`: Operation not permitted); 0.2.1 runs the player as nobody.

**Not checked yet (car only):** the sound on the smartx device as nobody.

**License.** GPL-3.0-or-later. FFmpeg is LGPL-2.1-or-later; its licence ships with the tool as `FFMPEG-LICENSE`.
