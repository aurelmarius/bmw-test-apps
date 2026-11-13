# aurelm-mediaprobe

The service behind the app **Media Probe** (`apps/aurelm_mediaprobe`): what the car offers a music player, as a first
step towards a Music Assistant client on the head unit. It answers three questions before the player is written:

1. **The steering wheel's buttons**: do skip left / right (and the knurled wheel, the star) reach an app, and which way?
2. **The metadata**: can an app's title, artist and cover show where BMW's media show them (the media widget, the
   instrument cluster), through CarLife's bridge to BMW's media or through the BMW MediaPlayer?
3. **The sound**: which source plays a stream that never ends (an internet radio)?

Everything is SOME/IP, as root, from the unit's own catalog (`/etc/oap/someip/someip-interfaces.json`). The interface
configs are made at the service's start the way MainApp's installer makes an app's (`oapgen.js`, a copy of
`kit/tools/oapgen/gen.js`: BMW's generator, loaded from the firmware), asking for every field, method and event of
the interfaces below; MainApp's own configs (`/usr/lib/oap-mainapp/src-gen`, as RideTube's daemon uses them) are the
fallback.

## What it watches (all the time it runs)

| Monitor | Interface, instance | What |
|---|---|---|
| wheel | `controlelements.SteeringWheelPushButton`, `1` | `statusSearchSwitch1` (skip: `SUCHLAUF_ABWAERTS_MENUE_SKIP_LINKS` / `SUCHLAUF_AUFWAERTS_MENUE_SKIP_RECHTS`), `statusRotarySteps` / `statusRotaryPress` (the knurled wheel), `operationSteerWheelFAV` (the star), voice, phone, volume |
| source | `entertainment.mediasource.MediaSource`, `1` | `activeSourceId`, `sources`: the source the HMI takes as playing |
| hmi | `hmi.hmimediastate.HmiMediaState`, `HMI_CID` | `playerMetadata`, `coverArt`, `trackProgress`...: what the HMI shows as playing |
| carlifeMedia, oapMedia | `entertainment.mediaplayer.MediaPlayer`, `CarLifeMedia` and `OapGenericMedia` | state, time, metadata, `thirdPartyMode`, `configureButtonEventForwarding` and the event `buttonEventForward` |
| carlifeMp | `a4a.baiducarlife.carlifemp.CarLifeMp`, `CarLifeMpInst1` | CarLife's bridge to BMW's media: `currentItemMetadata` (song, artist, album, albumArt, duration), `playState`, `deviceInfo`, `currentItemTimeInSeconds`; method `sendButtonEvent` |
| carlifeMgr | `a4a.baiducarlife.carlifehmi.BaiduCarLifeManager`, `CarLifeManagerInst1` | `sessionActive`, `projectedUiActive`... |
| routes | `org.genivi.am.commandinterface.CommandControl`, `1` | the audio manager's main connections |

Every change of every field, and every event, goes to the log with its time.

## Tests (the app starts them; a second press undoes one that stays on)

