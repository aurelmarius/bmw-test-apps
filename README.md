# BMW iDrive 7 Test Apps (MGU)

> [!WARNING]
> **The apps in this repository are still being designed and tested.**
> They are published here only so they can be installed straight from the Store for testing in
> the car. They may not work, may not work on your car, may behave differently from one version
> to the next, and may send commands to the car's control units. Use them at your own risk. Only
> test them while the car is parked, and don't rely on them.
>
> Apps that work well move to **[aurelmarius/bmw-apps](https://github.com/aurelmarius/bmw-apps)**.
> That is the repository to use for everyday apps.

Custom applications for BMW iDrive 7 (MGU head units), compatible with **Robert Nisipeanu's
mgu-store** and **IterioDev's App Manager**. Built with the same kit as
[aurelmarius/bmw-apps](https://github.com/aurelmarius/bmw-apps).

---

## 🧪 Apps being tested

> **Graduated:** Wheel Heating (`aurelm_wheel_heat`) works in the car and moved to [aurelmarius/bmw-apps](https://github.com/aurelmarius/bmw-apps) (1.0.6); install it from there.
>
> **Graduated:** TVH works in the car and moved to [aurelmarius/bmw-apps](https://github.com/aurelmarius/bmw-apps) as **TVH Player** (1.0.0, with the TVH Player service; from TVH 0.1.10 / service 0.1.7). Remove TVH and its service from the Store, then install TVH Player from there and sign in again; its fixes are made there.
>
> **Graduated:** AirPlay Test works in the car and moved to [aurelmarius/bmw-apps](https://github.com/aurelmarius/bmw-apps) as **myAirPlay** (1.0.0, with the myAirPlay service). Remove AirPlay Test and its service from the Store, then install myAirPlay from there; its fixes are made there. `native/uxplay-mgu` stays here: Emby's player builds its GPU decoder from `native/uxplay-mgu/video`.

### 🎬 Emby (`aurelm_emby`) + Emby cast service (`aurelm-emby`)
*The head unit as a cast target for the Emby phone app, as Emby's TV apps and Kodi's Emby add-on are.*

**Status:** step 3, controls on the iDrive (0.3.12). Works in the car (0.2.x): the picture on the GPU, the sound on the speakers, pause, seek, volume from the phone, the cast menu, cast during a film on the phone, text subtitles drawn by the app (in ASCII), a 4K Dolby Vision film tone-mapped by the server. 0.3.0 in the car: the controls and the progress bar work from the iDrive controller; a touch on the picture or the iDrive controller shows a bar with the position, a progress bar (touch it to seek) and the buttons -10 s, play / pause, stop, +30 s, aspect (fit, zoom, fill) and exit; the controller's knob moves along the buttons, a press runs one, a push down hides the bar. 0.3.1: a touch on the film went to the status page underneath (its Sign in / Sign out pressed unseen: signed out, the QR code open); while the film shows, the page now takes no touch, and Sign out (and Sign in while signed in) wants a second press within 5 s. Show picture is the page's first button. 0.3.2: cast chosen while a film plays on the iPhone: the Emby app for iOS stops it and sends the car only SetVolume, never the film (the server's log); 0.3.3: the car takes over the film this account plays right now on another device (where it is, with its audio and subtitle tracks) and tells that device to stop; with none playing, the one stopped in the last 90 s. 0.3.4: the phone, told to stop, sent the same Stop on to the car (taken over, then stopped 1 s later); a Stop in the 5 s after a take-over is that echo and is ignored. Cast during a film on the phone works in the car (0.3.4). 0.3.5: a seek no longer shows the status page for a moment (each stream is a new player): the picture stays up, black with "Loading...", until the new one comes. 0.3.6: the progress bar follows a finger dragged along it (the target in yellow) and seeks where it lifts; before, only where it came down counted. 0.3.7: Stop on the iDrive pauses the film for the phone (whose Emby app has only play / pause for the car) and closes the player; play on the phone goes on from there. 0.3.8: streaming quality in Settings (8, 4, 2 or 1 Mbit/s: the most the car asks the server to transcode to) and, unless turned off there, the quality goes one step lower by itself when the stream runs dry (twice in a minute, or 8 s at once) and one step back up after 5 minutes without it (works in the car). 0.3.9: AUDIO and SUBS on the controls open the film's audio and subtitle tracks (subtitles with Off first, the current one marked); a touch, or the knob and a press, chooses one. Another audio is a new stream from where the film is; a text subtitle is drawn by the app at once; a picture one (PGS) is burned in by the server (a new stream). 0.3.12: the film on the instrument cluster, as TVH's channel: a card over the media widget in the right dial (its poster from the server, the film or series, the year or episode, h:mm of h:mm, the minutes left, a progress bar, paused), drawn through cluster-render (the Store; Waze on cluster installs it); on by default, moved by up to 160 px in the settings; a Cluster row on the page.

The service signs in once with your Emby account and stays connected to your Emby server, so **BMW iDrive** shows in the Emby app's cast menu. The phone only sends the command through the server: it does not connect to the head unit, and wireless CarPlay stays connected. The server must be reachable from the internet; the head unit gets there through **mgu-uplink**, as its own uid only.

1. Install **Emby**: the Store installs the **Emby cast service** first. **Restart the head unit once** after installing.
2. Open **Emby** on the iDrive and press **Sign in**: a QR code shows. Scan it with the iPhone (connected to the car with wireless CarPlay), enter the server's address, the user and the password. Only the access token is kept, never the password.
3. **Open the Emby app on the iDrive once** (it routes the sound to the speakers and shows the picture). In the Emby app on the iPhone: play a film, tap the cast button, choose **BMW iDrive**.
4. The film plays **over the whole centre screen while the car is parked**, with its sound on the car's speakers. Driving, the picture hides and the sound goes on. The setting **Picture only while parked** (on by default) can be turned off in the app's Settings, so the picture also stays while driving (for passengers, e.g. children watching cartoons). The centre screen is in the driver's view: where the law forbids a video in the driver's view while driving, leave it on. A touch on the picture or the iDrive controller shows the **controls**: the title, the position, a progress bar (drag along it: the film goes where the finger lifts), and the buttons **-10 s**, **play / pause**, **stop**, **+30 s**, **aspect** (**fit** the whole film with black bars, **zoom**, **fill** the screen with the edges cut; also in Settings) and **exit** (back to the status page; **Show picture** brings the picture back). With the controller: turn to move along the buttons, press to run one, push down to hide the bar. It hides after 5 s, not while paused. Pause, seek, volume, the audio and subtitle tracks and the next episode all come from the phone, which shows the position. **Stop** on the iDrive pauses the film (the phone shows it paused) and closes the player; play on the phone goes on from there.
5. The server sends what fits as it is (H.264 up to 1080p with AAC or AC-3) and converts the rest (HEVC, 4K, HDR, DTS, E-AC-3, chosen subtitles), at 8 Mbit/s at most. If something does not work, the page says where it stopped (**Playing**, **Picture**, **Sound**): take a photo of it.

myAirPlay and TVH Player (bmw-apps) and Emby share the car's speakers' input: the one playing keeps it, and the others say so and wait.

Details: [`native/aurelm-emby/README.md`](native/aurelm-emby/README.md), the player: [`native/emby-player/README.md`](native/emby-player/README.md).

### 🔬 Media Probe (`aurelm_mediaprobe`) + Media Probe service (`aurelm-mediaprobe`)
*What the car offers a music player: the first step of a Music Assistant client.*

**Status:** step 0 (0.1.0), not yet run in a car. Before a player is written, it answers three questions in the car:
do the **steering wheel's skip buttons** reach an app, can an app's **title, artist and cover** show where BMW's media
show them (the media widget, the instrument cluster), and which source plays a **stream that never ends** (an
internet radio)?

- **Watched all the time** (each change on the screen and in the log): the steering wheel's buttons
  (`SteeringWheelPushButton`: skip left / right, the knurled wheel, the star, voice), the source the HMI takes as
  playing (`MediaSource`, `HmiMediaState`), CarLife's bridge to BMW's media (`CarLifeMp`, `BaiduCarLifeManager`), and
  the BMW MediaPlayer's `CarLifeMedia` and `OapGenericMedia` (state, metadata, forwarded buttons).
- **Tests** (choose with **Previous test** / **Next test**, press **Run / undo**; a second press undoes one that stays
  on): source 287 (CarLife's input, as TVH Player and Emby play) with a test tone; CarLife's metadata written
  (`CarLifeMp`); button forwarding on both players; source 1046 (the BMW MediaPlayer for apps, as RideTube plays) with an
  MP3, an M4A and an AAC file with tags and a cover, a file that grows while it plays, a named pipe, and
  `http://127.0.0.1` streams with and without an end; the environment (does the SOME/IP binding offer services too?).
- **Stop all** undoes everything (routes, forwarding, CarLife's fields as they were). The service also undoes it as
  it ends, and never takes source 287 from another app.
- **Report** writes the log and a report and copies them to a **USB stick** if one is in
  (`mediaprobe-<time>.log`); on the unit: `/var/opt/aurelm-mediaprobe/state/probe.log`.

**How to test** (parked, about 15 minutes): open Media Probe with a USB stick in. 1) Press the steering wheel's
skip buttons, the knurled wheel and the star with the radio playing: the right side counts them. 2) Run **Source
287**: does the media widget say "CarLife"? Skip again. 3) Run **CarLife: write metadata**, look at the widget, the
cluster and the media screen; run it again for the next status (1, 2, 0, 3). 4) Run **Button forwarding**, skip
again. 5) Run each **1046** test and listen (each file has its own beeps); look at the widget and the cluster.
6) **Stop all**, then **Report**. Photos of the widget and the cluster help.

No internet needed. Details: [`native/aurelm-mediaprobe/README.md`](native/aurelm-mediaprobe/README.md).

## 🚀 Installation

### Via mgu-store
1. Open **Store** on your BMW central display.
2. Go to **Settings** -> **Add source**.
3. Enter:
   ```text
   aurelmarius/bmw-test-apps
   ```
4. Select **Releases** as the source type.
5. Tap **Install** next to the app you want to test.

### Via USB stick
1. Download `<id>@<version>.tgz` from [Releases](https://github.com/aurelmarius/bmw-test-apps/releases).
2. Build a USB repository:
   ```powershell
   node mgu-install.js usb-repo E:\ aurelm-emby@<version>.tgz aurelm_emby@<version>.tgz
   ```
3. Insert the USB drive into your car and install from the **USB** page of the Store.

### Via SSH
```bash
/var/opt/mgu-deploy/mgu-deploy.sh install --artifact aurelm_emby@<version>.tgz --yes
```
A service (`aurelm-emby@<version>.tgz`) installs the same way, before the app that needs it.

---

## 🛠️ Development

```bash
python3 kit/tools/build.py <id>                       # -> dist/<id>@<version>.tgz
cp dist/<id>@<version>.tgz packages/                  # a push to main with a new package publishes a release
python3 tools/pack_tools.py                           # native/<id>/ services -> packages/<id>@<version>.tgz
```

**Services (tools).** A native service lives in `native/<id>/` with its `component.json` (the Store's tool
format); an app that needs one names it in its `app.json` (`"requires": {"<id>": "<version>"}`). Release
assets can carry apps only, so the release also updates the **`catalog` release**: `catalog.json` with every
app and service (absolute URLs into that release), every package and icon. The Store reads the source
through it (the source stays `aurelmarius/bmw-test-apps` on **Releases**), installs a service before the
app that requires it, and offers its removal with the app. The `catalog` release is never retired.

App ids start with `aurelm_`, as in [bmw-games](https://github.com/aurelmarius/bmw-games): ids are global on the
head unit, and the Store's publishing guide asks for a prefix of one's own. Each app has its own
`<id>.png` icon at the repository root, which the release carries for the Store.

A push to `main` that changes `packages/` publishes a release straight away (no draft), so the Store
offers it at once, and every older release becomes a pre-release (`tools/retire_older_releases.sh`):
the Store reads every published release, so an app renamed or moved would otherwise show twice. To
withdraw a release by hand, run the **Retire Releases** workflow.

**Kit**: `kit/` is the [iDrive 7 custom apps](https://github.com/cauliflowermossgrape/idrive7-apps) kit (MIT), with the packaging changes from bmw-apps.
