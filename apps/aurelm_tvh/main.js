'use strict';
/**
 * TVH - Tvheadend's channels on the head unit.
 *
 * The screen of the TVH service (native/aurelm-tvh, a root tool with its client on mgu-uplink):
 *   "Watch"         plays the last channel (the first one the first time) and shows the picture; while a channel
 *                   plays, shows its picture again after the controller hid it
 *   "Channel +/-"   the next / previous channel (also with the picture hidden, or while driving: the sound goes on)
 *   "Stop"          ends the channel (the stream, the player, the speakers)
 *   "Sign in"       opens the sign-in page on the car Wi-Fi for 10 minutes; its QR code shows here. The phone (on the
 *                   car Wi-Fi for wireless CarPlay) scans it: the server's address, a Tvheadend user and password.
 *   "Sign out"      forgets the server, the user and the password.
 * The page lists the channels around the one playing, each with what is on now. Over the picture (shown while the car
 * is parked; setting "Picture only while parked") a touch or the controller shows the controls (controls.js): CH-,
 * CH+, LIST (every channel: the knob and a press, or a touch, plays one), stop, aspect, exit.
 *
 * The stream comes with one of the server's profiles (setting "Stream profile": mgu-hd, mgu-sd, mgu-low; H.264
 * deinterlaced by the server, AAC); "Lower the quality by itself" goes down that ladder when the stream runs dry.
 * The sound goes to the speakers through source 287, shared with AirPlay Test and Emby (car_audio.js: never taken
 * from the other app). Talks to the service over /run/aurelm-tvh.sock (a JSON object per line).
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
const { createControls, videoRect, hm } = require('./controls');
const { createCarAudio } = require('./car_audio');

const W = 1600, H = 520;
const SOCK = process.env.TVH_SOCK || '/run/aurelm-tvh.sock';
// the service version this app is built with: an older one still running is asked once to end, and the socket
// starts the new one at the next request
const SERVICE_VERSION = '0.1.0';
// a channel is on: the picture and the speakers are wanted
const ACTIVE = ['loading', 'playing', 'buffering'];
const channelOn = (pb) => !!(pb && ACTIVE.indexOf(pb.state) >= 0);
const PROFILES = ['mgu-hd', 'mgu-sd', 'mgu-low'];
const older = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };
const GREEN = '#52b54b', AMBER = '#ffb020', RED = '#ef2b2d', BLUE = '#2f8fd8';

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
const chName = (c) => (c ? (c.number != null ? c.number + '  ' : '') + c.name : '');

/** the channel after / before `uuid` in the list (round) */
function neighbour(list, uuid, d) {
    if (!list.length) return null;
    const i = list.findIndex((c) => c.uuid === uuid);
    return list[((i < 0 ? (d > 0 ? -1 : 0) : i) + d + list.length) % list.length];
}

