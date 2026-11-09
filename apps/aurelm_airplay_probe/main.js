'use strict';
/**
 * AirPlay Test - can an iPhone find and reach this head unit as an AirPlay receiver?
 *
 * The screen of the AirPlay network test service (native/aurelm-airplay-probe, a root tool), for 15 minutes:
 *   "Start test"      the network test: a test receiver ("BMW iDrive test") is announced; the page shows the
 *                     network, the firewall, mDNS, the iPhone's AirPlay query and its connection;
 *   "Start receiver"  the receiver: UxPlay's protocol ("BMW iDrive") takes the iPhone's screen mirroring; its GPU
 *                     decoder writes the pictures, shown over the whole screen while the car is parked
 *                     (mirror_view.js). The iDrive controller's buttons hide it; "Start receiver" shows it again.
 *                   With the setting "AirPlay video button" (on), the receiver also takes a video sent with the AirPlay
 *                   button (YouTube): the head unit plays it itself, from the internet (mgu-uplink), shown and heard
 *                   the same way; the iPhone keeps its controls (pause, seek). iOS ends CarPlay meanwhile.
 * On the iPhone: Control Center > Screen Mirroring, or the AirPlay button in the video.
 *
 * Talks to the service over /run/aurelm-airplay-probe.sock (a JSON object per line).
 */
const net = require('net');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const fs = require('fs');
const record = require('./kit/record');
const Parked = require('./kit/parked');
const { RenderClient } = require('./mgu_render_client');
const { createMirrorView } = require('./mirror_view');
const { createCarAudio } = require('./car_audio');

const W = 1600, H = 520;
const SOCK = process.env.AIRPLAY_PROBE_SOCK || '/run/aurelm-airplay-probe.sock';
const MINUTES = 15;
// the service version this app is built with: an older one still running (its files were updated, the
// process not) is asked to end, and the socket starts the new one at the next request
const SERVICE_VERSION = '0.9.5';
const older = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };
const GREEN = '#2fd27a', AMBER = '#ffb020', RED = '#ef2b2d';

/** one request: the service's status, or null when it does not answer */
function ask(cmd, extra) {
    return new Promise((res) => {
        let buf = '', done = false;
        const end = (v) => { if (!done) { done = true; clearTimeout(t); try { c.destroy(); } catch (e) { /* gone */ } res(v); } };
        const c = net.connect(SOCK);
        const t = setTimeout(() => end(null), 4000);
        c.setEncoding('utf8');
        c.on('connect', () => c.write(JSON.stringify(Object.assign({ cmd }, extra || {})) + '\n'));
        c.on('data', (d) => {
            buf += d;
            const i = buf.indexOf('\n');
            if (i < 0) return;
            try { end(JSON.parse(buf.slice(0, i))); } catch (e) { end(null); }
        });
        c.on('error', () => end(null));
    });
}

/** words into lines no wider than w */
function wrap(cv, text, size, w, font) {
    const out = [];
    let line = '';
    String(text).split(/\s+/).forEach((word) => {
        const next = line ? line + ' ' + word : word;
        if (line && cv.textWidth(next, size, { font, literal: true }) > w) { out.push(line); line = word; } else line = next;
    });
    if (line) out.push(line);
    return out;
}
function clip(cv, s, size, w, font) {
    s = String(s);
    if (cv.textWidth(s, size, { font, literal: true }) <= w) return s;
    while (s.length > 1 && cv.textWidth(s + '...', size, { font, literal: true }) > w) s = s.slice(0, -1);
    return s + '...';
}

const ago = (t, now) => { const s = Math.max(0, Math.round((now - t) / 1000)); return s < 60 ? s + ' s ago' : Math.round(s / 60) + ' min ago'; };

/**
 * The steps, each { label, state: 'ok'|'wait'|'bad'|'off', detail }, from a status (null: no service).
 * Exported for the tests and the screenshots.
 */
