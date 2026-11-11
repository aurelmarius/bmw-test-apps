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
> **Graduated:** AirPlay Test works in the car and moved to [aurelmarius/bmw-apps](https://github.com/aurelmarius/bmw-apps) as **myAirPlay** (1.0.0, with the myAirPlay service). Remove AirPlay Test and its service from the Store, then install myAirPlay from there; its fixes are made there. `native/uxplay-mgu` stays here: Emby's player builds its GPU decoder from `native/uxplay-mgu/video`.

### 🎬 Emby (`aurelm_emby`) + Emby cast service (`aurelm-emby`)
*The head unit as a cast target for the Emby phone app, as Emby's TV apps and Kodi's Emby add-on are.*

**Status:** step 3, controls on the iDrive (0.3.9). Works in the car (0.2.x): the picture on the GPU, the sound on the speakers, pause, seek, volume from the phone, the cast menu, cast during a film on the phone, text subtitles drawn by the app (in ASCII), a 4K Dolby Vision film tone-mapped by the server. 0.3.0 in the car: the controls and the progress bar work from the iDrive controller; a touch on the picture or the iDrive controller shows a bar with the position, a progress bar (touch it to seek) and the buttons -10 s, play / pause, stop, +30 s, aspect (fit, zoom, fill) and exit; the controller's knob moves along the buttons, a press runs one, a push down hides the bar. 0.3.1: a touch on the film went to the status page underneath (its Sign in / Sign out pressed unseen: signed out, the QR code open); while the film shows, the page now takes no touch, and Sign out (and Sign in while signed in) wants a second press within 5 s. Show picture is the page's first button. 0.3.2: cast chosen while a film plays on the iPhone: the Emby app for iOS stops it and sends the car only SetVolume, never the film (the server's log); 0.3.3: the car takes over the film this account plays right now on another device (where it is, with its audio and subtitle tracks) and tells that device to stop; with none playing, the one stopped in the last 90 s. 0.3.4: the phone, told to stop, sent the same Stop on to the car (taken over, then stopped 1 s later); a Stop in the 5 s after a take-over is that echo and is ignored. Cast during a film on the phone works in the car (0.3.4). 0.3.5: a seek no longer shows the status page for a moment (each stream is a new player): the picture stays up, black with "Loading...", until the new one comes. 0.3.6: the progress bar follows a finger dragged along it (the target in yellow) and seeks where it lifts; before, only where it came down counted. 0.3.7: Stop on the iDrive pauses the film for the phone (whose Emby app has only play / pause for the car) and closes the player; play on the phone goes on from there. 0.3.8: streaming quality in Settings (8, 4, 2 or 1 Mbit/s: the most the car asks the server to transcode to) and, unless turned off there, the quality goes one step lower by itself when the stream runs dry (twice in a minute, or 8 s at once) and one step back up after 5 minutes without it (works in the car). 0.3.9: AUDIO and SUBS on the controls open the film's audio and subtitle tracks (subtitles with Off first, the current one marked); a touch, or the knob and a press, chooses one. Another audio is a new stream from where the film is; a text subtitle is drawn by the app at once; a picture one (PGS) is burned in by the server (a new stream).

The service signs in once with your Emby account and stays connected to your Emby server, so **BMW iDrive** shows in the Emby app's cast menu. The phone only sends the command through the server: it does not connect to the head unit, and wireless CarPlay stays connected. The server must be reachable from the internet; the head unit gets there through **mgu-uplink**, as its own uid only.

1. Install **Emby**: the Store installs the **Emby cast service** first. **Restart the head unit once** after installing.
2. Open **Emby** on the iDrive and press **Sign in**: a QR code shows. Scan it with the iPhone (connected to the car with wireless CarPlay), enter the server's address, the user and the password. Only the access token is kept, never the password.
3. **Open the Emby app on the iDrive once** (it routes the sound to the speakers and shows the picture). In the Emby app on the iPhone: play a film, tap the cast button, choose **BMW iDrive**.
4. The film plays **over the whole centre screen while the car is parked**, with its sound on the car's speakers. Driving, the picture hides and the sound goes on. The setting **Picture only while parked** (on by default) can be turned off in the app's Settings, so the picture also stays while driving (for passengers, e.g. children watching cartoons). The centre screen is in the driver's view: where the law forbids a video in the driver's view while driving, leave it on. A touch on the picture or the iDrive controller shows the **controls**: the title, the position, a progress bar (drag along it: the film goes where the finger lifts), and the buttons **-10 s**, **play / pause**, **stop**, **+30 s**, **aspect** (**fit** the whole film with black bars, **zoom**, **fill** the screen with the edges cut; also in Settings) and **exit** (back to the status page; **Show picture** brings the picture back). With the controller: turn to move along the buttons, press to run one, push down to hide the bar. It hides after 5 s, not while paused. Pause, seek, volume, the audio and subtitle tracks and the next episode all come from the phone, which shows the position. **Stop** on the iDrive pauses the film (the phone shows it paused) and closes the player; play on the phone goes on from there.
5. The server sends what fits as it is (H.264 up to 1080p with AAC or AC-3) and converts the rest (HEVC, 4K, HDR, DTS, E-AC-3, chosen subtitles), at 8 Mbit/s at most. If something does not work, the page says where it stopped (**Playing**, **Picture**, **Sound**): take a photo of it.

myAirPlay (bmw-apps), Emby and TVH share the car's speakers' input: the one playing keeps it, and the others say so and wait.

Details: [`native/aurelm-emby/README.md`](native/aurelm-emby/README.md), the player: [`native/emby-player/README.md`](native/emby-player/README.md).

### 📺 TVH (`aurelm_tvh`) + TVH service (`aurelm-tvh`)
*Tvheadend's TV channels on the centre screen, over Tvheadend's HTTP interface (as Kodi's `pvr.hts` shows them).*

**Status:** 0.1.8 (service 0.1.6): reconnecting through weak LTE (0.1.7 in the car: the stream froze, "Tuning..." and the player was gone after 3 tries 2 s apart): a stream that breaks or goes silent for 10 s is opened again for 2 minutes (1, 2, 4, 8, then every 10 s), a profile lower; the picture shows "Reconnecting... 0:23" meanwhile, and after 2 minutes "No connection to the server. Press to try again" instead of closing. 0.1.7: the guide's times in the car's time zone (the head unit's Linux keeps UTC, so 0.1.6 showed them 2 h early): the setting **Time zone** (Romania by default, EU summer time). 0.1.6: a channel's **DVB subtitles** (HBO's, Romanian) over the picture: the server's profiles pass the first subtitle stream on when their "Subtitle codec profile" is **Copy**; the player decodes it (bitmaps, as sent) and lays it over each picture; the setting **Subtitles** (on by default) turns them off; the Status tab's Picture row says the language and how many have come. 0.1.5 in the car. 0.1.4 in the car: the logos without stripes. 0.1.5: a finger dragged on the TV tab scrolls the list it is on (the channels, or the programme, which now goes on past its first 6 entries), and on the list and the guide over the picture too (a tap there now acts as the finger lifts, so a drag plays nothing); the knob on the last row shown (or the first) moves the list a row on, so it goes through every channel without the arrows. 0.1.3 in the car: the logos show, but striped (thin lines between their rows: each row was a rectangle a pixel high, and the page is scaled by 1.164, so the renderer left the rows' edges part-covered). 0.1.4: the same run on the rows below is one taller rectangle, and each is drawn a pixel wider and taller, the next drawn over the overlap: no gap at any scale. 0.1.1: the picture over the whole screen, the controls, the list and the guide over it work. 0.1.2 / service 0.1.3: the Status tab's **Logos** row found why no logo showed (HTTP 404 from the logos' old sites). Since 2026-11-11 the server's logos are public PNGs (400x240, 5:3, on a plate of their own with rounded corners) at their own address with `?v=<hash>`, given to the clients as the channel's icon; Tvheadend's image cache is to stay **off**. 0.1.3 / service 0.1.4: a logo is fetched from that address as it is, kept on the head unit by that address (a new `?v=` is fetched anew; the list has its logos without the internet too), drawn in a 5:3 box (60x36) with nothing added, its transparent corners left as they are; a channel without a public logo (none, or `imagecache/<n>`) shows a plate with its name and asks nothing; the logos come from the playlist too when the API lists no channel.

The server **transcodes** each channel with a stream profile made for the car: H.264 **deinterlaced by the server**
(VAAPI), AAC, MPEG-TS. A channel as the satellite sends it (`pass`: 1080i, MP2, 12 Mbit/s) is not for the car. The
head unit's GPU decodes the picture (its own player, `native/tvh-player`), and the sound goes to the car's speakers.

**On the server (once):** Tvheadend 4.3, Configuration > Stream (Expert view):
1. **Codec Profiles**: `h264_vaapi` with **Deinterlace** on, one per step: 720p at 3 Mbit/s, 576p at 1.5 Mbit/s, 360p at 0.7 Mbit/s, a key frame each second (GOP 25), no or 1 B frame; and `aac`, stereo, 128k (96k for the lowest).
2. **Stream Profiles**: "Transcode/av-lib", container **MPEG-TS**, named **`mgu-hd`**, **`mgu-sd`**, **`mgu-low`**; **Subtitle codec profile: Copy** (a channel's first DVB subtitle stream goes on with it).
3. **Users**: a user of its own for the car, with **Streaming** and the profiles `mgu-*` only. Configuration > General > Base: Authentication type **Digest** (the password then never crosses the internet in clear).

**In the car:**
1. Install **TVH**: the Store installs the **TVH service** first. **Restart the head unit once** after installing.
2. Open **TVH** and press **Sign in**: scan the QR code with the iPhone (wireless CarPlay connected), enter the server's address (e.g. `tv.example.com:9981`, the port forward), the user and the password. Tvheadend has no token: the password is kept on the head unit (root's, 0600).
3. The page has two tabs. **TV**: the channels on the left, with their logos (Tvheadend's picons, PNG), what is on now and how far it is (the one playing marked with a green arrow); on the right, the programme of the selected channel (from now, the chosen entry's time and description below). A touch or a press of the controller on a channel selects it, a second one plays it; a finger dragged on a list scrolls it, the knob goes through every channel, ^ v page through a long list. **Status**: the diagnosis (service, internet, account, server, playing, picture, sound) and the service's log. **Watch** plays the selected channel (the last one, the first time); **Channel +** and **Channel -** change it, also while driving (the picture hides, the sound goes on); **Stop** ends it; **TV / Status** switches the tabs.
4. The picture shows **over the whole centre screen while parked** (setting "Picture only while parked", on by default). A touch or the iDrive controller shows the controls: **CH -**, **CH +**, **LIST** (every channel with its logo and what is on now: turn the knob and press, or touch one; a push up opens it too), **EPG** (the guide: the channel's programme for the next 24 hours, the one chosen with its time and description; the knob moves along it, a push left / right or **<** **>** shows the other channels, a press or a second touch watches the guide's channel), **stop**, **aspect** (fit, zoom, fill), **exit**.
5. **Settings** (the third tab, as in Emby): **Picture only while parked** (on by default), **Picture shape**, **Streaming quality** (3 Mbit/s mgu-hd, 1.5 Mbit/s mgu-sd, 0.7 Mbit/s mgu-low: the server's profiles) and **Lower the quality by itself when the internet is slow** (on: the stream running dry twice in a minute, or for 8 s, goes one profile down; 5 minutes without, one back up). If something does not work, the page says where it stopped (**Server**, **Playing**, **Picture**, **Sound**): take a photo of it. A profile that does not deinterlace shows **INTERLACED** on the page.

Details: [`native/aurelm-tvh/README.md`](native/aurelm-tvh/README.md), the player: [`native/tvh-player/README.md`](native/tvh-player/README.md).

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
