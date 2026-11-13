#!/bin/sh
# Builds build/ma-player for the head unit (x86_64, glibc 2.27; the binary asks for 2.25 at most, as Emby's player)
# with zig's C compiler, which targets a glibc version exactly: no Docker needed. libopus 1.5.2 (Xiph, BSD) is
# compiled in; libasound is opened at run time. Also build/ma-player-host, for this machine (the tests).
#
#   sh native/ma-player/build.sh      (needs git, python3; zig comes from PyPI's ziglang into build/venv)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work="$here/build"
mkdir -p "$work"
opus_rev=ddbe48383984d56acd9e1ab6a090c54ca6b735a6
if [ "$(git -C "$work/opus" rev-parse HEAD 2>/dev/null)" != "$opus_rev" ]; then
    rm -rf "$work/opus"
    git -c advice.detachedHead=false clone -q --depth 1 --branch v1.5.2 https://github.com/xiph/opus "$work/opus"
    [ "$(git -C "$work/opus" rev-parse HEAD)" = "$opus_rev" ] || { echo "build.sh: opus v1.5.2 is not $opus_rev" >&2; exit 1; }
fi
if [ ! -x "$work/venv/bin/python" ]; then python3 -m venv "$work/venv"; "$work/venv/bin/pip" install -q "ziglang==0.15.1"; fi
zig="$work/venv/bin/python -m ziglang"
# libopus's own source lists (float build, no SIMD-specific files)
srcs=$(cd "$work/opus" && python3 - <<'P'
import re
v = {}
for f in ('celt_sources.mk', 'silk_sources.mk', 'opus_sources.mk'):
    t = open(f).read().replace('\\\n', ' ')
    for m in re.finditer(r'^(\w+)\s*=\s*(.*)$', t, re.M):
        v[m.group(1)] = m.group(2).split()
print(' '.join(v['CELT_SOURCES'] + v['SILK_SOURCES'] + v['SILK_SOURCES_FLOAT'] + v['OPUS_SOURCES'] + v['OPUS_SOURCES_FLOAT']))
P
)
cflags="-O2 -DOPUS_BUILD -DUSE_ALLOCA -DHAVE_LRINTF -DHAVE_LRINT -DNDEBUG -I$work/opus/include -I$work/opus/celt -I$work/opus/silk -I$work/opus/silk/float -I$work/opus"
build() {   # $1 out, $2.. target flags
    out=$1; shift
    obj="$work/obj-$(basename "$out")"; mkdir -p "$obj"
    for s in $srcs; do
        o="$obj/$(echo "$s" | tr / _).o"
        [ -f "$o" ] || $zig cc "$@" $cflags -w -c "$work/opus/$s" -o "$o"
    done
    $zig cc "$@" $cflags -Wall -c "$here/src/ma-player.c" -o "$obj/ma-player.o"
    $zig cc "$@" -s -o "$out" "$obj"/*.o -ldl -lm
}
build "$work/ma-player" -target x86_64-linux-gnu.2.25 -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2
build "$work/ma-player-host" -target native
# the unit has only /lib/ld-linux-x86-64.so.2 (no /lib64)
interp=$(readelf -l "$work/ma-player" | sed -n 's/.*Requesting program interpreter: \(.*\)]/\1/p')
[ "$interp" = "/lib/ld-linux-x86-64.so.2" ] || { echo "build.sh: interpreter is '$interp'" >&2; exit 1; }
newest=$(objdump -T "$work/ma-player" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)
case "$newest" in GLIBC_2.2[6-9]*|GLIBC_2.[3-9]*) echo "build.sh: needs $newest" >&2; exit 1;; esac
needed=$(readelf -d "$work/ma-player" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | tr '\n' ' ')
for n in $needed; do case "$n" in libc.so.6|libm.so.6|libdl.so.2|libpthread.so.0) ;; *) echo "build.sh: needs $n" >&2; exit 1;; esac; done
echo "build.sh: $work/ma-player ($(wc -c < "$work/ma-player") bytes, $newest, needs $needed)"
