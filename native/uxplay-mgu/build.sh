#!/bin/sh
# Builds build/uxplay-mgu for the head unit: UxPlay at UXPLAY_REV, patched (patch.py), compiled in
# ubuntu:18.04 (glibc 2.27, as the unit) with renderer/mgu_renderer.c. Needs git, python3 and Docker.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
rev=$(cat "$here/UXPLAY_REV")
work="$here/build"
mkdir -p "$work"
if [ ! -d "$work/src/.git" ] || [ "$(git -C "$work/src" rev-parse HEAD 2>/dev/null)" != "$rev" ]; then
    rm -rf "$work/src"
    git init -q "$work/src"
    git -C "$work/src" remote add origin https://github.com/FDH2/UxPlay
    git -C "$work/src" fetch -q --depth 1 origin "$rev"
    git -C "$work/src" checkout -q FETCH_HEAD
fi
git -C "$work/src" checkout -q -- .
python3 "$here/patch.py" "$work/src"
# libplist: UxPlay needs 2.1 or later (18.04 has 2.0); built from its release, statically
plist=libplist-2.6.0
plist_sha=67be9ee3169366589c92dc7c22809b90f51911dd9de22520c39c9a64fb047c9c
mkdir -p "$work/dl"
[ -f "$work/dl/$plist.tar.bz2" ] || curl -sSfL -o "$work/dl/$plist.tar.bz2" "https://github.com/libimobiledevice/libplist/releases/download/2.6.0/$plist.tar.bz2"
echo "$plist_sha  $work/dl/$plist.tar.bz2" | sha256sum -c -
docker run --rm -v "$here:/w" -w /w ubuntu:18.04 sh -c '
    set -e
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null
    apt-get install -y -qq --no-install-recommends build-essential pkg-config libssl-dev libplist-dev libglib2.0-dev libpcre3-dev >/dev/null
    if [ ! -f build/plist/lib/libplist-2.0.a ]; then
        rm -rf build/plist-src && mkdir -p build/plist-src && tar -xjf build/dl/libplist-2.6.0.tar.bz2 -C build/plist-src --strip-components 1
        (cd build/plist-src && ./configure -q --prefix=/w/build/plist --enable-static --disable-shared --without-cython --without-tests >/dev/null && make -s -j"$(nproc)" >/dev/null && make -s install >/dev/null)
    fi
    make -s SRC=build/src OUT=build/out PLIST=/w/build/plist -j"$(nproc)"
    chown -R '"$(id -u):$(id -g)"' build
'
cp "$work/out/uxplay-mgu" "$work/uxplay-mgu"
cp "$work/src/LICENSE" "$work/UXPLAY-LICENSE"
file "$work/uxplay-mgu" 2>/dev/null || true
ls -l "$work/uxplay-mgu"
