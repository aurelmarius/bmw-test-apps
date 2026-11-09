'use strict';
/**
 * Emby - the head unit as a cast target for the Emby phone app.
 *
 * The screen of the Emby cast service (native/aurelm-emby, a root tool with its client on mgu-uplink):
 *   "Sign in"       opens the sign-in page on the car Wi-Fi for 10 minutes; its QR code shows here. The phone
 *                   (on the car Wi-Fi for wireless CarPlay) scans it, and the owner signs in with their Emby
 *                   account once. Only the access token is kept.
 *   "Sign out"      tells the server, forgets the token.
 *   "Show picture"  the film over the screen again, after the controller hid it
 *   "Stop"          ends the film (as Stop in the phone's remote)
 * Signed in, the service stays connected to the Emby server, and the head unit shows as "BMW iDrive" in the
 * Emby app's cast menu. A film cast to it plays (step 2): the service's player decodes it on the GPU into
 * mgu-render's frame file; this app shows it over the whole screen while the car is parked (setting "Picture only
 * while parked", on by default; off, also while driving) (mirror_view.js,
 * AirPlay Test's) and routes its sound to the speakers (car_audio.js, AirPlay Test's with two more checks: both
 * apps play into source 287 and never take it from each other). Pause, seek, stop and volume come from the phone.
 *
 * Talks to the service over /run/aurelm-emby.sock (a JSON object per line).
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const record = require('./kit/record');
const Parked = require('./kit/parked');
const qrcode = require('./qrcode');
const { RenderClient } = require('./mgu_render_client');
const { createMirrorView } = require('./mirror_view');
const { createCarAudio } = require('./car_audio');

const W = 1600, H = 520;
const SOCK = process.env.EMBY_SOCK || '/run/aurelm-emby.sock';
// the service version this app is built with: an older one still running is asked once to end, and the
// socket starts the new one at the next request
const SERVICE_VERSION = '0.2.0';
// what plays (the service's playback state): the picture and the speakers are wanted
const ACTIVE = ['loading', 'playing', 'paused', 'buffering'];
const older = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };
const GREEN = '#52b54b', AMBER = '#ffb020', RED = '#ef2b2d';

function ask(cmd, extra) {
    return new Promise((res) => {
        let buf = '', done = false;
        const end = (v) => { if (!done) { done = true; clearTimeout(t); try { c.destroy(); } catch (e) { /* gone */ } res(v); } };
        const c = net.connect(SOCK);
        const t = setTimeout(() => end(null), 5000);
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

function clip(cv, s, size, w, font) {
    s = String(s);
    if (cv.textWidth(s, size, { font, literal: true }) <= w) return s;
    while (s.length > 1 && cv.textWidth(s + '...', size, { font, literal: true }) > w) s = s.slice(0, -1);
    return s + '...';
}
const ago = (t, now) => { const s = Math.max(0, Math.round((now - t) / 1000)); return s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; };
const hms = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

/** what the phone sent: the film and its streams */
function castText(p) {
    if (!p) return '';
    const it = p.item || {};
    const v = it.video, a = it.audio;
    const parts = [];
    if (v) parts.push(String(v.codec || '?').toUpperCase() + ' ' + (v.w || '?') + 'x' + (v.h || '?') + (v.hdr && v.hdr !== 'SDR' ? ' ' + v.hdr : ''));
    if (a) parts.push(String(a.codec || '?').toUpperCase() + ' ' + (a.channels || '?') + 'ch');
    if (it.container) parts.push(it.container);
    return (it.title || it.error || p.ids.join(', ')) + (parts.length ? ' - ' + parts.join(', ') : '') + (p.start ? ', from ' + hms(p.start) : '');
}

