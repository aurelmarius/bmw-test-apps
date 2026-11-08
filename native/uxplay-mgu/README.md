# uxplay-mgu

UxPlay's AirPlay mirroring protocol for the iDrive 7 head unit (MGU), run by the service
`aurelm-airplay-probe` in its receiver test. The renderer (`renderer/mgu_renderer.c`) replaces UxPlay's GStreamer renderers: it reports what the iPhone sends
(client, codec and size, frames, frame rate, bit rate, keyframes, sound packets, pictures decoded) on stdout as
`MGU {json}` lines and, **stage 2**, hands every access unit to the GPU decoder (`video/`, see its README), which writes
the pictures to mgu-render's frame file. No sound yet (stage 3).

| | |
|---|---|
| `UXPLAY_REV` | the UxPlay commit built ([FDH2/UxPlay](https://github.com/FDH2/UxPlay), UxPlay 1.74) |
| `patch.py` | the changes to it: model `AppleTV5,4` and version `366.0` (iOS 27 sends the mirrored picture during CarPlay only to a receiver that presents itself so; found 2026-11-08), and the mDNS address from `UXPLAY_MDNS_IPV4` with `UXPLAY_MDNS_NO_IPV6` (the head unit has several interfaces) |
| `renderer/mgu_renderer.c` | the renderer API without GStreamer |
| `Makefile`, `build.sh` | the build: ubuntu:18.04 (glibc 2.27, as the unit) in Docker; libplist 2.6.0 from its release, OpenSSL 1.1.1, GLib and PCRE linked statically. The binary needs only glibc (2.25 at most) and asks for the unit's loader, `/lib/ld-linux-x86-64.so.2` (the unit has no `/lib64`: 0.6.0 asked for `/lib64/...` and did not start, ENOENT); `build.sh` checks it and starts it in ubuntu:18.04 with the loader there |

```sh
sh native/uxplay-mgu/build.sh    # -> native/uxplay-mgu/build/uxplay-mgu (needs git, python3, Docker)
python3 tools/pack_tools.py      # packs it into the aurelm-airplay-probe tool
```

The service runs it as `uxplay-mgu -n "BMW iDrive" -nh -p 7300 -m <deviceid>`, as nobody, with
`UXPLAY_MDNS_IPV4=<the car's Wi-Fi address>`: tcp and udp 7300-7302 (tcp 7000 is the car's own CarPlay
receiver's).

**License.** UxPlay is GPL-3.0 (its `LICENSE` ships with the tool as `UXPLAY-LICENSE`); this folder is
GPL-3.0-or-later. The binary in the tool is built from the commit in `UXPLAY_REV` with the changes above,
all in this repository.
