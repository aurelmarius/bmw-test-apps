'use strict';
/**
 * receiver.js - the AirPlay receiver, stage 1: uxplay-mgu (native/uxplay-mgu: UxPlay's protocol, its model
 * and version as iOS 27 wants them to mirror during CarPlay, a renderer that only counts), run by the
 * service while a receiver test is on.
 *
 * It runs as nobody (uid 65534) with the service's limits (no core dump, its cgroup), announces itself
 * on the one IPv4 address it is given (UXPLAY_MDNS_IPV4) and listens on tcp and udp 7300-7302. Its
 * renderer reports on stdout as "MGU {json}" lines (renderer/mgu_renderer.c); every other line is kept
 * in a short log. A receiver that exits is started again at most 3 times in a test.
 *
 * Plain Node 8.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const BASE_PORT = 7300;
// stage 2: the frame file the receiver's GPU decoder writes and the app shows (mgu-render takes it: owned by nobody)
const VIDEO_PATH = '/dev/shm/mgu-video-aurelm-airplay';
const VIDEO_SIZE = '1920x720';

/** the gid of `group` (/etc/group), or null */
function groupGid(group) {
    try {
        const l = fs.readFileSync('/etc/group', 'utf8').split('\n').find((x) => x.split(':')[0] === group);
        return l ? Number(l.split(':')[2]) : null;
    } catch (e) { return null; }
}
const PORTS = [BASE_PORT, BASE_PORT + 1, BASE_PORT + 2];   // uxplay -p 7300: tcp and udp 7300, 7301, 7302
const MAX_RESTARTS = 3;
// lines not worth keeping: UxPlay logs these every second while a client is quiet
const NOISE = /seconds since last client feedback|^\s*$|httpd didn't get response/;

function freshState() {
    return {
        running: false, pid: null, starts: 0, exit: null, error: null, ip: null, iface: null,
        client: null, video: null, videoRunning: false, audio: null, decoder: null,
        stream: { frames: 0, fps: 0, kbps: 0, idr: 0, sps: 0, audio: 0, shown: 0, decerr: 0, at: 0 },
        lines: [],
    };
}

/**
 * opts: { bin, uid (65534; null: this process's), gid (65534; the group video when there is one), home, env (more), videoPath, log, now, onChange }
 * start({ name, deviceid, ip, iface }) / stop() / state()
 */