/** the steps, each { label, state: 'ok'|'wait'|'bad'|'off', detail }, from a status (null: no service) */
function steps(s) {
    if (!s) return [{ label: 'Service', state: 'bad', detail: 'not answering: install "Emby cast service" from the Store, then restart the head unit once' }];
    const c = s.client || {}, up = s.uplink || {};
    const signed = !!s.account;
    const rows = [
        { label: 'Service', state: 'ok', detail: 'version ' + s.version },
        { label: 'Internet', state: up.online ? 'ok' : 'bad', detail: up.online ? 'mgu-uplink on ' + up.iface + ' ' + up.ip : 'offline: mgu-uplink has no connection' },
        { label: 'Account', state: signed ? 'ok' : s.page && s.page.open ? 'wait' : 'off',
            detail: signed ? s.account.userName + ' on ' + (s.account.serverName || s.account.server) + ' (' + s.account.server + ')'
                : (c.error ? c.error + ' - ' : '') + (s.page && s.page.open ? 'scan the QR code with the iPhone' : 'not signed in: press "Sign in"') },
    ];
    if (!signed) return rows;
    const cs = c.state;
    rows.push({ label: 'Server', state: cs === 'connected' ? 'ok' : cs === 'connecting' || cs === 'starting' ? 'wait' : 'bad',
        detail: cs === 'connected' ? 'connected' + (c.server && c.server.version ? ', Emby ' + c.server.version : '') + (c.connectedAt ? ', ' + ago(c.connectedAt, s.now) : '')
            : cs === 'connecting' || cs === 'starting' ? 'connecting...' : (c.error || cs || '') + (c.reconnects ? ' (' + c.reconnects + ' reconnects)' : '') });
    rows.push({ label: 'Cast target', state: cs === 'connected' ? 'ok' : 'off',
        detail: cs === 'connected' ? 'in the Emby app: cast button > "' + s.device + '"' : 'once connected' });
    const pb = s.playback;
    if (pb && (ACTIVE.indexOf(pb.state) >= 0 || pb.state === 'error')) playRows(s, rows);
    else rows.push({ label: 'Last cast', state: s.play ? 'ok' : 'off', detail: s.play ? castText(s.play) + ' (' + ago(s.play.at, s.now) + ')' : 'none yet' });
    const ctl = [s.playstate && s.playstate.at ? { t: s.playstate.at, text: s.playstate.command + (s.playstate.seek != null ? ' to ' + hms(s.playstate.seek) : '') } : null,
        s.command && s.command.at ? { t: s.command.at, text: s.command.name + (s.command.args && s.command.args.Volume != null ? ' ' + s.command.args.Volume : '') } : null]
        .filter(Boolean).sort((a, b) => b.t - a.t)[0];
    rows.push({ label: 'Remote', state: ctl ? 'ok' : 'off', detail: ctl ? ctl.text + ' (' + ago(ctl.t, s.now) + ')' : 'pause, seek and stop from the phone show here' });
    return rows;
}

/** a film playing: what, where, the picture, the sound */
function playRows(s, rows) {
    const pb = s.playback, pl = s.player || {}, tk = pl.tick || {};
    const it = pb.item || {};
    const where = hms(pb.pos) + (pb.dur ? ' / ' + hms(pb.dur) : '');
    const STATE = { loading: 'starting', playing: 'playing', paused: 'paused', buffering: 'buffering (the internet is slow)' };
    rows.push({ label: 'Playing', state: pb.state === 'error' ? 'bad' : pb.state === 'playing' || pb.state === 'paused' ? 'ok' : 'wait',
        detail: (it.title || '?') + ' - ' + (pb.state === 'error' ? pb.error : STATE[pb.state] + ', ' + where) +
            (pb.playMethod ? ' (' + (pb.playMethod === 'Transcode' ? 'the server converts it' : 'as it is') + ')' : '') });
    const d = pl.decoder, open = pl.open && pl.open.video;
    const v = s.mirror || {};
    rows.push({ label: 'Picture', state: !open ? (pb.state === 'error' ? 'off' : 'wait') : d && !d.ok ? 'bad' : v.shown ? 'ok' : 'wait',
        detail: !open ? (pl.open ? 'no picture in the stream' : 'waiting for the stream')
            : (d && !d.ok ? 'GPU decoder: ' + d.error : 'H.264 ' + open.w + 'x' + open.h + ', ' + (tk.shown || 0) + ' shown' + (tk.late ? ', ' + tk.late + ' late' : '') +
                (v.why ? '; ' + v.why : '')) });
    const a = pl.audio, ca = s.carAudio || {};
    let snd;
    if (!a) snd = { state: 'wait', detail: 'waiting for the stream' };
    else if (!a.ok) snd = { state: 'bad', detail: a.error };
    else {
        const n = String(a.codec).toUpperCase() + ' ' + a.channels + 'ch' + (tk.aplayed ? ', ' + tk.aplayed + ' played' : '') + (tk.aunread ? ', ' + tk.aunread + ' unread' : '');
        if (ca.taken) snd = { state: 'bad', detail: n + '; the speakers are in use by AirPlay Test: stop it there' };
        else if (ca.error) snd = { state: 'bad', detail: n + '; route: ' + ca.error };
        else snd = { state: ca.connected ? 'ok' : 'wait', detail: n + (ca.connected ? ', on the speakers' : ', connecting the speakers') + (pb.muted ? ', muted' : pb.volume < 100 ? ', volume ' + pb.volume + '%' : '') };
    }
    rows.push(Object.assign({ label: 'Sound' }, snd));
}