/** the steps, each { label, state: 'ok'|'wait'|'bad'|'off', detail }, from a status (null: no service) */
function steps(s) {
    if (!s) return [{ label: 'Service', state: 'bad', detail: 'not answering: install "TVH service" from the Store, then restart the head unit once' }];
    const c = s.client || {}, up = s.uplink || {};
    const signed = !!s.account;
    const rows = [
        { label: 'Service', state: 'ok', detail: 'version ' + s.version },
        { label: 'Internet', state: up.online ? 'ok' : 'bad', detail: up.online ? 'mgu-uplink on ' + up.iface + ' ' + up.ip : 'offline: mgu-uplink has no connection' },
        { label: 'Account', state: signed ? 'ok' : s.page && s.page.open ? 'wait' : 'off',
            detail: signed ? s.account.user + ' on ' + (s.account.serverName || 'Tvheadend') + ' (' + s.account.server + ')'
                : (s.lastSignIn && s.lastSignIn.error ? s.lastSignIn.error + ' - ' : '') + (s.page && s.page.open ? 'scan the QR code with the iPhone' : 'not signed in: press "Sign in"') },
    ];
    if (!signed) return rows;
    const cs = c.state;
    const prof = c.profiles ? c.profiles.filter((p) => PROFILES.indexOf(p) >= 0) : null;
    rows.push({ label: 'Server', state: cs === 'connected' ? 'ok' : cs === 'connecting' || cs === 'starting' ? 'wait' : 'bad',
        detail: cs === 'connected' ? 'Tvheadend ' + ((c.server && c.server.version) || '') + ', ' + (s.channels ? s.channels.count : 0) + ' channels' +
            (prof ? ', profiles ' + (prof.length ? prof.join(' ') : 'none named mgu-* (create them on the server)') : '')
            : cs === 'connecting' || cs === 'starting' ? 'connecting...' : (c.error || cs || '') + (c.retries ? ' (' + c.retries + ' tries)' : '') });
    const pb = s.playback;
    if (pb && (channelOn(pb) || pb.state === 'error')) playRows(s, rows);
    else rows.push({ label: 'Playing', state: 'off', detail: 'nothing: press "Watch"' });
    return rows;
}

