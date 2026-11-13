# aurelm-music

The service behind the app **Music Assistant** (`apps/aurelm_music`): the car as a player of your
[Music Assistant](https://github.com/music-assistant) server, from anywhere (the car is never at home).

## How it reaches the server

Found with Media Probe and a probe against Music Assistant 2.10.9 (2026-11-13), through the server's own address
(e.g. `https://music.example.com`, as the phone's Music Assistant app opens it from outside):

- **The REST API**: `POST /api {command, args}` with `Authorization: Bearer <token>`: the home rows
  (`music/recommendations`, `music/recommendations/items`), the library (`music/<kind>/library_items`), search,
  an album's / playlist's / artist's / podcast's tracks, the queue (`player_queues/...`).
- **The sound: Sendspin**, Music Assistant's own protocol, through its authenticated proxy `/sendspin` (the first
  message `{"type":"auth","token"}`): the music streams to remote players only this way (the stream server, port
  8097, is the home network's). The service is a legacy (unencrypted) Sendspin client, which the server takes with
  no pairing and no approval (TLS is the connection's): roles player (Opus 48 kHz first), metadata, artwork (PNG,
  400 px) and controller. The server sends 30 s of sound at once and then in real time (aiosendspin's player role:
  30 s at most): a gap of up to 30 s in the mobile network goes unheard.
- **The player**: the Sendspin client becomes a Music Assistant player of its own (a "universal player", e.g.
  `upd5c11c0f`), found by its `output_protocols[].output_protocol_id`, our client id; its queue is played to with
  `player_queues/play_media`. It is also a player the phone's Music Assistant app can send music to ("BMW iDrive").
- **Pictures**: `/imageproxy/<proxy_id>?size=80|160|256|512&fmt=png`.

**Why not the BMW media player (source 1046)**, which shows a file's title, artist and cover on the cluster by
itself (Media Probe 0.1.2): it plays whole files only (a file that grows, a pipe, a URL, a file made at its size:
all refused or stopped), and Sendspin gives no more than 30 s ahead, so a track can never be whole before it plays.

## Parts

| | |
|---|---|
| `service.js` | root, socket activated (`/run/aurelm-music.sock`): the account, the client, the player, the sign-in page, the pictures kept in memory |
| `client.js` | the client, a child as the tool's internet uid (13106, mgu-uplink routes it, never root) |
| `ma.js` | the REST API and the Sendspin client: time sync (the exchange with the least delay of the last 12), each packet handed to the player 0.4 s before its time (late ones dropped), `stream/clear` / `stream/end` drop what is queued, reconnection (2 s, 4 s ... 30 s; the 30 s queued keep playing) |
| `ws.js` | Emby's WebSocket client, with binary messages |
| `netx.js`, `nft.js`, `cacert.pem` | Emby's: the uplink's DNS and our CA list; the firewall hole for the sign-in page |
| `player.js` | `ma-player` (`native/ma-player`): started by the first sound, ended after 30 s without any |
| `page.js` | the sign-in page: the server's address, and the user and password (the server gives a long-lived token, a year; only it is kept), or a token made in Music Assistant (an account that signs in through Home Assistant) |

**Sign-out** revokes this car's token on the server (named `BMW iDrive <id>`), not the others.

**State** (`/var/opt/aurelm-music/state`, 0700): `device.json` (the car's Sendspin id), `account.json` (server, user,
the long-lived token; 0600).

## Tests

    sh native/ma-player/build.sh && node tests/music_service.test.js

A fake Music Assistant (REST, `/auth/login`, `/imageproxy`, and `/sendspin` over a WebSocket with real Opus packets
and timestamps); the service, its client as a real child process and `ma-player` (the host build, into a WAV):
sign-in (user and password, a token), the home rows, a picture, play (the sound arrives at the stream's times, the
metadata and the artwork in the status), next, a seek, sign-out (this car's token revoked). Runs on Node 8.9.4 too.
`ma.js`'s browsing was also run against a real Music Assistant 2.10.9 (19 home rows, the library, search, an album,
a playlist, an artist, a picture).