/** the QR code's dark modules for `text`: { n, dark(r, c) } */
function qr(text) {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return { n: q.getModuleCount(), dark: (r, c) => q.isDark(r, c) };
}

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        let st = null, busy = null, polling = false, askedExit = false, code = null, codeFor = null;

        async function poll() {
            if (polling) return;
            polling = true;
            try {
                st = await ask('status');
                if (st && st.version && older(st.version, SERVICE_VERSION) && !askedExit) {
                    askedExit = true;
                    log.info('emby: service ' + st.version + ' running, ' + SERVICE_VERSION + ' installed: asking it to end');
                    busy = 'Updating the service...';
                    await ask('exit');
                    await new Promise((r) => setTimeout(r, 1500));
                    st = await ask('status');
                    busy = null;
                }
            } finally { polling = false; }
        }
        async function command(cmd, label, extra) {
            busy = label;
            const r = await ask(cmd, extra);
            busy = null;
            if (r) st = r;
            log.info('emby: ' + cmd + ' -> ' + (r ? (r.client && r.client.state) : 'no service'));
            return render();
        }
        ui.onClick('BTN_SIGNIN', () => command('signin-open', 'Opening the sign-in page...'));
        ui.onClick('BTN_SIGNOUT', () => command('signout', 'Signing out...'));
        ui.onClick('BTN_SHOW', () => { mirror.wantAgain(); sync(); return render(); });
        ui.onClick('BTN_STOP', () => command('playstate', 'Stopping...', { command: 'Stop' }));

        /* ---------- the film: the picture over the screen (parked only), the sound on the speakers ---------- */
        const parked = Parked.watch(ctx, log, { strict: true });
        const mirror = createMirrorView({ RenderClient, Recorder: record.Recorder, kit: record, appId: ctx.spec.id, log,
            hintText: 'Press a button on the iDrive controller to return',
            statIno: (p) => { const f = fs.statSync(p); return f.isFile() ? f.ino : null; } });
        const carAudio = createCarAudio(ctx.signals, log, { file: ctx.dataDir ? path.join(ctx.dataDir, 'car-audio.json') : null });
        // setting "Picture only while parked" (on by default): off, the picture stays while driving too (the
        // passengers' choice, e.g. cartoons for the children; the driver sees the centre screen)
        const parkedOnly = () => ctx.settings.get('parkedOnly') !== false;
        /** the player as the mirror view knows a receiver: running, its decoder, pictures shown */
        function rxOf(s) {
            const pb = s && s.playback, pl = s && s.player;
            if (!pb || ACTIVE.indexOf(pb.state) < 0 || !pl || !pl.running) return null;
            const d = pl.decoder;
            return { running: true, videoRunning: true, stream: { shown: pl.tick ? pl.tick.shown : 0 },
                decoder: d ? { ok: d.ok, error: d.error, path: d.path || pl.videoPath, w: d.w, h: d.h } : null };
        }
        function sync() {
            const pb = st && st.playback;
            mirror.update({ rx: rxOf(st), pageVisible: shown(), driving: parkedOnly() && parked.moving() });
            // the speakers while a film is on (paused too: the route is not taken and given back at each pause)
            carAudio.want(!!(pb && ACTIVE.indexOf(pb.state) >= 0 && st.player && st.player.audio && st.player.audio.ok));
        }
        if (ctx.app && ctx.app.on) ctx.app.on('shutdown', () => { mirror.close(); carAudio.want(false); });

        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const page = st && st.page && st.page.open ? st.page : null;
            G.frame(cv, t, ['Emby'], 0, [busy && { text: busy, color: 'accent' }, page && { text: 'SIGN-IN ' + Math.ceil((page.left || 0) / 60) + ' MIN' }]);
            draw(cv, t, page);
            return ui.image('MAIN_GFX', cv);
        }

        function draw(cv, t, page) {
            if (st) { st.mirror = mirror.state(); st.carAudio = carAudio.state(); }
            const rows = steps(st);
            const COL = { ok: GREEN, wait: AMBER, bad: RED, off: withAlpha('#ffffff', 0.3) };
            const textW = page ? 860 : 1180;
            const rowH = rows.length > 7 ? 40 : 52;   // a film's rows fit above the log
            rows.forEach((r, i) => {
                const y = 96 + i * rowH;
                cv.circle(44, y - 8, 10, COL[r.state]);
                cv.text(r.label, 68, y, 24, t.text, { font: 'bold', literal: true });
                cv.text(clip(cv, r.detail || '', 22, textW, 'label'), 250, y, 22, r.state === 'off' ? t.dim : t.text, { literal: true });
            });
            if (page) return drawCode(cv, t, page);
            // the service's log, under the steps
            const lines = (st && st.log ? st.log : []).slice(-3);
            lines.forEach((l, i) => cv.text(clip(cv, l, 16, 1500, 'label'), 44, 440 + i * 24, 16, t.dim, { literal: true }));
        }

        function drawCode(cv, t, page) {
            const x0 = 1150, y0 = 70, box = 380;
            if (!page.url) {
                cv.text('No car Wi-Fi yet:', x0, y0 + 40, 22, t.text, { font: 'bold', literal: true });
                cv.text('connect the iPhone with wireless CarPlay', x0, y0 + 72, 18, t.dim, { literal: true });
                return;
            }
            if (codeFor !== page.url) { code = qr(page.url); codeFor = page.url; }
            const cell = Math.floor(box / (code.n + 8));
            const size = cell * (code.n + 8);
            const ox = x0 + Math.floor((box - size) / 2), oy = y0;
            cv.fillRect(ox, oy, size, size, '#ffffff');
            for (let r = 0; r < code.n; r++) for (let c = 0; c < code.n; c++) {
                if (code.dark(r, c)) cv.fillRect(ox + (c + 4) * cell, oy + (r + 4) * cell, cell, cell, '#000000');
            }
            cv.text('Scan with the iPhone camera', x0 + box / 2, oy + size + 34, 20, t.text, { font: 'bold', align: 'center', literal: true });
            cv.text(clip(cv, page.url, 16, box + 40, 'label'), x0 + box / 2, oy + size + 60, 16, t.dim, { align: 'center', literal: true });
        }

        // while the page shows; in the background only while a film is on (its sound route, its picture hidden)
        function shown() { return !ui.isVisible || ui.isVisible('MAIN'); }
        let tick = 0;
        setInterval(() => {
            tick++;
            const on = st && st.playback && ACTIVE.indexOf(st.playback.state) >= 0;
            if (shown() || (on && tick % 2 === 0)) poll().catch(() => {});
            sync();
        }, 1000);
        if (ui.onVisible) ui.onVisible(() => sync());
        await poll();
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('Emby first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});

module.exports = { steps, castText, qr, ask, ACTIVE };