function createReceiver(opts) {
    const o = Object.assign({ uid: 65534, gid: 65534 }, opts || {});
    const now = o.now || Date.now;
    let st = freshState(), child = null, want = null, stopping = false;

    function keep(line) {
        if (NOISE.test(line)) return;
        st.lines.push(new Date(now()).toISOString().slice(11, 19) + ' ' + line.slice(0, 200));
        if (st.lines.length > 40) st.lines.shift();
    }

    /** one "MGU {json}" line from the renderer */
    function event(j) {
        switch (j.ev) {
        case 'client':
            st.client = { model: j.model, name: j.name, at: now() };
            if (o.log) o.log('receiver: ' + (j.name || '?') + ' (' + (j.model || '?') + ') connected');
            break;
        case 'video':
            st.video = { codec: j.codec, w: j.w, h: j.h, sw: j.sw, sh: j.sh, at: now() };
            if (o.log) o.log('receiver: video ' + j.codec + ' ' + j.w + 'x' + j.h);
            break;
        case 'start': st.videoRunning = true; break;
        case 'stop':
            st.videoRunning = false;
            st.stream.fps = 0; st.stream.kbps = 0;
            if (o.log) o.log('receiver: video stopped after ' + (j.frames || 0) + ' frames');
            break;
        case 'audio':
            st.audio = { ct: j.ct, at: now() };
            if (o.log) o.log('receiver: audio stream (type ' + j.ct + ')');
            break;
        case 'stats':
            st.stream = { frames: j.frames, fps: j.fps, kbps: j.kbps, idr: j.idr, sps: j.sps, audio: j.audio, shown: j.shown || 0, decerr: j.decerr || 0, at: now() };
            break;
        case 'decoder':
            st.decoder = j.ok ? { ok: true, path: j.path, w: j.w, h: j.h, at: now() } : { ok: false, error: j.error, at: now() };
            if (o.log) o.log('receiver: GPU decoder ' + (j.ok ? 'open, ' + j.w + 'x' + j.h + ' into ' + j.path : 'failed: ' + j.error));
            break;
        default: break;
        }
        if (o.onChange) o.onChange();
    }

    function lines(stream, fn) {
        let buf = '';
        stream.setEncoding('utf8');
        stream.on('data', (d) => {
            buf += d;
            if (buf.length > 65536) buf = buf.slice(-65536);
            let i;
            while ((i = buf.indexOf('\n')) >= 0) { fn(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
        });
    }

    function onLine(line) {
        if (line.indexOf('MGU ') === 0) {
            try { event(JSON.parse(line.slice(4))); } catch (e) { keep(line); }
            return;
        }
        keep(line);
    }

    function spawn() {
        const w = want;
        if (!w) return;
        if (!fs.existsSync(o.bin)) { st.error = 'receiver binary missing: ' + o.bin; if (o.log) o.log(st.error); return; }
        const home = o.home || '/tmp';
        try { fs.mkdirSync(home); } catch (e) { /* there */ }
        try { fs.chownSync(home, o.uid, o.gid); } catch (e) { /* not root (tests) */ }
        const env = Object.assign({ HOME: home, PATH: '/usr/bin:/bin', UXPLAY_MDNS_IPV4: w.ip, UXPLAY_MDNS_NO_IPV6: '1',
            MGU_VIDEO_PATH: o.videoPath || VIDEO_PATH, MGU_VIDEO_SIZE: VIDEO_SIZE }, o.env || {});
        // -s: the size the iPhone mirrors for, the centre screen's (landscape fills it; portrait has bars either side)
        const args = ['-n', w.name, '-nh', '-p', String(BASE_PORT), '-m', w.deviceid.toLowerCase(), '-s', '1920x720@60'];
        const spawnOpts = { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] };
        // as nobody when the service is root (the car), its group video (the GPU's render node /dev/dri/renderD128 is
        // root:video; a spawned process gets no supplementary groups); uid null: as this process (the tests)
        if (o.uid != null && process.getuid && process.getuid() === 0) {
            const video = groupGid('video');
            spawnOpts.uid = o.uid;
            spawnOpts.gid = video != null ? video : o.gid;
            if (video == null && o.log) o.log('receiver: no group video: the GPU decoder will not open');
        }
        st.starts++;
        st.running = true; st.exit = null; st.error = null; st.ip = w.ip; st.iface = w.iface;
        if (o.log) o.log('receiver: starting "' + w.name + '" on ' + w.iface + ' ' + w.ip + ', tcp/udp ' + PORTS.join(','));
        try {
            child = cp.spawn(o.bin, args, spawnOpts);
        } catch (e) {
            st.running = false; st.error = 'start: ' + e.message; child = null;
            if (o.log) o.log('receiver: ' + st.error);
            return;
        }
        st.pid = child.pid;
        lines(child.stdout, onLine);
        lines(child.stderr, keep);
        const me = child;
        let ended = false;
        // a receiver that could not start (not executable for its uid, ...) gets 'error' and no 'exit'
        child.on('error', (e) => { st.error = 'start: ' + e.message + (e.code === 'ENOENT' && fs.existsSync(o.bin) ? ' (the binary is there: its program loader is missing)' : ''); if (o.log) o.log('receiver: ' + st.error); if (!me.pid) finish(null, null); });
        child.on('exit', (code, sig) => finish(code, sig));
        function finish(code, sig) {
            if (ended) return;
            ended = true;
            if (child === me) child = null;
            st.running = false; st.pid = null; st.videoRunning = false; st.stream.fps = 0; st.stream.kbps = 0;
            st.exit = { code, signal: sig, at: now() };
            removeVideo();
            if (stopping || !want) { if (me.onEnded) me.onEnded(); return; }
            if (code === null && sig === null) { st.running = false; if (o.onChange) o.onChange(); return; }   // never started: st.error says why
            st.error = 'the receiver exited (' + (sig || 'code ' + code) + ')';
            if (o.log) o.log('receiver: ' + st.error + (st.starts <= MAX_RESTARTS ? ', starting it again' : ', not again'));
            if (st.starts <= MAX_RESTARTS) setTimeout(spawn, 2000);
            if (o.onChange) o.onChange();
        }
        me.finish = finish;
    }

    function start(w) {
        stopping = false;
        st = freshState();
        want = w;
        spawn();
    }

    /** ends the receiver: SIGTERM, SIGKILL after 3 s */
    function stop() {
        stopping = true;
        want = null;
        const c = child;
        if (!c || !c.pid) { child = null; st.running = false; return Promise.resolve(); }
        return new Promise((res) => {
            const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }, 3000);
            // resolved however it ends; at worst 5 s after the SIGKILL
            const last = setTimeout(() => { if (c.finish) c.finish(null, 'SIGKILL'); res(); }, 8000);
            c.onEnded = () => { clearTimeout(t); clearTimeout(last); res(); };
            try { c.kill('SIGTERM'); } catch (e) { clearTimeout(t); clearTimeout(last); res(); }
        });
    }

    /** the frame file goes with the receiver (it removes it itself at a clean exit; this covers a crash or a kill) */
    function removeVideo() { try { fs.unlinkSync(o.videoPath || VIDEO_PATH); } catch (e) { /* none */ } }

    /** for exit: no receiver left behind, synchronously */
    function killSync() { if (child) { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } } removeVideo(); }

    return { start, stop, killSync, state: () => st };
}

module.exports = { createReceiver, PORTS, BASE_PORT, VIDEO_PATH };
