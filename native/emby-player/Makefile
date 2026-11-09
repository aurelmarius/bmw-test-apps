# Builds emby-player inside ubuntu:18.04 (glibc 2.27, the head unit's): build.sh runs it.
# player.cpp and our copy of Moonride's MSDK decoder (src/decoder_msdk.cpp: display order, fit whole), with the
# AirPlay receiver's NAL framing and frame-file writer read from native/uxplay-mgu/video (not copied, not changed),
# linked against stubs of the unit's libmfxhw64 / libva / libva-drm made from their export lists (every import is
# checked). FFmpeg (libavformat's mpegts demuxer, libavcodec's aac, ac3 and eac3 decoders) static; libasound is
# opened at run time. The binary needs only the unit's glibc and asks for its loader.
OUT     ?= out
FFMPEG  ?= /w/build/ffmpeg
VID     = ../uxplay-mgu/video
CXX     = g++
CC      = gcc
CXXFLAGS = -std=c++14 -O2 -g0 -Wall -Wno-missing-field-initializers -DNDEBUG -Isrc -I$(VID)/src -I$(VID)/abi/include -I$(FFMPEG)/include
OBJS    = $(OUT)/obj/player.o $(OUT)/obj/decoder_msdk.o $(OUT)/obj/nal_reader.o $(OUT)/obj/mgvf.o $(OUT)/obj/glibc_compat.o
STUBS   = $(OUT)/stub/libmfxhw64.so $(OUT)/stub/libva.so.1 $(OUT)/stub/libva-drm.so.1
# the head unit's loader is /lib/ld-linux-x86-64.so.2 (no /lib64)
LIBS    = $(FFMPEG)/lib/libavformat.a $(FFMPEG)/lib/libavcodec.a $(FFMPEG)/lib/libavutil.a -lpthread -ldl -lm \
          -Wl,--wrap=powf -Wl,--wrap=log2f \
          -static-libstdc++ -static-libgcc -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2

all: $(OUT)/emby-player

$(OUT)/obj/player.o: src/player.cpp src/decoder_msdk.h
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -c $< -o $@
$(OUT)/obj/decoder_msdk.o: src/decoder_msdk.cpp src/decoder_msdk.h
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -c $< -o $@
$(OUT)/obj/glibc_compat.o: src/glibc_compat.c
	@mkdir -p $(@D)
	$(CC) -O2 -c $< -o $@
$(OUT)/obj/%.o: $(VID)/src/%.cpp
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(OUT)/stub/libmfxhw64.so: $(VID)/abi/libmfx.symbols
	@mkdir -p $(@D)
	python3 $(VID)/tools/ramses_abi.py stub-source $< > $(@D)/mfx_stub.c
	$(CC) -shared -Wl,-soname,libmfxhw64.so -o $@ $(@D)/mfx_stub.c
$(OUT)/stub/libva.so.1: $(VID)/abi/libva.symbols
	@mkdir -p $(@D)
	python3 $(VID)/tools/ramses_abi.py stub-source $< > $(@D)/va_stub.c
	$(CC) -shared -Wl,-soname,libva.so.1 -o $@ $(@D)/va_stub.c
$(OUT)/stub/libva-drm.so.1: $(VID)/abi/libva-drm.symbols
	@mkdir -p $(@D)
	python3 $(VID)/tools/ramses_abi.py stub-source $< > $(@D)/va_drm_stub.c
	$(CC) -shared -Wl,-soname,libva-drm.so.1 -o $@ $(@D)/va_drm_stub.c

$(OUT)/emby-player: $(OBJS) $(STUBS)
	$(CXX) -o $@ $(OBJS) $(STUBS) $(LIBS)
	python3 $(VID)/tools/woc_abi.py check-imports $@ --prefix MFX va -- $(VID)/abi/libmfx.symbols $(VID)/abi/libva.symbols $(VID)/abi/libva-drm.symbols
	strip $@
