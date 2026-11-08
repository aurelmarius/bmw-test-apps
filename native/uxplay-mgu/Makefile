# Builds uxplay-mgu inside ubuntu:18.04 (glibc 2.27, the head unit's): build.sh runs it.
# UxPlay's protocol library (lib/) and uxplay.cpp, with renderer/mgu_renderer.c in place of the GStreamer
# renderers. OpenSSL, libplist, GLib and PCRE are linked statically, libstdc++ and libgcc too: the binary
# needs only the unit's glibc. libplist 2.6 comes from its release (build.sh), not 18.04's 2.0.
SRC     ?= src
OUT     ?= out
CC      = gcc
CXX     = g++
DEFS    = -DSTANDALONE -D__STDC_CONSTANT_MACROS -D__STDC_LIMIT_MACROS -DTARGET_POSIX -D_LINUX -D_REENTRANT \
          -D_LARGEFILE64_SOURCE -D_FILE_OFFSET_BITS=64 -DNOHOLD -DOPENSSL_API_COMPAT=0x10101000L \
          -DNEED_G_STRING_REPLACE -DFULL_RANGE_RGB_FIX -DPLIST_210 -DPLIST_230
GLIB_CFLAGS := $(shell pkg-config --cflags glib-2.0)
PLIST   ?= /usr
PLIST_CFLAGS := -I$(PLIST)/include
INC     = -I$(SRC) -I$(SRC)/lib -I$(SRC)/lib/playfair -I$(SRC)/lib/llhttp -I$(SRC)/lib/mdnsd $(GLIB_CFLAGS) $(PLIST_CFLAGS)
CFLAGS  = -O2 -g0 -fPIC -Wall -Wno-unused-function -std=gnu99 $(DEFS) $(INC)
CXXFLAGS= -O2 -g0 -Wall -std=gnu++11 $(DEFS) $(INC)

C_SRCS  = $(wildcard $(SRC)/lib/*.c) $(wildcard $(SRC)/lib/playfair/*.c) $(wildcard $(SRC)/lib/llhttp/*.c) \
          $(wildcard $(SRC)/lib/mdnsd/*.c) renderer/mgu_renderer.c
C_OBJS  = $(patsubst %.c,$(OUT)/obj/%.o,$(notdir $(C_SRCS)))

STATIC  = -Wl,-Bstatic -L$(PLIST)/lib -lplist-2.0 -lglib-2.0 -lpcre -lcrypto -Wl,-Bdynamic
LIBS    = $(STATIC) -lpthread -ldl -lm -static-libstdc++ -static-libgcc

vpath %.c $(SRC)/lib $(SRC)/lib/playfair $(SRC)/lib/llhttp $(SRC)/lib/mdnsd renderer

all: $(OUT)/uxplay-mgu

$(OUT)/obj/%.o: %.c
	@mkdir -p $(OUT)/obj
	$(CC) $(CFLAGS) -c $< -o $@

$(OUT)/obj/mgu_renderer.o: renderer/mgu_renderer.c
	@mkdir -p $(OUT)/obj
	$(CC) $(CFLAGS) -I$(SRC)/renderers -c $< -o $@

$(OUT)/obj/uxplay.o: $(SRC)/uxplay.cpp
	@mkdir -p $(OUT)/obj
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(OUT)/uxplay-mgu: $(C_OBJS) $(OUT)/obj/uxplay.o
	$(CXX) -o $@ $(OUT)/obj/uxplay.o $(C_OBJS) $(LIBS)
	strip $@