| Test | What it does | What to look at |
|---|---|---|
| env | the binding's exports and a proxy's methods, the configs, `aplay` / `mkfifo` / USB, the SDK's JavaScript searched for how the binding offers a service | can an app offer `CarLifeMp` itself (the next step)? |
| route287 | source 287 (CarLife's input) to the main speakers, marked available first (as `car_audio.js`); a test tone (2 s, 523 Hz, again and again) with the unit's `aplay`, as nobody with the group `mgu_alsa` | does the HMI take CarLife as the source (`activeSourceId`, the widget's "CarLife - Not connected")? |
| carlife | `CarLifeMp`'s fields written: `deviceInfo` (`name` "Media Probe", `sourceId` 287, `status` 1, then 2, 0, 3 at each new run), `currentItemMetadata` (song, artist, album, the cover's path, 180 s), `playState` PLAYING, the time each second; the fields as they were read first and put back | is `CarLifeMp` offered at all on a European car? Does the widget, the cluster or the HMI's media screen show the song? |
| forward | `configureButtonEventForwarding` on `CarLifeMedia` and `OapGenericMedia`: ITEM_NEXT, ITEM_PREV, PLAY, PAUSE, STOP, FAST_FWD, FAST_BWD, SCAN_NEXT, SCAN_PREV; put back after | do the wheel's skip buttons arrive as `buttonEventForward`? |
| p_mp3, p_m4a, p_aac | source 1046 to the speakers, then `OapGenericMedia.playFile` (as RideTube) with a 30 s file: MP3 with ID3 tags and a cover, M4A with tags and a cover, AAC in ADTS | which formats play; does `currentItemMetadata` (or the widget) take the file's tags? |
| p_grow | the file's first 5 s written, then the rest a little faster than it plays; played at once | does the player read on past the end it first saw (a radio as a growing file)? "played to" says how far |
| p_fifo | a named pipe, written again and again | does `playFile` take a pipe? |
| p_live, p_http | `http://127.0.0.1:8494/live.mp3` (never ends, chunked, no length) and `/file.mp3` (with its length); every request logged with its headers | does `playFile` take a URL at all? |
| stopall | everything undone: routes, forwarding, CarLife's fields, the 1046 player (STOP), the feeds, the tone | |

The test files are in `media/` (made by `make_media.sh` with FFmpeg; each has its own sound, so it is clear in the
car which one plays). The 1046 tests copy them into `/var/opt/aurelm-mediaprobe/play` (0711, the files 0644: the
media engine runs as its own uid and opens them by name, as RideTube found).

## Log and report

- `/var/opt/aurelm-mediaprobe/state/probe.log`: every change, event and test, with times (4 MiB, then `probe.log.1`).
- **Report** (the app's button): `report.json` beside it (each test's result, each field's last value and how often
  it changed), and both copied to a USB stick if one is in (`mediaprobe-<time>.log`, `mediaprobe-<time>-report.json`).

## When it crashes

0.1.0 came and went on the screen in the car (the app's "does not answer", then the list, again and again) before
any test ran: the service died while it started and systemd started it again every 10 s. 0.1.1:

- the configs are made in a child process (`prepare.js`, its own memory: the catalog and the firmware's generator
  never in the service, which answers the app meanwhile), and kept for the next starts while the catalog is the same;
- each risky step (a monitor's proxy, each subscription, each test) is written to `state/step.json` before it runs.
  A step the last run died in is counted in `state/crashed.json` and, for a monitor, skipped from then on, so one bad
  interface no longer takes the service down at every start; the log says `CRASH GUARD: ...`. A new version starts
  afresh;
- the SDK search (env) reads one file per tick, 300 files of 4 MiB at most;
- the app keeps the last answer (`SERVICE SILENT n S` at the top) and shows the service's start count in this boot,
  its memory, its phase and the steps that crashed it;
- 256 MiB and a whole core (`CPUQuota=100%`) instead of 192 MiB and half a core.

0.1.1 in the car showed the real causes (its log): BMW's generator refused the whole manifest for one field
(`SteeringWheelPushButton.requestSteerWheelFunctions` has `"getter": {"id": 0}`: an id 0 is none), so no config was
made and only MediaPlayer and CommandControl (MainApp's own configs) were watched; and the SDK search read hundreds
of files in the service, which systemd killed for its memory at every start. 0.1.2: an id 0 is no getter / setter /
notifier; the generator runs one interface at a time and leaves out a field's flag it refuses, never the other
interfaces; the SDK search runs in its own process (`scan.js`, `--max-old-space-size=96`); the service's heap is
capped at 128 MiB. Found in that log: the binding exports `registerService` (an app can offer a service), the unit
has no `aplay` (the 287 test makes the route but plays no tone), `OapGenericMedia` is there (`INT_MASS_STORAGE`,
next / previous AVAILABLE).

0.1.2 in the car (2026-11-13), the answers so far: an MP3 / M4A with tags played on 1046 shows its title, artist,
cover (the engine writes it to /tmp/mediaramdisk_hu/covers) and progress on the cluster and the media screen; the HMI
takes 1046 as an entertainment source ("Active Player") and goes back to the radio when it is disconnected; the
wheel's skip, volume, knurl and special buttons all reach `SteeringWheelPushButton`; forwarding on `OapGenericMedia`
is taken (it forwarded our own STOP, so 0.1.3 forwards only next / previous / scan / fast); `CarLifeMp` takes its
fields, but the HMI shows "No device connected" on 287 and `CarLifeMedia` is not offered; a growing file plays only
as far as it was when opened, a pipe and http:// URLs give `ITEM_UNPLAYABLE` (the engine never asked our server).
0.1.3 adds, first in the list: `p_skip` (2 minutes with forwarding, press skip), `p_pause` (PAUSE then PLAY, does the
time stop?) and `p_sparse` (a 60-minute MP3 made at its whole size at once with its ID3 tag, written ahead of the
player: does a radio play this way?). `id3.js` writes the tags (the player will tag Music Assistant's tracks the same way).

Over SSH: `journalctl -u aurelm-mediaprobe --no-pager -n 150` and `/var/opt/aurelm-mediaprobe/state/probe.log`.

## Safety

- Nothing runs at boot: the app's first connection to `/run/aurelm-mediaprobe.sock` starts the service; it ends 20
  minutes after the app's last request with no test on.
- Whatever a test changes is undone when it ends: a second press, Stop all, or the service's end (systemd gives it 8
  s). A route a crash left is disconnected at the next start (only our own, from this boot: `routes.js`).
- Source 287 in use by another app (myAirPlay, TVH Player, Emby) is not taken.
- No internet: everything played is in the package or on 127.0.0.1.

## Tests (off the car)

    node tests/mediaprobe_service.test.js      # a fake SOME/IP binding; Node 8.9.4 too
