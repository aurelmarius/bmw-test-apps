#!/usr/bin/env python3
"""Changes to UxPlay (at UXPLAY_REV) for the head unit. Each edit must find its text exactly once.

1. lib/global.h: model AppleTV5,4 and version 366.0. iOS 27 sends the screen-mirroring video during a
   CarPlay session only to a receiver that presents itself so (found 2026-11-08 against iCarCast: with
   UxPlay's AppleTV3,2 / 220.68 the iPhone sets up audio only, stream type 96, never 110).
2. lib/mdnsd/mdnsd.c: the address mDNS announces comes from UXPLAY_MDNS_IPV4 when set (the head unit has
   several interfaces; the route to 224.0.0.251 is not the car's Wi-Fi), and UXPLAY_MDNS_NO_IPV6 leaves
   IPv6 out (the iPhone reaches the unit over IPv4 on the car's Wi-Fi).

    python3 patch.py <uxplay source folder>
"""
import os, sys

src = sys.argv[1]

def edit(rel, pairs):
    p = os.path.join(src, rel)
    s = open(p, encoding='utf-8').read()
    for a, b in pairs:
        n = s.count(a)
        if n != 1:
            sys.exit('%s: expected 1 match, found %d: %r' % (rel, n, a[:60]))
        s = s.replace(a, b)
    open(p, 'w', encoding='utf-8').write(s)
    print('patched ' + rel)

edit('lib/global.h', [
    ('#define GLOBAL_MODEL    "AppleTV3,2"', '#define GLOBAL_MODEL    "AppleTV5,4"   /* mgu: iOS 27 mirrors during CarPlay */'),
    ('#define GLOBAL_VERSION  "220.68"', '#define GLOBAL_VERSION  "366.0"       /* mgu */'),
])

edit('lib/mdnsd/mdnsd.c', [
    ('    int fd;\n    struct sockaddr_in remote;\n',
     '    int fd;\n    struct sockaddr_in remote;\n'
     '    /* mgu: the interface to announce on, given by the service */\n'
     '    const char *forced = getenv("UXPLAY_MDNS_IPV4");\n'
     '    if (forced && inet_pton(AF_INET, forced, &addr) == 1) {\n'
     '        return addr;\n'
     '    }\n'),
    ('    mdnsd->sock_fd6 = mdns_open_socket6(mdnsd->ipv6_scope_id);',
     '    mdnsd->sock_fd6 = getenv("UXPLAY_MDNS_NO_IPV6") ? -1 : mdns_open_socket6(mdnsd->ipv6_scope_id);   /* mgu */'),
])
