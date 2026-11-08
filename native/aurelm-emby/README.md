# aurelm-emby

The service behind the app **Emby** (`apps/aurelm_emby`): the head unit as a cast target for the Emby
phone app, as Emby's own TV apps and Kodi's Emby add-on (`quickmic/plugin.video.emby`) are. Signed in
with the owner's Emby account, it keeps a WebSocket to the Emby server and announces remote control
(`Sessions/Capabilities/Full`), so **"BMW iDrive"** shows in the Emby app's cast menu. A film sent to it
arrives as `Play` (item ids, start position), pause / seek / stop as `Playstate`, volume and messages as
`GeneralCommand`. The phone only sends the command, through the server: it does not connect to the head
unit, and wireless CarPlay stays as it is.

**Step 1 (0.1.x):** the connection and the commands; the app shows what was sent (the film, its video
and audio streams, the start position). Playback (the stream from the server, the GPU decoder and the
car's speakers of AirPlay Test) comes next.

## How it runs

| Part | Runs as | Does |
|---|---|---|
| `service.js` | root | the app's control socket, the sign-in page, the state; starts `client.js` |
| `client.js` (`emby.js`, `ws.js`, `netx.js`) | uid 13101 | the Emby client: HTTPS API and WebSocket to the server |

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
to a minute); signed out, it ends 10 minutes after the last request. A token the server no longer
accepts (signed out on the server, user removed) signs it out, and the app says so.

## Removal leaves nothing

| What | Gone by |
|---|---|
| the sign-in page's firewall rules | the page's close; the service's `ExecStopPost` (`cleanup.js`, also after a crash or a kill); the tool's `deactivate` (the first step of an uninstall); a reboot |
| `/var/opt/aurelm-emby/` (versions, `state/`: `device.json`, `account.json` with the token, 0600) | the deploy tool's uninstall |
| `aurelm-emby.socket`, `.service`, the `sockets.target` link, the recmgr name, `uplink uids.d/aurelm-emby` | the deploy tool's uninstall |
| `/run/aurelm-emby.sock` | the socket's stop (`RemoveOnStop=yes`) |
| the session on the Emby server | "Sign out" in the app (`Sessions/Logout`); otherwise the server's Devices page |

## Head-unit safety

As AirPlay Test's service (`native/aurelm-airplay-probe/README.md`): `LimitCORE=1` and no `+` commands
(no core dump to the crash handler), every `nft` through `sh -c 'ulimit -c 1; exec nft ...'`, recmgr
lists `aurelm-emby`, a start limit (10 in 10 minutes), Node 8.9.4 JavaScript only, nothing written
outside `/var/opt/aurelm-emby`, the control socket in the Emby app's own group (`sockgroup.js`), never
`tm_oap_app`. Bounded: nice 10, idle I/O, 50% of a core, 128 MiB, 32 tasks.

## Control

One JSON object per line on `/run/aurelm-emby.sock`: `{"cmd":"status"}`, `{"cmd":"signin-open"}`,
`{"cmd":"signin-close"}`, `{"cmd":"signout"}`, `{"cmd":"exit"}`; the reply is the status.

Tests: `node tests/emby_service.test.js` (a fake Emby server; also on Node 8.9.4).
