'use strict';
/**
 * probe.js - what the car offers a music player (for a Music Assistant client): the monitors that run all the time
 * the service runs, and the tests the app starts.
 *
 * Monitors (every field and event, each change logged with its time):
 *   wheel     controlelements.SteeringWheelPushButton: skip left / right (statusSearchSwitch1), the knurled wheel, the
 *             star (FAV), voice, phone, volume
 *   source    entertainment.mediasource.MediaSource (activeSourceId, sources) and hmi.hmimediastate.HmiMediaState
 *             (what the HMI shows as playing: playerMetadata, coverArt, trackProgress...)
 *   players   entertainment.mediaplayer.MediaPlayer, instances CarLifeMedia and OapGenericMedia (state, metadata,
 *             button forwarding and its event buttonEventForward)
 *   carlife   a4a.baiducarlife: CarLifeMp (the bridge between CarLife and BMW's media: metadata, play state, device,
 *             sendButtonEvent) and BaiduCarLifeManager (sessionActive...)
 *   routes    the audio manager's main connections
 *
 * Tests (a second press undoes one that stays on):
 *   env        the binding (does it offer services too?), the configs, the unit's tools, the SDK's provider calls
 *   route287   source 287 (CarLife) to the speakers, with a test tone if the unit has aplay
 *   carlife    writes CarLifeMp's fields (device, metadata, play state, time): does the widget / cluster show them?
 *   forward    configureButtonEventForwarding on CarLifeMedia and OapGenericMedia: do the wheel's buttons come here?
 *   p_*        source 1046 (MediaPlayer OapGenericMedia, as RideTube): playFile with an MP3 / M4A / AAC with tags, a
 *              file that grows, a named pipe, an http:// stream that never ends and one with a length
 *   stopall    everything undone: routes, forwarding, CarLife's fields as they were, feeds, tone
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const feeds = require('./feeds');
const { createRoutes, CARLIFE, OAP, AM, AMR } = require('./routes');

const IF = {
    WHEEL: 'de.bmw.infotainment.controlelements.SteeringWheelPushButton',
    MSRC: 'de.bmw.infotainment.entertainment.mediasource.MediaSource',
    HMS: 'de.bmw.infotainment.hmi.hmimediastate.HmiMediaState',
    MP: 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer',
    CLMP: 'de.bmw.infotainment.a4a.baiducarlife.carlifemp.CarLifeMp',
    CLM: 'de.bmw.infotainment.a4a.baiducarlife.carlifehmi.BaiduCarLifeManager',
    AM, AMR,
};
// asked of the generator too (read only here): what may matter for a later step
const EXTRA = ['de.bmw.infotainment.entertainment.dynamicmediaplayer.DynamicMediaPlayer',
    'de.bmw.infotainment.entertainment.onlineentertainmentapp.OnlineEntertainmentApp',
    'de.bmw.infotainment.controlelements.FrontCCU'];
// fields that change every second: logged at most every 10 s
const QUIET = ['currentItemTime', 'currentItemTimeInSeconds', 'trackProgress', 'currentItemPosition', 'playerCacheStatus'];
const MONITORS = [
    { key: 'wheel', iface: IF.WHEEL, inst: '1' },
    { key: 'source', iface: IF.MSRC, inst: '1' },
    { key: 'hmi', iface: IF.HMS, inst: 'HMI_CID' },
    { key: 'carlifeMedia', iface: IF.MP, inst: 'CarLifeMedia', fields: ['playerState', 'thirdPartyMode', 'currentItemMetadata', 'currentItemPath', 'currentItemTime', 'deviceInfo', 'configureButtonEventForwarding', 'playerCapabilities'] },
    { key: 'oapMedia', iface: IF.MP, inst: 'OapGenericMedia', fields: ['playerState', 'thirdPartyMode', 'currentItemMetadata', 'currentItemPath', 'currentItemTime', 'deviceInfo', 'configureButtonEventForwarding', 'playerCapabilities'] },
    { key: 'carlifeMp', iface: IF.CLMP, inst: 'CarLifeMpInst1' },
    { key: 'carlifeMgr', iface: IF.CLM, inst: 'CarLifeManagerInst1' },
    { key: 'routes', iface: IF.AM, inst: '1', fields: ['listOfMainConnections'], events: [] },
];
const BUTTONS = ['ITEM_NEXT', 'ITEM_PREV', 'PLAY', 'PAUSE', 'STOP', 'FAST_FWD', 'FAST_BWD', 'SCAN_NEXT', 'SCAN_PREV'];
const LANG = 7695972;   // RideTube's languageCode for playFile
const HTTP_PORT = 8494;

// the wheel's fields by what they are
const WHEEL_NAMES = { statusSearchSwitch1: 'skip', statusRotarySteps: 'knurl steps', statusRotaryPress: 'knurl press', operationSteerWheelFAV: 'star',
    operationSteerWheelFC: 'FC', statusPTTButton1: 'voice', statusTelephoneButton: 'phone', statusAudioVolumeButton: 'volume',
    statusSpecialFunctionButton: 'special 1', statusSpecialFunctionButton2: 'special 2', requestSteerWheelFunctions: 'functions', statusSteerWheelFCLED: 'FC LED' };
/** a wrapper struct of one member (the wheel's fields): that member */
function unwrap(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) { const k = Object.keys(v); if (k.length === 1) return v[k[0]]; }
    return v;
}

