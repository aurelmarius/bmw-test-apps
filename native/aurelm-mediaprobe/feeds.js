'use strict';
/**
 * feeds.js - what the 1046 tests hand to the BMW MediaPlayer besides a whole file: the question is whether its
 * playFile can play something that does not end (an internet radio):
 *
 *   growing(src, dst, o)   dst gets src's first o.startSec seconds, then the rest at a little over real time; the
 *                          player is asked to play dst at once (does it read on past the end it first saw?)
 *   fifo(src, dst, o)      dst is a named pipe; src is written into it again and again, at a little over real time
 *   preallocated(src, dst, o)  dst made o.totalSec long at once (a sparse file: the size the player sees from the
 *                          start), o.head (an ID3 tag) first, src's sound again and again after it: the first o.startSec
 *                          seconds at once, the rest a little faster than it plays (0.1.2 in the car: a file that grows
 *                          was played only as far as it was when opened; does a file of its whole size play on?)
 *   http(o)                a server on 127.0.0.1: /live.mp3 never ends (src again and again, chunked, no length, as
 *                          a radio stream), /file.mp3 is src with its length; each request is logged (does the
 *                          player open a URL at all, and with which headers?)
 *
 * Each returns { stop(), state() }; src is { path, bytes, seconds }.
 */
const fs = require('fs');
const http = require('http');
const cp = require('child_process');

const AHEAD = 1.25;   // written this much faster than the sound plays
const STEP_MS = 200;

function rate(src) { return Math.max(4000, Math.round(src.bytes / Math.max(1, src.seconds))); }

function growing(src, dst, o) {
    const log = o.log;
    const data = fs.readFileSync(src.path);
    const bps = rate(src);
    let at = Math.min(data.length, Math.round(bps * (o.startSec || 5)));
    try { fs.unlinkSync(dst); } catch (e) { /* none */ }
    fs.writeFileSync(dst, data.slice(0, at), { mode: 0o644 });
    fs.chmodSync(dst, 0o644);
    log('feed: growing ' + dst + ': ' + at + ' of ' + data.length + ' bytes at once, the rest at ' + bps + ' B/s');
    const t = setInterval(() => {
        if (at >= data.length) { clearInterval(t); log('feed: growing file complete (' + data.length + ' bytes)'); return; }
        const n = Math.min(data.length - at, Math.round(bps * AHEAD * STEP_MS / 1000));
        try { fs.appendFileSync(dst, data.slice(at, at + n)); at += n; } catch (e) { log('feed: append ' + e.message); clearInterval(t); }
    }, STEP_MS);
    return { stop() { clearInterval(t); }, state: () => ({ written: at, total: data.length }) };
}