/** the receiver test's steps (stage 1: does the mirrored picture reach the head unit?) */
const hms = (x) => { x = Math.max(0, Math.round(x || 0)); const h = Math.floor(x / 3600), m = Math.floor(x / 60) % 60, sec = x % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0'); };
const mb = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round((b || 0) / 1024) + ' KB';

/** stage 4: a video sent with the AirPlay button, played by the head unit (in place of the mirroring rows) */
function videoSteps(r, st, off) {
    const h = r.hls, px = r.proxy || {}, ps = px.stats || {};
    const o = h.open, e = h.ended;
    const playing = !e && o;
    const state = e ? (e.why === 'error' ? 'failed: ' + e.error : e.why === 'end' ? 'ended' : 'stopped') : !o ? 'opening...' : h.buffering ? 'loading...' : h.paused ? 'paused' : 'playing';
    return [
        { label: 'Internet', state: px.state === 'on' ? (ps.errors && !ps.bytesIn ? 'bad' : 'ok') : px.state === 'failed' ? 'bad' : off ? 'off' : 'wait',
            detail: px.state === 'on' ? mb(ps.bytesIn) + ' downloaded' + (ps.lastError ? ', last error: ' + ps.lastError : '') : px.error || px.state || '' },
        { label: 'Video', state: e && e.why === 'error' ? 'bad' : playing ? 'ok' : e ? 'off' : 'wait',
            detail: (o ? (o.vcodec ? o.vcodec.toUpperCase() + (o.w ? ' ' + o.w + 'x' + o.h : '') : 'no picture') + (o.acodec ? ' + ' + o.acodec.toUpperCase() : '') + ', ' : '') +
                state + (o ? ', ' + hms(h.pos) + (h.dur ? ' / ' + hms(h.dur) : '') : '') + (st.fps > 0 ? ', ' + st.fps + ' fps' : '') },
    ];
}

function rxSteps(s) {
    const r = s.rx || {}, fw = s.fw || {}, st = r.stream || {};
    const used = (s.ifaces || []).filter((i) => i.used);
    const off = !s.active;
    const gotVideo = !!(r.video && st.frames > 0);
    return [
        { label: 'Service', state: 'ok', detail: 'version ' + s.version + (s.active ? ', receiver running' : ', idle') },
        { label: 'Wi-Fi network', state: used.length ? 'ok' : off ? 'off' : 'bad',
            detail: used.length ? used.map((i) => i.name + ' ' + i.ip + ' (' + i.kind + ')').join(', ') : 'none: connect the iPhone with wireless CarPlay' },
        { label: 'Firewall', state: fw.state === 'open' ? 'ok' : fw.state === 'failed' ? 'bad' : off ? 'off' : 'wait',
            detail: fw.state === 'open' ? (fw.chains || []).length + ' chains open for tcp/udp ' + (r.ports || []).join(', ') + ', udp 5353' : fw.state === 'failed' ? fw.error : fw.state || '' },
        { label: 'Receiver', state: r.running ? 'ok' : r.error ? 'bad' : off ? 'off' : 'wait',
            detail: r.running ? '"' + r.name + '" on ' + r.iface + ' ' + r.ip + (r.starts > 1 ? ', started ' + r.starts + ' times' : '') : r.error || (r.exit ? 'ended' : '') },
        { label: 'iPhone connected', state: r.client || r.hls ? 'ok' : off ? 'off' : 'wait',
            detail: r.client ? (r.client.name || '?') + ' (' + (r.client.model || '?') + ')' : r.hls ? 'video sent with the AirPlay button' : 'Screen Mirroring > ' + (r.name || 'BMW iDrive') + (r.hlsOn ? ', or the AirPlay button in a video' : '') },
    ].concat(r.hls ? videoSteps(r, st, off) : [
        { label: 'Picture', state: gotVideo ? 'ok' : r.client && r.audio ? 'bad' : off ? 'off' : 'wait',
            detail: r.video ? r.video.codec + ' ' + r.video.w + 'x' + r.video.h + (st.frames ? ', ' + st.frames + ' frames, ' + st.idr + ' keyframes' : '') : r.client && r.audio ? 'none: the iPhone sends sound only' : 'not yet' },
        { label: 'Stream', state: st.fps > 0 ? 'ok' : gotVideo ? 'off' : off ? 'off' : 'wait',
            detail: st.fps > 0 ? st.fps + ' fps, ' + Math.round(st.kbps) + ' kbit/s' + (r.cpu ? ', CPU ' + r.cpu.pct + '%' + (r.cpu.throttled ? ', held back ' + r.cpu.throttled + 'x' : '') : '') : gotVideo ? 'stopped' : r.audio ? 'sound only, ' + st.audio + ' packets' : 'not yet' },
    ], [
        { label: 'GPU decoder', state: r.decoder ? (r.decoder.ok ? (st.shown > 0 ? 'ok' : 'wait') : 'bad') : off ? 'off' : 'wait',
            detail: r.decoder ? (r.decoder.ok ? st.shown + ' pictures' + (st.decerr ? ', ' + st.decerr + ' failed' : '') + ' into ' + r.decoder.w + 'x' + r.decoder.h : r.decoder.error) : 'opens with the first picture' },
        { label: 'On screen', state: s.mirror && s.mirror.shown ? 'ok' : off ? 'off' : 'wait', detail: (s.mirror && s.mirror.why) || '' },
        soundStep(r, st, s.carAudio, off),
    ]);
}

/** the sound: the receiver's decoder and device, then the route to the speakers */
function soundStep(r, st, ca, off) {
    const snd = r.sound;
    if (!snd) return { label: 'Sound', state: off ? 'off' : 'wait', detail: r.audio ? 'starting' : 'none yet' };
    if (snd.ok && !r.soundRunning) return { label: 'Sound', state: 'off', detail: 'ended by the iPhone; the speakers are back to the source before' };
    if (!snd.ok) return { label: 'Sound', state: 'bad', detail: snd.error };
    // dropped: late (the device fell behind: CPU, Wi-Fi) or full (nothing read it yet: the speakers still connecting)
    const n = st.adec ? st.adec + ' played' + (st.alate ? ', ' + st.alate + ' late' : '') + (st.afull ? ', ' + st.afull + ' unread' : '') : 'nothing played yet';
    if (ca && ca.taken) return { label: 'Sound', state: 'bad', detail: n + '; the speakers are in use by another app (Emby): stop it there' };
    if (ca && ca.error) return { label: 'Sound', state: 'bad', detail: n + '; route: ' + ca.error };
    return { label: 'Sound', state: ca && ca.connected ? 'ok' : 'wait', detail: n + (ca && ca.connected ? ', on the speakers' : ', connecting the speakers') + (st.adev >= 0 ? ' (' + Math.round(st.adev) + ' ms)' : '') };
}

function steps(s) {
    if (!s) return [{ label: 'Service', state: 'bad', detail: 'not answering: install "AirPlay network test service" from the Store' }];
    if (s.mode === 'receiver') return rxSteps(s);
    const used = (s.ifaces || []).filter((i) => i.used);
    const off = !s.active && !(s.tcp && s.tcp.connections);
    const m = s.mdns || {}, tcp = s.tcp || {}, fw = s.fw || {};
    const lq = m.lastAirplayQuery, last = tcp.last;
    return [
        { label: 'Service', state: 'ok', detail: 'version ' + s.version + (s.active ? ', test running' : ', idle') },
        { label: 'Wi-Fi network', state: used.length ? 'ok' : off ? 'off' : 'bad',
            detail: used.length ? used.map((i) => i.name + ' ' + i.ip + ' (' + i.kind + ')').join(', ') : 'none: head unit on the iPhone hotspot, or iPhone on the car Wi-Fi' },
        { label: 'Firewall', state: fw.state === 'open' ? 'ok' : fw.state === 'failed' ? 'bad' : off ? 'off' : 'wait',
            detail: fw.state === 'open' ? (fw.chains || []).length + ' chains open for tcp ' + ((tcp.listening || []).join(', ') || '-') + ', udp 5353' : fw.state === 'failed' ? fw.error : fw.state || '' },
        { label: 'mDNS', state: m.mode === 'own' ? 'ok' : m.mode === 'failed' ? 'bad' : off ? 'off' : 'wait',
            detail: m.mode === 'own' ? 'announcing "' + s.name + '", ' + m.answered + ' answers sent' : m.mode === 'failed' ? m.error + ((m.holders || []).length ? ', held by ' + m.holders.join(', ') : '') : '' },
        { label: 'Devices heard', state: (m.peers || []).length ? 'ok' : off ? 'off' : 'wait',
            detail: (m.peers || []).length ? m.peers.slice(-3).map((p) => p.ip + (p.names.length ? ' ' + p.names[0] : '')).join(', ') : 'none yet' },
        { label: 'AirPlay query', state: lq ? 'ok' : off ? 'off' : 'wait',
            detail: lq ? 'from ' + lq.ip + (lq.iface ? ' on ' + lq.iface : '') + ', ' + ago(lq.at, s.now) + ' (' + m.airplayQueries + ' in all)' : 'open Screen Mirroring on the iPhone' },
        { label: 'iPhone connected', state: last ? 'ok' : off ? 'off' : 'wait',
            detail: last ? last.ip + ' -> ' + last.port + ': ' + (last.request || '') + (last.agent ? ' (' + last.agent + ')' : '') : tcp.port ? 'tap "' + s.name + '" in Screen Mirroring (receiver on tcp ' + tcp.port + ')' : 'no free port: ' + (tcp.error || '') },
    ];
}

const VERDICT_COLOR = { connected: GREEN, asked: AMBER, 'heard-phone': AMBER, waiting: AMBER, idle: null,
    'rx-video': GREEN, 'rx-connected': AMBER, 'rx-waiting': AMBER, 'rx-hls': GREEN, 'rx-hls-opening': AMBER };

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        let st = null, busy = null, polling = false, askedExit = false;

        async function poll() {
            if (polling) return;
            polling = true;
            try {
                st = await ask('status');
                if (st && st.version && older(st.version, SERVICE_VERSION) && !st.active && !askedExit) {
                    askedExit = true;   // once: a service whose update failed is not stopped again and again
                    log.info('airplay test: service ' + st.version + ' running, ' + SERVICE_VERSION + ' installed: asking it to end');
                    busy = 'Updating the service...';
                    await ask('exit');
                    st = await ask('status');
                    busy = null;
                }
            } finally { polling = false; }
        }
        async function command(cmd, label, extra) {
            busy = label;
            const r = await ask(cmd, cmd === 'start' ? Object.assign({ minutes: MINUTES }, extra || {}) : null);
            busy = null;
            if (r) st = r;
            log.info('airplay test: ' + cmd + ' -> ' + (r ? r.verdict.code : 'no service'));
            return render();
        }
        ui.onClick('BTN_START', () => command('start', 'Starting...'));
        ui.onClick('BTN_RX', () => { mirror.wantAgain(); return command('start', 'Starting the receiver...', { mode: 'receiver', hls: ctx.settings.get('videoButton') !== false, identity: ctx.settings.get('identity') || 'carplay' }); });

        /* ---------- stage 2: the picture over the screen, parked only ---------- */
        const parked = Parked.watch(ctx, log, { strict: true });
        const mirror = createMirrorView({ RenderClient, Recorder: record.Recorder, kit: record, appId: ctx.spec.id, log,
            statIno: (p) => { const f = fs.statSync(p); return f.isFile() ? f.ino : null; } });
        // leaving the app (HOME, another app, CarPlay's tile) ends the iPhone's mirroring, so CarPlay is free at once
        // (setting endOnLeave, on): 1.5 s after the page went, once per session
        let goneAt = 0, ended = false;
        // stage 3: the speakers while the receiver has an iPhone with sound and the app is up (leaving it ends the session)
        const carAudio = createCarAudio(ctx.signals, log, { file: ctx.dataDir ? require('path').join(ctx.dataDir, 'car-audio.json') : null });
        function syncMirror() {
            const rxOn = st && st.mode === 'receiver' && st.active ? st.rx : null;
            mirror.update({ rx: rxOn, pageVisible: shown(), driving: parked.moving() });
            // the speakers while the iPhone's sound plays: stopped on the phone, they go back to the source before at once
            carAudio.want(!!(rxOn && rxOn.running && rxOn.soundRunning && shown()));
            if (shown()) { goneAt = 0; ended = false; return; }
            if (!rxOn || !rxOn.client || ended || ctx.settings.get('endOnLeave') === false) return;
            if (!goneAt) goneAt = Date.now();
            if (Date.now() - goneAt >= 1500) {
                ended = true;
                log.info('airplay: the app left the front: ending the iPhone\'s mirroring');
                ask('end-session', { why: 'the app left the front' }).then((r) => { if (r) st = r; });
            }
        }
        if (ctx.app && ctx.app.on) ctx.app.on('shutdown', () => { mirror.close(); carAudio.want(false); });
        ui.onClick('BTN_STOP', () => command('stop', 'Stopping...'));

        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const left = st && st.active ? Math.max(0, Math.round((st.endsAt - st.now) / 60000)) : null;
            G.frame(cv, t, ['AirPlay network test'], 0, [busy && { text: busy, color: 'accent' }, left != null && { text: left + ' MIN LEFT' }]);
            draw(cv, t);
            return ui.image('MAIN_GFX', cv);
        }

        function draw(cv, t) {
            const v = st ? st.verdict : { code: 'none', text: 'The AirPlay network test service does not answer. It comes with this app from the Store: restart the head unit once after installing (the service starts listening for this app at the next start).' };
            const vc = VERDICT_COLOR[v.code] || (v.code === 'idle' ? t.accent : RED);
            // verdict
            cv.fillRect(24, 58, 1552, 96, withAlpha(vc, 0.14));
            cv.fillRect(24, 58, 6, 96, vc);
            const vl = wrap(cv, v.text, 26, 1500, 'bold').slice(0, 2);
            vl.forEach((l, i) => cv.text(l, 52, 98 + i * 36 - (vl.length === 1 ? -14 : 0), 26, t.text, { font: 'bold', literal: true }));
            // steps
            if (st && st.mode === 'receiver') { st.mirror = mirror.state(); st.carAudio = carAudio.state(); }
            const rows = steps(st);
            const COL = { ok: GREEN, wait: AMBER, bad: RED, off: withAlpha('#ffffff', 0.3) };
            const rowH = rows.length > 9 ? 32 : rows.length > 7 ? 36 : 44;   // the receiver's 10 steps fit the page
            rows.forEach((r, i) => {
                const y = 190 + i * rowH;
                cv.circle(44, y - 8, 9, COL[r.state]);
                cv.text(r.label, 66, y, 22, t.text, { font: 'bold', literal: true });
                cv.text(clip(cv, r.detail || '', 20, 700, 'label'), 260, y, 20, r.state === 'off' ? t.dim : t.text, { literal: true });
            });
            // the service's log, with the receiver's own lines (the iPhone's requests, UxPlay's errors) in time order
            cv.fillRect(990, 172, 1.5, 320, withAlpha('#ffffff', 0.15));
            cv.text('LOG', 1010, 190, 18, t.dim, { font: 'bold', literal: true });
            const all = (st && st.log ? st.log : []).concat(st && st.mode === 'receiver' && st.rx && st.rx.lines ? st.rx.lines.map((l) => l.slice(0, 9) + '> ' + l.slice(9)) : []);
            const lines = all.map((l, i) => ({ l, i })).sort((a, b) => (a.l.slice(0, 8) < b.l.slice(0, 8) ? -1 : a.l.slice(0, 8) > b.l.slice(0, 8) ? 1 : a.i - b.i)).map((x) => x.l).slice(-15);
            lines.forEach((l, i) => cv.text(clip(cv, l, 14, 570, 'label'), 1010, 216 + i * 19, 14, l.indexOf('> ') === 9 ? t.text : t.dim, { literal: true }));
            if (!lines.length) cv.text('On the iPhone: Control Center > Screen Mirroring', 1010, 222, 16, t.dim, { literal: true });
        }

        // only while the page shows: in the background the app leaves the service alone, so it can end
        // 10 minutes after the last request
        function shown() { return !ui.isVisible || ui.isVisible('MAIN'); }
        setInterval(() => { if (shown()) poll().catch(() => {}); syncMirror(); }, 1000);
        ui.onVisible(() => syncMirror());
        await poll();
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('AirPlay Test first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});

module.exports = { steps, ask };