/** a value for the log: JSON, long ones cut */
function show(v, max) {
    let s;
    try { s = JSON.stringify(v, (k, x) => (x && x.type === 'Buffer' && Array.isArray(x.data) ? '<' + x.data.length + ' bytes>' : x)); } catch (e) { s = String(v); }
    if (s === undefined) s = String(v);
    max = max || 400;
    return s.length > max ? s.slice(0, max) + '...(' + s.length + ')' : s;
}

function createProbe(o) {
    const { s, log } = o;
    const media = o.mediaDir;            // the package's test files (media/index.json)
    const playDir = o.playDir;           // 0711: the media engine (its own uid) opens files in it by name
    const now = o.now || Date.now;
    const index = (() => { try { return JSON.parse(fs.readFileSync(path.join(media, 'index.json'), 'utf8')); } catch (e) { return {}; } })();
    const routes = createRoutes({ s, log, file: path.join(o.stateDir, 'routes.json') });

    /* ---------- monitors ---------- */
    const vals = {};        // 'key.field' -> { v, at, n }
    const mon = {};         // key -> { available, error }
    const events = [];      // the last button-ish events, for the app's panel
    const counts = { wheel: 0, forward: 0 };
    function note(key, field, v, isEvent) {
        const k = key + '.' + field;
        const prev = vals[k];
        const sv = show(v, 2000);
        const same = prev && prev.s === sv;
        vals[k] = { v, s: sv, at: now(), n: (prev ? prev.n : 0) + 1, logged: prev ? prev.logged : 0 };
        if (same && !isEvent) return;
        const quiet = QUIET.indexOf(field) >= 0;
        if (quiet && prev && now() - prev.logged < 10000) return;
        vals[k].logged = now();
        log((isEvent ? 'EVENT ' : '') + key + '.' + field + ' = ' + show(v));
        // a first value (read at the start) is not a press
        if (!prev && !isEvent) return;
        if (key === 'wheel') { counts.wheel++; events.push({ at: now(), text: 'wheel ' + (WHEEL_NAMES[field] || field) + ': ' + show(unwrap(v), 120) }); }
        if (field === 'buttonEventForward') { counts.forward++; events.push({ at: now(), text: key + ' forwarded ' + show(v, 120) }); }
        while (events.length > 12) events.shift();
    }
    async function startMonitor(m) {
        const st = mon[m.key] = { iface: m.iface, inst: m.inst, available: false, error: null };
        const x = s.info(m.iface);
        if (!x) { st.error = 'not in the catalog'; log('monitor ' + m.key + ': ' + st.error); return; }
        let p;
        try { p = await s.proxy(m.iface, m.inst); }
        catch (e) { st.error = String(e.message || e); log('monitor ' + m.key + ': ' + st.error); return; }
        const fields = (m.fields || Object.keys(x.fields || {})).filter((f) => x.fields && x.fields[f]);
        const evs = m.events || Object.keys(x.events || {});
        const fetch = () => fields.forEach((f) => {
            if (!x.fields[f].getter) return;
            s.get(p, f).then((v) => note(m.key, f, v), (e) => log('monitor ' + m.key + '.' + f + ' get: ' + (e.message || e)));
        });
        await s.avail(p, (a) => {
            if (a === st.available) return;
            st.available = a;
            log('monitor ' + m.key + ' (' + m.iface.split('.').pop() + ' ' + m.inst + '): ' + (a ? 'AVAILABLE' : 'not available'));
            if (a) fetch();
        }).catch((e) => log('monitor ' + m.key + ' availability: ' + e));
        for (const f of fields) {
            if (!x.fields[f].notifier) continue;
            await s.on(p, f, (v) => note(m.key, f, v)).catch((e) => log('monitor ' + m.key + '.' + f + ' subscribe: ' + (e.message || e)));
        }
        for (const ev of evs) await s.on(p, ev, (v) => note(m.key, ev, v, true)).catch((e) => log('monitor ' + m.key + '.' + ev + ' subscribe: ' + (e.message || e)));
        if (!st.available) setTimeout(() => { if (!st.available) log('monitor ' + m.key + ': still not available after 5 s'); }, 5000);
    }
    async function startMonitors() {
        for (const m of MONITORS) await startMonitor(m);
    }
    const v = (k) => (vals[k] ? vals[k].v : undefined);

    /* ---------- tests ---------- */
    const tests = [];
    const T = {};
    function def(id, label, run, undo) { const t = { id, label, run, undo, state: 'idle', result: '', at: 0, live: null }; tests.push(t); T[id] = t; return t; }
    const done = (t, state, result) => { t.state = state; t.result = result; t.at = now(); log('TEST ' + t.id + ' ' + state + ': ' + result); };

    /* env: the binding, the configs, the unit's tools, the SDK's provider calls */
    def('env', 'Environment: SOME/IP binding, configs, tools', async (t) => {
        const ampx = await s.proxy(IF.AM, '1').catch(() => null);
        const b = s.binding(ampx);
        log('env: node ' + process.version + ', uid ' + (process.getuid ? process.getuid() : '?') + ', catalog ' + s.catalogVersion());
        log('env: config generator ' + (s.gen.error ? 'failed: ' + s.gen.error : s.gen.count + ' configs'));
        log('env: binding ' + b.module + ' exports ' + show(b.exports, 1500));
        log('env: a proxy has ' + b.proxy.join(', '));
        const tools = ['aplay', 'mkfifo', 'ffmpeg', 'busybox', 'amixer', 'pactl'].map((n) => n + '=' + (which(n) || '-'));
        log('env: tools ' + tools.join(' '));
        const usb = usbMounts();
        log('env: removable storage ' + (usb.length ? usb.join(', ') : 'none mounted'));
        const sdk = scanSdk(log);
        const provider = Object.keys(b.exports).filter((k) => /stub|skeleton|service|provider|offer|register/i.test(k));
        done(t, 'ok', 'binding: ' + Object.keys(b.exports).join(', ') + (provider.length ? ' | provider-like: ' + provider.join(', ') : ' | no provider-like export') +
            ' | SDK: ' + sdk + ' | ' + tools.filter((x) => !/=-$/.test(x)).map((x) => x.split('=')[0]).join(' '));
    });

    /* 287 to the speakers (+ a tone) */
    let tone = null;
    def('route287', 'Source 287 (CarLife) to the speakers, test tone', async (t) => {
        const r = await routes.connect(CARLIFE);
        if (!r.ok) return done(t, 'bad', r.detail);
        let toneSay = '';
        if (index['tone48.wav']) {
            tone = startTone(path.join(media, 'tone48.wav'), (m) => { toneSay = m; log('tone: ' + m); });
        }
        t.live = () => 'route ' + r.detail + (toneSay ? '; tone: ' + toneSay : '') + ' | active source ' + show(v('source.activeSourceId'), 60) + ' | HMI ' + show(v('hmi.playerMetadata'), 140);
        done(t, 'on', r.detail);
    }, async (t) => {
        if (tone) { tone.stop(); tone = null; }
        const r = await routes.disconnect(CARLIFE);
        t.live = null;
        done(t, 'idle', r.detail);
    });

    /* CarLifeMp's fields written: device, metadata, state, time */
    let clOrig = null, clTimer = null, clRun = 0;
    const STATUS = [1, 2, 0, 3];
    def('carlife', 'CarLife: write metadata, device, play state (CarLifeMp)', async (t) => {
        const p = await s.proxy(IF.CLMP, 'CarLifeMpInst1');
        if (!s.isAvailable(p)) log('carlife: CarLifeMp is not available (no CarLife component offers it): the writes go nowhere');
        const status = STATUS[clRun++ % STATUS.length];
        if (!clOrig) {
            clOrig = {};
            for (const f of ['deviceInfo', 'currentItemMetadata', 'playState', 'currentItemTimeInSeconds']) {
                clOrig[f] = await s.get(p, f).catch((e) => { log('carlife: read ' + f + ': ' + (e.message || e)); return undefined; });
            }
            log('carlife: as it was ' + show(clOrig, 1500));
        }
        const art = copyToPlay('cover.png');
        const writes = [
            ['deviceInfo', { deviceId: 1, sourceId: CARLIFE, name: 'Media Probe', status }],
            ['currentItemMetadata', { source: 'Music Assistant', song: 'Media Probe song', artist: 'Media Probe artist', album: 'Media Probe album',
                albumArt: art || '', duration: 180, playlistNum: 1, songId: 'probe-1', mode: 'PLAYMODE_REPEAT_ALL' }],
            ['playState', 'PLAYSTATE_PLAYING'],
            ['currentItemTimeInSeconds', 0],
        ];
        const out = [];
        for (const w of writes) {
            const r = await s.set(p, w[0], w[1]).then((x) => 'ok ' + show(x, 80), (e) => 'error ' + (e.message || e));
            log('carlife: set ' + w[0] + ' ' + show(w[1]) + ' -> ' + r);
            out.push(w[0] + ' ' + r);
        }
        let sec = 0;
        clearInterval(clTimer);
        clTimer = setInterval(() => { sec++; if (sec > 180) { clearInterval(clTimer); return; } s.set(p, 'currentItemTimeInSeconds', sec).catch(() => {}); }, 1000);
        t.live = () => 'status ' + status + ' | ' + out.join('; ') + ' | CarLifeMedia ' + show(v('carlifeMedia.currentItemMetadata'), 120) + ' | HMI ' + show(v('hmi.playerMetadata'), 120);
        done(t, out.every((x) => / ok/.test(x)) ? 'on' : 'bad', 'deviceInfo.status ' + status + ': ' + out.join('; ') + ' (press again: as it was; then again: status ' + STATUS[clRun % STATUS.length] + ')');
    }, async (t) => {
        clearInterval(clTimer);
        t.live = null;
        if (!clOrig) return done(t, 'idle', 'nothing to restore');
        const p = await s.proxy(IF.CLMP, 'CarLifeMpInst1');
        const out = [];
        for (const f of Object.keys(clOrig)) {
            if (clOrig[f] === undefined) continue;
            out.push(f + ' ' + await s.set(p, f, clOrig[f]).then(() => 'restored', (e) => 'error ' + (e.message || e)));
        }
        clOrig = null;
        done(t, 'idle', out.join('; ') || 'nothing read before, nothing restored');
    });

    /* button forwarding on both players */
    let fwOrig = null;
    def('forward', 'Button forwarding on CarLifeMedia + OapGenericMedia', async (t) => {
        fwOrig = {};
        const out = [];
        for (const inst of ['CarLifeMedia', 'OapGenericMedia']) {
            const p = await s.proxy(IF.MP, inst);
            fwOrig[inst] = await s.get(p, 'configureButtonEventForwarding').catch((e) => { log('forward: read ' + inst + ': ' + (e.message || e)); return undefined; });
            const r = await s.set(p, 'configureButtonEventForwarding', BUTTONS).then((x) => 'ok ' + show(x, 80), (e) => 'error ' + (e.message || e));
            log('forward: ' + inst + ' was ' + show(fwOrig[inst]) + ', set ' + BUTTONS.join(',') + ' -> ' + r);
            out.push(inst + ' ' + r);
        }
        const c0 = counts.forward;
        t.live = () => out.join('; ') + ' | forwarded since: ' + (counts.forward - c0) + (events.length ? ' | last: ' + events[events.length - 1].text : '');
        done(t, out.some((x) => / ok/.test(x)) ? 'on' : 'bad', out.join('; ') + ' (now press the wheel\'s buttons)');
    }, async (t) => {
        t.live = null;
        const out = [];
        for (const inst of Object.keys(fwOrig || {})) {
            const p = await s.proxy(IF.MP, inst);
            const was = fwOrig[inst] === undefined ? [] : fwOrig[inst];
            out.push(inst + ' ' + await s.set(p, 'configureButtonEventForwarding', was).then(() => 'restored ' + show(was, 60), (e) => 'error ' + (e.message || e)));
        }
        fwOrig = null;
        done(t, 'idle', out.join('; ') || 'nothing to restore');
    });

    /* 1046: the BMW MediaPlayer for online apps (one test at a time) */
    let cur = null;   // { t, feed, started, maxElapsed }
    async function oap() { return s.proxy(IF.MP, 'OapGenericMedia'); }
    async function end1046(why) {
        const c = cur;
        cur = null;
        if (!c) return;
        if (c.feed) c.feed.stop();
        const p = await oap().catch(() => null);
        if (p) log('1046: STOP ' + show(await s.call(p, 'sendButtonEvent', { button: 'STOP', action: 'PRESS' }, 3000).catch((e) => String(e))));
        c.t.live = null;
        if (c.t.state === 'on' || c.t.state === 'running') done(c.t, 'idle', 'stopped (' + why + '); ' + verdict(c));
    }
    function verdict(c) {
        const el = c.maxElapsed;
        return 'played to ' + (el / 1000).toFixed(1) + ' s' + (c.startSec ? ' (first written: ' + c.startSec + ' s)' : '') +
            ', state ' + show(v('oapMedia.playerState'), 40) + (c.error ? ', error ' + c.error : '');
    }
    function play1046(id, label, prepare) {
        def(id, label, async (t) => {
            await end1046('another 1046 test');
            const r = await routes.connect(OAP);
            if (!r.ok) return done(t, 'bad', r.detail);
            let target;
            const c = { t, feed: null, started: now(), maxElapsed: 0, startSec: 0, error: null };
            try { playFolder(); target = prepare(c); }
            catch (e) { return done(t, 'bad', String(e.message || e)); }
            if (c.feed && c.feed.error) return done(t, 'bad', c.feed.error);
            cur = c;
            const p = await oap();
            const pr = await s.call(p, 'playFile', { path: target, languageCode: LANG }).then((x) => x, (e) => ({ error: String(e.message || e) }));
            log('1046: playFile ' + target + ' -> ' + show(pr));
            t.live = () => 'playFile ' + show(pr, 80) + ' | ' + verdict(c) + ' | metadata ' + show(v('oapMedia.currentItemMetadata'), 160) +
                ' | HMI ' + show(v('hmi.playerMetadata'), 100) + (c.feed && c.feed.state ? ' | feed ' + show(c.feed.state(), 160) : '');
            done(t, pr && pr.EntError === 'OK' ? 'on' : 'bad', 'playFile ' + show(pr, 120));
        }, async () => end1046('pressed again'));
    }
    const fileIn = (name) => { const f = copyToPlay(name); if (!f) throw new Error('no ' + name + ' in the package'); return f; };
    play1046('p_mp3', '1046: MP3 file with ID3 tags + cover', () => fileIn('probe.mp3'));
    play1046('p_m4a', '1046: M4A (AAC) file with tags + cover', () => fileIn('probe.m4a'));
    play1046('p_aac', '1046: AAC ADTS file (.aac)', () => fileIn('probe.aac'));
    play1046('p_grow', '1046: MP3 that grows while it plays', (c) => {
        const src = srcOf('live.mp3');
        const dst = path.join(playDir, 'growing.mp3');
        c.startSec = 5;
        c.feed = feeds.growing(src, dst, { startSec: c.startSec, log });
        return dst;
    });
    play1046('p_fifo', '1046: named pipe (FIFO), never ends', (c) => {
        const dst = path.join(playDir, 'pipe.mp3');
        c.feed = feeds.fifo(srcOf('live.mp3'), dst, { log });
        return dst;
    });
    play1046('p_live', '1046: http://127.0.0.1 stream, never ends', (c) => {
        c.feed = feeds.http(srcOf('live.mp3'), { port: HTTP_PORT, log });
        return 'http://127.0.0.1:' + HTTP_PORT + '/live.mp3';
    });
    play1046('p_http', '1046: http://127.0.0.1 file with its length', (c) => {
        c.feed = feeds.http(srcOf('live.mp3'), { port: HTTP_PORT, log });
        return 'http://127.0.0.1:' + HTTP_PORT + '/file.mp3';
    });

    def('stopall', 'Stop all: routes, forwarding, CarLife as it was', async (t) => {
        await stopAll('Stop all');
        done(t, 'ok', 'all undone');
    });

    // the 1046 player's time: how far a test played
    setInterval(() => {
        if (!cur) return;
        const ti = v('oapMedia.currentItemTime');
        const el = ti && typeof ti.elapsed === 'number' ? ti.elapsed : null;
        if (el != null && vals['oapMedia.currentItemTime'].at >= cur.started) cur.maxElapsed = Math.max(cur.maxElapsed, el);
        const er = vals['oapMedia.playbackErrorEvent'];
        if (er && er.at >= cur.started) cur.error = show(er.v, 100);
    }, 500);

    /* ---------- helpers ---------- */
    function srcOf(name) {
        const i = index[name];
        if (!i) throw new Error('no ' + name + ' in the package');
        return { path: path.join(media, name), bytes: i.bytes, seconds: i.seconds };
    }
    function playFolder() {
        try { fs.mkdirSync(playDir, 0o711); } catch (e) { /* there */ }
        fs.chmodSync(playDir, 0o711);
    }
    function copyToPlay(name) {
        try {
            playFolder();
            const dst = path.join(playDir, name);
            fs.writeFileSync(dst, fs.readFileSync(path.join(media, name)));
            fs.chmodSync(dst, 0o644);
            return dst;
        } catch (e) { log('copy ' + name + ': ' + e.message); return null; }
    }
    function startTone(file, say) {
        let child;
        try { child = cp.spawn(process.execPath, [path.join(__dirname, 'tone.js'), file], { stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (e) { say('did not start: ' + e.message); return { stop() {} }; }
        let buf = '';
        child.stdout.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i); buf = buf.slice(i + 1);
                try { const m = JSON.parse(line); say(m.ev === 'error' ? m.error : m.ev === 'playing' ? 'playing with ' + m.aplay + ' on ' + m.device : show(m, 120)); } catch (e) { say(line); }
            }
        });
        child.stderr.on('data', (d) => log('tone stderr: ' + String(d).trim()));
        child.on('exit', (code) => { if (code) say('ended ' + code); });
        return { stop() { try { child.kill('SIGTERM'); } catch (e) { /* gone */ } } };
    }

    async function run(id) {
        const t = T[id];
        if (!t) return 'no test ' + id;
        if (t.state === 'running') return 'already running';
        const undo = t.state === 'on' && t.undo;
        t.state = 'running';
        t.result = undo ? 'undoing...' : 'running...';
        try { await (undo ? t.undo(t) : t.run(t)); }
        catch (e) { done(t, 'bad', String(e && e.message || e)); }
        if (t.state === 'running') done(t, undo ? 'idle' : 'ok', undo ? 'undone' : t.result);
        return t.result;
    }
    async function stopAll(why) {
        log('stop all (' + why + ')');
        for (const t of tests) {
            if (t.state === 'on' && t.undo) { try { await t.undo(t); } catch (e) { log('undo ' + t.id + ': ' + (e.message || e)); } }
        }
        await end1046(why).catch(() => {});
        await routes.disconnect(OAP).catch(() => {});
        await routes.disconnect(CARLIFE).catch(() => {});
        if (tone) { tone.stop(); tone = null; }
    }
    const active = () => tests.some((t) => t.state === 'on') || !!cur;

    /** the app's panel: the last wheel / forwarded events, the active source, CarLife, the 1046 player */
    function panel() {
        const m = (k) => (mon[k] ? (mon[k].available ? 'available' : mon[k].error || 'not available') : '-');
        return {
            wheel: { monitor: m('wheel'), count: counts.wheel, skip: show(unwrap(v('wheel.statusSearchSwitch1')), 120) },
            forwarded: counts.forward,
            events: events.slice(-6).map((e) => ({ at: e.at, text: e.text })),
            source: show(v('source.activeSourceId'), 80),
            hmi: show(v('hmi.playerMetadata'), 200),
            carlifeMp: m('carlifeMp') + ', device ' + show(v('carlifeMp.deviceInfo'), 120),
            carlifeMgr: m('carlifeMgr') + ', session ' + show(v('carlifeMgr.sessionActive'), 20),
            oap: show(v('oapMedia.playerState'), 40) + ' ' + show(v('oapMedia.currentItemTime'), 60),
            routes: routes.state(),
            monitors: Object.keys(mon).map((k) => k + ':' + (mon[k].available ? 'up' : mon[k].error ? 'error' : 'down')).join(' '),
        };
    }
    function testList() {
        return tests.map((t) => ({ id: t.id, label: t.label, state: t.state, result: t.live && t.state === 'on' ? safe(t.live) : t.result, undo: !!t.undo }));
    }
    const safe = (fn) => { try { return fn(); } catch (e) { return String(e.message || e); } };

    async function start() {
        s.prepare(MONITORS.map((m) => m.iface).concat([IF.AMR], EXTRA), {});
        await routes.leftovers().catch((e) => log('route leftovers: ' + (e.message || e)));
        await startMonitors();
        await run('env');
    }
    return { start, run, stopAll, active, panel, testList, vals: () => vals, monitors: () => mon, tests };
}