function fifo(src, dst, o) {
    const log = o.log;
    const data = fs.readFileSync(src.path);
    const bps = rate(src);
    try { fs.unlinkSync(dst); } catch (e) { /* none */ }
    try { cp.execFileSync('mkfifo', ['-m', '0644', dst], { stdio: 'ignore' }); }
    catch (e) { return { error: 'mkfifo: ' + (e.code || e.message), stop() {}, state: () => ({}) }; }
    fs.chmodSync(dst, 0o644);
    const st = { opened: false, written: 0, loops: 0, error: null };
    let fd = null, t = null, at = 0, stopped = false;
    // opening for writing waits until the player opens it for reading
    fs.open(dst, 'w', (err, f) => {
        if (stopped) { if (f != null) fs.close(f, () => {}); return; }
        if (err) { st.error = err.message; log('feed: fifo open ' + err.message); return; }
        fd = f; st.opened = true;
        log('feed: fifo ' + dst + ' opened by its reader; writing at ' + bps + ' B/s');
        // async writes (the thread pool waits when the pipe is full, never the service), one at a time
        let busy = false;
        t = setInterval(() => {
            if (busy || fd == null) return;
            const n = Math.round(bps * AHEAD * STEP_MS / 1000);
            const chunk = data.slice(at, at + n);
            at += chunk.length;
            if (at >= data.length) { at = 0; st.loops++; }
            busy = true;
            fs.write(fd, chunk, 0, chunk.length, null, (e, w) => {
                busy = false;
                if (e) { st.error = e.code || e.message; log('feed: fifo write ' + st.error + ' (the reader closed it)'); clearInterval(t); return; }
                st.written += w;
            });
        }, STEP_MS);
    });
    return {
        stop() {
            stopped = true;
            clearInterval(t);
            // a write or the open may wait in the thread pool for the reader: read the pipe dry ourselves for a moment
            try {
                const r = fs.openSync(dst, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
                const buf = Buffer.alloc(65536);
                const end = Date.now() + 400;
                const drain = () => { try { while (fs.readSync(r, buf, 0, buf.length, null) > 0) { /* dry */ } } catch (e) { /* EAGAIN: empty */ } if (Date.now() < end) setTimeout(drain, 50); else { try { fs.closeSync(r); } catch (e) { /* closed */ } } };
                drain();
            } catch (e) { /* none */ }
            if (fd != null) { const f = fd; fd = null; setTimeout(() => { try { fs.closeSync(f); } catch (e) { /* closed */ } }, 100); }
            setTimeout(() => { try { fs.unlinkSync(dst); } catch (e) { /* gone */ } }, 300);
        },
        state: () => st,
    };
}

function preallocated(src, dst, o) {
    const log = o.log;
    const data = fs.readFileSync(src.path);
    const bps = rate(src);
    const head = o.head || Buffer.alloc(0);
    const total = head.length + bps * (o.totalSec || 3600);
    try { fs.unlinkSync(dst); } catch (e) { /* none */ }
    const fd = fs.openSync(dst, 'w+', 0o644);
    fs.ftruncateSync(fd, total);
    fs.chmodSync(dst, 0o644);
    let pos = 0, at = 0;
    const put = (n) => {
        while (n > 0 && pos < total) {
            const inHead = pos < head.length;
            const buf = inHead ? head.slice(pos, Math.min(head.length, pos + n)) : data.slice(at, Math.min(data.length, at + n, at + (total - pos)));
            fs.writeSync(fd, buf, 0, buf.length, pos);
            pos += buf.length; n -= buf.length;
            if (!inHead) { at += buf.length; if (at >= data.length) at = 0; }
        }
    };
    put(head.length + bps * (o.startSec || 10));
    log('feed: preallocated ' + dst + ': ' + total + ' bytes (' + (o.totalSec || 3600) + ' s), ' + pos + ' written at once, the rest at ' + bps + ' B/s');
    // written ahead for 15 minutes at most (the test is a few minutes)
    const end = Date.now() + 15 * 60 * 1000;
    const t = setInterval(() => {
        if (pos >= total || Date.now() > end) { clearInterval(t); log('feed: preallocated file: stopped writing at ' + pos + ' bytes'); return; }
        try { put(Math.round(bps * AHEAD * STEP_MS / 1000)); } catch (e) { log('feed: preallocated write ' + e.message); clearInterval(t); }
    }, STEP_MS);
    return {
        stop() { clearInterval(t); try { fs.closeSync(fd); } catch (e) { /* closed */ } },
        state: () => ({ written: pos, total, seconds: Math.round((pos - head.length) / bps) }),
    };
}

function httpFeed(src, o) {
    const log = o.log;
    const data = fs.readFileSync(src.path);
    const bps = rate(src);
    const st = { listening: false, requests: [], error: null, port: o.port };
    const live = new Set();
    const srv = http.createServer((req, res) => {
        const r = { at: Date.now(), method: req.method, url: req.url, ua: req.headers['user-agent'] || '', range: req.headers.range || '', icy: req.headers['icy-metadata'] || '' };
        st.requests.push(r);
        if (st.requests.length > 20) st.requests.shift();
        log('feed: http ' + req.method + ' ' + req.url + ' from ' + req.socket.remoteAddress + ' UA "' + r.ua + '"' + (r.range ? ' Range ' + r.range : '') + (r.icy ? ' Icy-MetaData ' + r.icy : ''));
        if (req.url.indexOf('/file.mp3') === 0) {
            res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': data.length, 'Accept-Ranges': 'none' });
            if (req.method === 'HEAD') return res.end();
            return res.end(data);
        }
        if (req.url.indexOf('/live.mp3') === 0) {
            res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-cache', 'icy-name': 'Media Probe' });
            if (req.method === 'HEAD') return res.end();
            let at = 0, sent = 0, full = false;
            res.on('drain', () => { full = false; });
            const t = setInterval(() => {
                if (full) return;
                const n = Math.round(bps * AHEAD * STEP_MS / 1000);
                const chunk = data.slice(at, at + n);
                at += chunk.length;
                if (at >= data.length) at = 0;
                sent += chunk.length;
                if (!res.write(chunk)) full = true;
            }, STEP_MS);
            const c = { t, res };
            live.add(c);
            req.on('close', () => { clearInterval(t); live.delete(c); log('feed: http live stream closed by the reader after ' + sent + ' bytes'); });
            return undefined;
        }
        res.writeHead(404); res.end();
        return undefined;
    });
    // the last test's server may still be closing: a few tries
    let tries = 0, closed = false;
    srv.on('error', (e) => {
        if (e.code === 'EADDRINUSE' && ++tries < 8 && !closed) { setTimeout(listen, 300); return; }
        st.error = e.code || e.message; log('feed: http server ' + st.error);
    });
    const listen = () => srv.listen(o.port, '127.0.0.1', () => { st.listening = true; log('feed: http on 127.0.0.1:' + o.port + ' (/live.mp3 never ends, /file.mp3 with its length)'); });
    listen();
    return {
        stop() { closed = true; live.forEach((c) => { clearInterval(c.t); try { c.res.destroy(); } catch (e) { /* gone */ } }); live.clear(); try { srv.close(); } catch (e) { /* closed */ } },
        state: () => st,
    };
}

module.exports = { growing, fifo, preallocated, http: httpFeed, rate };
