# aurelm-emby

The service behind the app **Emby** (`apps/aurelm_emby`): the head unit as a cast target for the Emby
phone app, as Emby's own TV apps and Kodi's Emby add-on (`quickmic/plugin.video.emby`) are. Signed in
with the owner's Emby account, it keeps a WebSocket to the Emby server and announces remote control
(`Sessions/Capabilities/Full`), so **"BMW iDrive"** shows in the Emby app's cast menu. A film sent to it
arrives as `Play` (item ids, start position), pause / seek / stop as `Playstate`, volume and messages as
`GeneralCommand`. The phone only sends the command, through the server: it does not connect to the head
unit, and wireless CarPlay stays as it is.

**Step 1 (0.1.x):** the connection and the commands. **Step 2 (0.2.x): playback.** A film cast to the head
unit plays. The picture shows on the centre screen while the car is parked, and the sound goes to the car's
speakers. Pause, seek, stop, volume, the audio and subtitle tracks and the queue all come from the phone, which
shows the position as for any Emby player.

## Playback

| Step | Where |
|---|---|
| `Play` (item ids, start, tracks) | `playback.js`, in the client (uid 13101) |
| `Items/{id}/PlaybackInfo` with our profile | the server keeps what fits as it is and transcodes the rest to **H.264** up to 1920x1080 (8 bits, progressive, square pixels) with **AAC or AC-3** (up to 6 channels), always as **MPEG-TS** over HTTP(S), from `StartTimeTicks`. Chosen subtitles are burned into the picture. Bit rate 8 Mbit/s at most. |
| the stream | fetched by the client through `netx.js` (the uplink's DNS, our CA list). It goes to the service on the client's fd 4, in frames (stream id, length), and to `emby-player`'s stdin (`player.js`), with the pipes' backpressure: a paused film holds the server's socket. |
| the player | `native/emby-player` (see its README): started as root for its frame file, then **nobody** with the groups `video` and `mgu_alsa`, as AirPlay Test's receiver (0.2.0 ran it as 13101: the smartx sound plugin refused it, "Operation not permitted"; it needs no internet, the client fetches the stream). The GPU decodes into `/dev/shm/mgu-video-aurelm-emby`, and the sound goes into `plug:smartx:CarLifeMedia_CF_48_STEREO`. |
| on the screen | the app (`apps/aurelm_emby`): AirPlay Test's `mirror_view.js` over the whole screen, **only while parked** (`parked.js` strict). The setting "Picture only while parked" (on by default) turned off keeps it while driving too, for passengers. A button of the iDrive controller hides it, and "Show picture" brings it back. |
| on the speakers | the app routes source 287 to the speakers (`car_audio.js`) while a film is on, paused included. 287 is shared with AirPlay Test: each app disconnects only the connection whose number it saved, neither connects over the other's, and the source is marked unavailable only when 287 is empty. A number saved before a restart of the head unit is forgotten, never disconnected. |
| reports | `Sessions/Playing` at the start, `/Progress` every 10 s and at pause, unpause and volume, `/Stopped` at the end. The transcode is stopped (`DELETE Videos/ActiveEncodings`) when its stream is left. |

A seek, another audio or subtitle track, or a lost connection (3 tries from the position) is a new stream and a
new player. The end of a film plays the next one in the queue. The app must have been opened once since the head
unit started, because the sound's route and the picture are the app's.

## How it runs

| Part | Runs as | Does |
|---|---|---|
| `service.js` | root | the app's control socket, the sign-in page, the state; starts `client.js` |
| `client.js` (`emby.js`, `ws.js`, `netx.js`, `playback.js`) | uid 13101 | the Emby client: HTTPS API and WebSocket to the server; what plays, its stream, the reports |
| `emby-player` (`player.js` starts it) | root, then nobody | the film: MPEG-TS in, the picture on the GPU, the sound into SmartXbar |

**Internet.** mgu-uplink routes only the uids a tool lists (`component.json` `"internet": true`,
`"uids": [13101]`; the deploy tool writes `/var/opt/mgu-uplink/uids.d/aurelm-emby`), never root. So the
client is a child running as 13101, and names are resolved through the uplink's DNS servers
(`/run/mgu-uplink/lease.json`): the unit's own resolver does not resolve internet names. TLS is checked
against `cacert.pem` (Mozilla's list, from certifi `b71b898`, 2026-11-04): the firmware has no public CA
bundle, and Node 8.9.4's own list predates Let's Encrypt's ISRG roots.

**Sign-in.** "Sign in" in the app opens a page for 10 minutes on the car Wi-Fi (`http://<car Wi-Fi
address>:8490/<random token>`), shown as a QR code; the iPhone is on that network for wireless
CarPlay. The page asks for the server's address (typed without `https://`, https is tried first, then
http), the user and the password. The password goes to the server once (`Users/AuthenticateByName`);
only the access token is kept. While the page is open, one accept rule per IPv4 input and output base
chain lets tcp 8490 in and out on the car Wi-Fi's interfaces (comment `aurelm-emby`); the page and the
rules go after the sign-in, after 10 minutes, or when the service stops.

**Lifetime.** Socket activation: the app's first connection starts the service, never the boot. Signed
in, it stays until the unit sleeps (so the phone can cast to it) and reconnects by itself (5 s, doubling
to a minute); the cast settings go again every 4 minutes, as the cast menu lists only the sessions active lately (an HTTP request marks a session active, the WebSocket does not); signed out, it ends 10 minutes after the last request. A token the server no longer
accepts (signed out on the server, user removed) signs it out, and the app says so.

## Removal leaves nothing

| What | Gone by |
|---|---|
| the sign-in page's firewall rules | the page's close; the service's `ExecStopPost` (`cleanup.js`, also after a crash or a kill); the tool's `deactivate` (the first step of an uninstall); a reboot |
| `/var/opt/aurelm-emby/` (versions, `state/`: `device.json`, `account.json` with the token, 0600) | the deploy tool's uninstall |
| `aurelm-emby.socket`, `.service`, the `sockets.target` link, the recmgr name, `uplink uids.d/aurelm-emby` | the deploy tool's uninstall |
| `/run/aurelm-emby.sock` | the socket's stop (`RemoveOnStop=yes`) |
| `/dev/shm/mgu-video-aurelm-emby` (the player's frame file) | the player's end (`player.js`); `cleanup.js` (the service's stop, a crash, an uninstall); a reboot |
| the route of source 287 to the speakers | the app, when the film ends; its own connection left by a crash, at the app's next start (the same boot); a reboot |
| the session on the Emby server | "Sign out" in the app (`Sessions/Logout`); otherwise the server's Devices page |

## Head-unit safety

As AirPlay Test's service (`native/aurelm-airplay-probe/README.md`): `LimitCORE=1` and no `+` commands
(no core dump to the crash handler), every `nft` through `sh -c 'ulimit -c 1; exec nft ...'`, recmgr
lists `aurelm-emby`, a start limit (10 in 10 minutes), Node 8.9.4 JavaScript only, nothing written
outside `/var/opt/aurelm-emby`, the control socket in the Emby app's own group (`sockgroup.js`), never
`tm_oap_app`. Bounded: nice 10, idle I/O, 2 cores at most (the player: AirPlay Test's receiver stuttered at 50%),
256 MiB, 48 tasks. `emby-player` runs with the same limits (it is the service's child) and is listed in
`crashNames`.

## Control

One JSON object per line on `/run/aurelm-emby.sock`: `{"cmd":"status"}`, `{"cmd":"signin-open"}`,
`{"cmd":"signin-close"}`, `{"cmd":"signout"}`, `{"cmd":"playstate","command":"Stop"}` (also `PlayPause`),
`{"cmd":"exit"}`; the reply is the status (with `playback` and `player`).

Tests: `node tests/emby_service.test.js` (a fake Emby server: sign-in, cast, PlaybackInfo, the stream through the
service to a stand-in player and to `emby-player` itself when it is built, pause, seek, volume, stop, the queue)
and `node tests/emby_car_audio.test.js` (the speakers' route against a fake audio manager); also on Node 8.9.4.