function which(name) {
    const dirs = (process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':');
    for (const d of dirs) { try { fs.accessSync(d + '/' + name, fs.constants.X_OK); return d + '/' + name; } catch (e) { /* next */ } }
    return null;
}

/** mounted removable storage (vfat, exfat, ntfs), writable: where the report is copied */
function usbMounts() {
    let m = '';
    try { m = fs.readFileSync('/proc/mounts', 'utf8'); } catch (e) { return []; }
    return m.split('\n').map((l) => l.split(' ')).filter((x) => x.length > 3 && /^(vfat|exfat|ntfs|fuseblk|msdos)$/.test(x[2]) && /(^|,)rw(,|$)/.test(x[3]))
        .map((x) => x[1].replace(/\\040/g, ' '));
}

/**
 * The SDK's (and MainApp's) JavaScript, searched for how the binding offers a service: next to each buildProxy
 * the binding's other calls show. Logs what it finds; returns a one-line summary.
 */
function scanSdk(log) {
    const roots = ['/usr/lib/oap-mainapp', '/usr/lib/node_modules', '/var/opt/public/oap'];
    const files = [];
    const walk = (d, depth) => {
        if (files.length >= 600 || depth > 9) return;
        let ents = [];
        try { ents = fs.readdirSync(d); } catch (e) { return; }
        for (const n of ents) {
            const f = path.join(d, n);
            let st;
            try { st = fs.lstatSync(f); } catch (e) { continue; }
            if (st.isDirectory()) { if (!/^(data|rhmiData|resources|fonts|images|\.git)$/.test(n)) walk(f, depth + 1); }
            else if (/\.js$/.test(n) && st.size < 12 * 1024 * 1024) files.push(f);
        }
    };
    roots.forEach((r) => walk(r, 0));
    const names = {};
    const snippets = [];
    const RX = /\b(build(?:Stub|Skeleton|Service|Provider)|createStub|createSkeleton|offerService|stopOfferService|registerService|offerEvent|offerField|fireEvent|fireSelectiveEvent|notifyEvent|setFieldValue|registerMethod|registerRequestHandler)\b/g;
    for (const f of files) {
        let txt;
        try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
        if (txt.indexOf('buildProxy') < 0 && !RX.test(txt)) { RX.lastIndex = 0; continue; }
        RX.lastIndex = 0;
        let mm;
        while ((mm = RX.exec(txt))) {
            names[mm[1]] = (names[mm[1]] || 0) + 1;
            if (snippets.length < 12) snippets.push(f + ': ...' + txt.slice(Math.max(0, mm.index - 140), mm.index + 160).replace(/\s+/g, ' ') + '...');
        }
        const bp = txt.indexOf('buildProxy');
        if (bp >= 0 && snippets.length < 16) snippets.push(f + ' (buildProxy): ...' + txt.slice(Math.max(0, bp - 200), bp + 300).replace(/\s+/g, ' ') + '...');
    }
    log('env: SDK scan: ' + files.length + ' files; provider-like calls ' + show(names, 600));
    snippets.forEach((x) => log('env: SDK ' + x.slice(0, 700)));
    const k = Object.keys(names);
    return files.length + ' JS files, ' + (k.length ? k.map((n) => n + ' x' + names[n]).join(', ') : 'no provider-like calls');
}

module.exports = { createProbe, show, usbMounts, which, IF, MONITORS, BUTTONS, HTTP_PORT };
