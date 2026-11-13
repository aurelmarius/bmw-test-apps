# ma-player

The sound of the Music Assistant service (`native/aurelm-music`) on the iDrive 7 head unit (MGU): the music
Music Assistant sends over Sendspin (Opus packets, or PCM) comes in on stdin, framed, and goes to ALSA, into
SmartXbar's CarLife input (source 287), which the app routes to the main speakers (`apps/aurelm_music/car_audio.js`),
as Emby's and TVH Player's players do.

| Frame (u8 type, u32 BE length, payload) | Does |
|---|---|
| `F` `"<codec> <rate> <channels> <bits>"` | the format: `opus` (decoded at 48 kHz) or `pcm` (s16le); a new one reopens the output |
| `A` | one Opus packet, or PCM bytes |
| `V` `"<0..1>"` | the volume, applied to the samples |
| `C` | drop what ALSA still holds (a seek, a new track, a pause) |
| `Q` | quit |

Events on stdout: `MGU {"ev":"open"|"error"|"tick"|"end",...}` (a tick a second while there is input, and once more
a second after the input stopped).

**Runs as.** Started as root by the service, it becomes `MGU_RUN_AS` (nobody) with the groups in `MGU_GROUPS`
(`mgu_alsa,audio`) before it reads a byte, and refuses to play as root: the smartx sound plugin refuses root and the
tools' uids (Emby 0.2.1). libasound is opened at run time (dlopen), so the binary links only the C library.
`MGU_AUDIO`: `alsa:<device>` (default `alsa:plug:smartx:CarLifeMedia_CF_48_STEREO`), `wav:<path>` (tests) or `null`;
`MGU_ALSA_US`: the ALSA buffer (default 120000 us). The pacing is the service's: it hands each packet over 0.4 s
before its Sendspin timestamp, and a blocking ALSA write holds it back.

## Build

```sh
sh native/ma-player/build.sh      # -> build/ma-player (the unit) and build/ma-player-host (this machine, the tests)
python3 tools/pack_tools.py       # packs it into the aurelm-music tool
```

No Docker: zig's C compiler (PyPI's `ziglang`, into `build/venv`) targets glibc 2.25 exactly
(`-target x86_64-linux-gnu.2.25`; the unit has 2.27). libopus 1.5.2 (Xiph, BSD-3-Clause, `OPUS-LICENSE` in the
tool) is compiled in from its release tag, at a pinned commit. `build.sh` refuses a binary that asks for another loader
than the unit's `/lib/ld-linux-x86-64.so.2`, that needs glibc newer than 2.25, or that needs a library other than
libc, libm, libdl and libpthread. The result: about 420 KB, `GLIBC_2.17` at most.

**Checked off the car:** 251 Opus packets (5 s, 48 kHz stereo, from FFmpeg) decoded into a WAV of 5.02 s, the
volume applied; the drop from root to nobody; the whole chain in `tests/music_service.test.js` (a fake Music
Assistant's Sendspin stream through the service into this player, played at the stream's times).