/** a channel playing: what, the stream, the picture, the sound */
function playRows(s, rows) {
    const pb = s.playback, pl = s.player || {}, tk = pl.tick || {};
    const STATE = { loading: 'starting', playing: 'playing', buffering: 'buffering (the internet or the server is slow)' };
    const PHASE = { stream: 'asking the server for the stream', player: 'starting the player', retry: 'the stream broke: opening it again' };
    const waited = pb.phaseAt ? Math.max(0, Math.round((s.now - pb.phaseAt) / 1000)) : 0;
    const what = pb.state === 'error' ? pb.error
        : pb.state === 'loading' && PHASE[pb.phase] ? PHASE[pb.phase] + (waited >= 3 ? ' (' + waited + ' s)' : '') + (pb.phase === 'retry' && pb.error ? ': ' + pb.error : '')
            : STATE[pb.state];
    const prof = pb.profile ? ', ' + pb.profile + (pb.lowered ? ' (lowered: slow internet)' : '') : '';
    rows.push({ label: 'Playing', state: pb.state === 'error' ? 'bad' : pb.state === 'playing' ? 'ok' : 'wait',
        detail: chName(pb.channel) + ' - ' + what + prof + (pb.reconnects ? ', ' + pb.reconnects + ' reconnects' : '') });
    const fresh = pb.state !== 'loading' || pb.phase === 'player';
    const d = fresh ? pl.decoder : null, open = fresh && pl.open && pl.open.video;
    const v = s.mirror || {};
    let pic;
    if (!open) pic = { state: pb.state === 'error' ? 'off' : 'wait', detail: fresh && pl.open ? 'no picture in the stream (a radio channel?)' : 'waiting for the stream' };
    else if (d && !d.ok) pic = { state: 'bad', detail: 'GPU decoder: ' + d.error };
    else {
        const il = pb.interlaced ? '; INTERLACED: profile ' + pb.profile + ' does not deinterlace (Tvheadend: its codec profile, Deinterlace)' : '';
        pic = { state: pb.interlaced ? 'wait' : v.shown ? 'ok' : 'wait',
            detail: 'H.264 ' + open.w + 'x' + open.h + (open.fps ? ' ' + Math.round(open.fps) + 'p' : '') + ', ' + (tk.shown || 0) + ' shown' + (tk.late ? ', ' + tk.late + ' late' : '') +
                (tk.buffered != null ? ', ' + tk.buffered.toFixed(1) + ' s buffered' : '') + (v.why ? '; ' + v.why : '') + il };
    }
    rows.push(Object.assign({ label: 'Picture' }, pic));
    const a = fresh ? pl.audio : null, ca = s.carAudio || {};
    let snd;
    if (pb.audioError) snd = { state: 'bad', detail: pb.audioError };
    else if (!a) snd = { state: 'wait', detail: fresh && pl.open && pl.running ? 'no sound in the stream yet' : 'waiting for the stream' };
    else if (!a.ok) snd = { state: 'bad', detail: a.error };
    else {
        const n = String(a.codec).toUpperCase() + ' ' + a.channels + 'ch' + (tk.aplayed ? ', ' + tk.aplayed + ' played' : '') + (tk.aunread ? ', ' + tk.aunread + ' unread' : '');
        if (ca.taken) snd = { state: 'bad', detail: n + '; the speakers are in use by AirPlay Test or Emby: stop it there' };
        else if (ca.error) snd = { state: 'bad', detail: n + '; route: ' + ca.error };
        else snd = { state: ca.connected ? 'ok' : 'wait', detail: n + (ca.connected ? ', on the speakers' : ', connecting the speakers') };
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
        let chans = { at: null, channels: [], epg: {} };

        /* ---------- the last channel, kept for "Watch" ---------- */
        const lastFile = ctx.dataDir ? path.join(ctx.dataDir, 'last-channel.json') : null;
        let lastUuid = null;
        try { lastUuid = JSON.parse(fs.readFileSync(lastFile, 'utf8')).uuid || null; } catch (e) { /* none yet */ }
        function remember(uuid) {
            if (!uuid || uuid === lastUuid) return;
            lastUuid = uuid;
            try { if (lastFile) fs.writeFileSync(lastFile, JSON.stringify({ uuid })); } catch (e) { log.warn('tvh: last channel: ' + e); }
        }

        function prefsNow() {
            const p = ctx.settings.get('profile');
            return { profile: PROFILES.indexOf(p) >= 0 ? p : 'mgu-hd', adaptive: ctx.settings.get('adaptive') !== false };
        }
        async function poll() {
            if (polling) return;
            polling = true;
            try {
                st = await ask('status');
                const want = prefsNow(), have = st && st.prefs;
                if (st && st.version && (!have || have.profile !== want.profile || have.adaptive !== want.adaptive)) {
                    const r = await ask('prefs', want);
                    if (r) st = r;
                }
                if (st && st.version && older(st.version, SERVICE_VERSION) && !askedExit) {
                    askedExit = true;
                    log.info('tvh: service ' + st.version + ' running, ' + SERVICE_VERSION + ' installed: asking it to end');
                    busy = 'Updating the service...';
                    await ask('exit');
                    await new Promise((r) => setTimeout(r, 1500));
                    st = await ask('status');
                    busy = null;
                }
                // the channel list when it changed (not in every status: a few hundred channels)
                if (st && st.channels && st.channels.at && st.channels.at !== chans.at) {
                    const r = await ask('channels');
                    if (r && r.channels) chans = r;
                }
                if (st && !st.account) chans = { at: null, channels: [], epg: {} };
                const pb = st && st.playback;
                if (pb && pb.channel && channelOn(pb)) remember(pb.channel.uuid);
            } finally { polling = false; }
        }
        async function command(cmd, label, extra) {
            busy = label;
            const r = await ask(cmd, extra);
            busy = null;
            if (r) st = r;
            log.info('tvh: ' + cmd + ' -> ' + (r ? (r.client && r.client.state) : 'no service'));
            return render();
        }
        function playChannel(uuid, why) {
            const ch = chans.channels.filter((c) => c.uuid === uuid)[0];
            if (!ch) return render();
            log.info('tvh: ' + why + ': ' + chName(ch));
            remember(uuid);
            mirror.wantAgain();
            return command('play', 'Tuning ' + chName(ch) + '...', { uuid });
        }
        const playing = () => { const pb = st && st.playback; return channelOn(pb) && pb.channel ? pb.channel.uuid : null; };
        function zap(d) {
            const from = playing() || lastUuid;
            const ch = neighbour(chans.channels, from, d);
            if (ch) return playChannel(ch.uuid, d > 0 ? 'channel +' : 'channel -');
            return render();
        }

        // Sign out, and Sign in while signed in, want a second press within 5 s (a stray press of the controller)
        const confirm = { at: 0, what: null };
        function confirmed(what, ask_) {
            if (confirm.what === what && Date.now() < confirm.at) { confirm.what = null; return true; }
            confirm.what = what; confirm.at = Date.now() + 5000;
            busy = ask_;
            setTimeout(() => { if (busy === ask_) { busy = null; render(); } }, 5000);
            render();
            return false;
        }
        ui.onClick('BTN_SIGNIN', () => {
            if (st && st.account && !(st.page && st.page.open) && !confirmed('signin', 'Signed in: press "Sign in" again to sign in anew')) return;
            return command('signin-open', 'Opening the sign-in page...');
        });
        ui.onClick('BTN_SIGNOUT', () => {
            if (!(st && st.account)) return;
            if (!confirmed('signout', 'Press "Sign out" again to sign out')) return;
            return command('signout', 'Signing out...');
        });
        ui.onClick('BTN_WATCH', () => {
            if (playing()) { mirror.wantAgain(); sync(); return render(); }
            const ch = chans.channels.filter((c) => c.uuid === lastUuid)[0] || chans.channels[0];
            if (!ch) { busy = st && st.account ? 'No channels yet' : 'Sign in first'; setTimeout(() => { busy = null; render(); }, 3000); return render(); }
            return playChannel(ch.uuid, 'watch');
        });
        ui.onClick('BTN_CHUP', () => zap(1));
        ui.onClick('BTN_CHDOWN', () => zap(-1));
        ui.onClick('BTN_STOP', () => command('stop', 'Stopping...'));

        /* ---------- the channel: the picture over the screen (parked only), the sound on the speakers ---------- */
        const parked = Parked.watch(ctx, log, { strict: true });
        const mirror = createMirrorView({ RenderClient, Recorder: record.Recorder, kit: record, appId: ctx.spec.id, log,
            hintText: 'Touch the picture or use the iDrive controller for the controls', overlay: () => overlay(),
            onTouch: (phase, x, y, pl) => { if (pl && controls.touch(phase, x, y, pl, barInfo())) mirror.tick(); },
            onCcu: (c) => { const r = controls.ccu(c); mirror.tick(); return r; },
            onShown: (on) => pageTouch(!on),
            // another channel: a new player; the picture stays up (black, "Tuning...") meanwhile
            hold: () => channelOn(st && st.playback),
            holdText: 'between two channels',
            idleText: 'the player is not running', hiddenText: 'hidden: press "Watch" to show it again',
            statIno: (p) => { const f = fs.statSync(p); return f.isFile() ? f.ino : null; } });
        // while the picture shows, the page underneath claims no touch (Emby 0.3.0 in the car: a touch went to the
        // page's buttons under the picture)
        const disp = ctx.display;
        let pageClaims = true;
        if (disp && typeof disp._claimTabs === 'function') {
            const claimTabs = disp._claimTabs.bind(disp);
            disp._claimTabs = (rects, r) => {
                if (pageClaims) return claimTabs(rects, r);
                disp.tabs = [];
                if (disp.gpu && disp.gpu.claim) disp.gpu.claim([]);
                return undefined;
            };
        }
        function pageTouch(on) {
            if (on === pageClaims) return;
            pageClaims = on;
            try {
                if (!on) { if (disp && disp.gpu && disp.gpu.claim) disp.gpu.claim([]); }
                else if (disp) { disp.lastWords = null; if (disp._repaint) disp._repaint(); }
            } catch (e) { log.warn('tvh page touch: ' + e); }
        }
        const carAudio = createCarAudio(ctx.signals, log, { file: ctx.dataDir ? path.join(ctx.dataDir, 'car-audio.json') : null });
        const parkedOnly = () => ctx.settings.get('parkedOnly') !== false;
        /** the player as the mirror view knows a receiver: running, its decoder, pictures shown */
        function rxOf(s) {
            const pb = s && s.playback, pl = s && s.player;
            if (!channelOn(pb) || !pl || !pl.running) return null;
            const d = pl.decoder;
            return { running: true, videoRunning: true, stream: { shown: pl.tick ? pl.tick.shown : 0 },
                decoder: d ? { ok: d.ok, error: d.error, path: d.path || pl.videoPath, w: d.w, h: d.h } : null };
        }

        /* ---------- the controls over the picture ---------- */
        const ASPECTS = ['fit', 'zoom', 'fill'];
        const aspect = () => (ASPECTS.indexOf(ctx.settings.get('aspect')) >= 0 ? ctx.settings.get('aspect') : 'fit');
        const controls = createControls({
            act: (a) => {
                if (a && a.channel) return playChannel(a.channel, 'from the list');
                if (a === 'chup') return zap(1);
                if (a === 'chdown') return zap(-1);
                if (a === 'stop') { controls.hide(); return command('stop', 'Stopping...'); }
                if (a === 'aspect') { ctx.settings.set('aspect', ASPECTS[(ASPECTS.indexOf(aspect()) + 1) % ASPECTS.length]); return mirror.tick(); }
                if (a === 'exit') return mirror.hide('the controls');
            },
        });
        function barInfo() {
            const pb = (st && st.playback) || {};
            const cur = pb.channel ? pb.channel.uuid : null;
            return {
                title: chName(pb.channel), now: cur ? chans.epg[cur] || null : null, aspect: aspect(),
                profile: pb.profile ? pb.profile + (pb.lowered ? ' (slow)' : '') : '', note: pb.interlaced ? 'interlaced' : pb.state === 'buffering' ? 'buffering' : '',
                current: cur,
                channels: chans.channels.map((c) => ({ uuid: c.uuid, t: chName(c) + (chans.epg[c.uuid] && chans.epg[c.uuid].title ? '  -  ' + chans.epg[c.uuid].title : '') })),
            };
        }
        function overlay() {
            const pl = st && st.player, d = pl && pl.decoder;
            const fw = d && d.ok ? d.w : 0, fh = d && d.ok ? d.h : 0, mode = aspect();
            const info = barInfo();
            const bar = controls.key(info);
            const pb = st && st.playback;
            const loading = !!(pb && (pb.state === 'loading' || pb.state === 'buffering') && !(pl && pl.running && pl.tick && pl.tick.shown > 0));
            const word = pb && pb.state === 'loading' ? 'Tuning ' + info.title + '...' : 'Buffering...';
            return {
                key: [mode, fw, fh, bar, loading, word].join('#'),
                rect: (p) => videoRect(mode, fw, fh, p),
                draw: (rec, p) => {
                    if (loading) rec.text(word, p.w / 2, p.h / 2, Math.round(p.h * 0.05), 0xffffffb0, { align: 'center', font: 'bold', literal: true });
                    if (bar) controls.draw(rec, p, info);
                },
            };
        }
        setInterval(() => { if (mirror.state().shown) mirror.tick(); }, 200);

        let soundUntil = 0;
        function sync() {
            const pb = st && st.playback;
            mirror.update({ rx: rxOf(st), pageVisible: shown(), driving: parkedOnly() && parked.moving() });
            // the speakers while a channel is on, and between two channels (each a new player); 5 s more after it
            const pl = st && st.player;
            const soundFailed = !!(pl && pl.running && pl.audio && pl.audio.ok === false);
            const on = channelOn(pb) && !soundFailed;
            if (on) soundUntil = Date.now() + 5000;
            carAudio.want(on || Date.now() < soundUntil);
        }
        if (ctx.app && ctx.app.on) ctx.app.on('shutdown', () => { mirror.close(); carAudio.want(false); ask('stop'); });

        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const page = st && st.page && st.page.open ? st.page : null;
            G.frame(cv, t, ['TVH'], 0, [busy && { text: busy, color: 'accent' }, page && { text: 'SIGN-IN ' + Math.ceil((page.left || 0) / 60) + ' MIN' }]);
            draw(cv, t, page);
            return ui.image('MAIN_GFX', cv);
        }

        function draw(cv, t, page) {
            if (st) { st.mirror = mirror.state(); st.carAudio = carAudio.state(); }
            const rows = steps(st);
            const COL = { ok: GREEN, wait: AMBER, bad: RED, off: withAlpha('#ffffff', 0.3) };
            const side = page || chans.channels.length;
            const textW = side ? 760 : 1180;
            const rowH = rows.length > 7 ? 40 : 52;
            rows.forEach((r, i) => {
                const y = 96 + i * rowH;
                cv.circle(44, y - 8, 10, COL[r.state]);
                cv.text(r.label, 68, y, 24, t.text, { font: 'bold', literal: true });
                cv.text(clip(cv, r.detail || '', 22, textW, 'label'), 250, y, 22, r.state === 'off' ? t.dim : t.text, { literal: true });
            });
            if (page) return drawCode(cv, t, page);
            if (chans.channels.length) drawChannels(cv, t);
            const lines = (st && st.log ? st.log : []).slice(-3);
            lines.forEach((l, i) => cv.text(clip(cv, l, 16, side ? 960 : 1500, 'label'), 44, 440 + i * 24, 16, t.dim, { literal: true }));
        }

        /** the channels around the one playing (or the last one), each with what is on now */
        function drawChannels(cv, t) {
            const x0 = 1050, w = 510, rowH = 46, n = 8;
            const list = chans.channels, cur = playing() || lastUuid;
            let at = Math.max(0, list.findIndex((c) => c.uuid === cur));
            const first = Math.max(0, Math.min(at - 3, list.length - n));
            cv.text('CHANNELS', x0, 64, 18, t.dim, { font: 'bold', literal: true });
            const tnow = Date.now() / 1000;
            list.slice(first, first + n).forEach((c, k) => {
                const y = 108 + k * rowH, on = c.uuid === cur, e = chans.epg[c.uuid];
                if (on) cv.fillRect(x0 - 12, y - 30, w + 24, rowH - 4, withAlpha(BLUE, playing() ? 0.35 : 0.15));
                cv.text(clip(cv, chName(c), 22, w * 0.45, 'label'), x0, y, 22, t.text, { font: on ? 'bold' : undefined, literal: true });
                if (e && e.title) {
                    const tail = e.stop ? ' ' + hm(e.stop) : '';
                    cv.text(clip(cv, e.title, 18, w * 0.5 - 60, 'label') + tail, x0 + w, y, 18, t.dim, { align: 'right', literal: true });
                    if (e.start && e.stop && e.stop > e.start) {
                        const f = Math.max(0, Math.min(1, (tnow - e.start) / (e.stop - e.start)));
                        cv.fillRect(x0, y + 8, w, 3, withAlpha('#ffffff', 0.12));
                        cv.fillRect(x0, y + 8, Math.round(w * f), 3, BLUE);
                    }
                }
            });
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

        // while the page shows; in the background only while a channel is on (its sound, the service's watch)
        function shown() { return !ui.isVisible || ui.isVisible('MAIN'); }
        let tick = 0;
        setInterval(() => {
            tick++;
            const on = channelOn(st && st.playback);
            if (shown() || (on && tick % 2 === 0)) poll().catch(() => {});
            sync();
        }, 1000);
        if (ui.onVisible) ui.onVisible(() => sync());
        await poll();
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('TVH first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});

module.exports = { steps, qr, ask, ACTIVE, channelOn, neighbour, chName };
