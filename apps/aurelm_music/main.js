'use strict';
/**
 * Music Assistant - your Music Assistant server in the car.
 *
 * The screen of the Music Assistant service (native/aurelm-music, a root tool with its client on mgu-uplink):
 *   Home      Music Assistant's home rows (recently played, recently added, the providers' recommendations...), each
 *             with its covers; a tap opens an album / playlist / artist, plays a track or a radio station
 *   Library   playlists, albums, artists, radio, tracks
 *   Search    an on-screen keyboard; the results by kind
 *   Playing   the cover, the title, the artist, the progress, the controls, and what comes next (the queue)
 *   Status    the steps (service, internet, account, Sendspin, player, speakers, cluster) and the service's log
 * The bar: Play / Pause, Previous, Next, Sign in (a QR code: the phone opens the sign-in page on the car Wi-Fi),
 * Settings. Skip on the steering wheel (SteeringWheelPushButton.statusSearchSwitch1: Media Probe 0.1.2 saw it come
 * to apps) is next / previous while our music plays; held, back / forward 15 s. The sound is routed to the speakers
 * (car_audio.js: source 287) while music plays or is paused; what plays shows on the cluster (cluster_card.js).
 *
 * Talks to the service over /run/aurelm-music.sock (a JSON object per line).
 */
const net = require('net');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha, Canvas } = require('./kit/canvas');
const png = require('./kit/png');
const G = require('./kit/gauges');
const { setImage } = require('./kit/record');
const qrcode = require('./qrcode');
const { createCarAudio } = require('./car_audio');
const { createClusterCard, ascii } = require('./cluster_card');
const { createCovers } = require('./covers');

const W = 1600, H = 520, TOP = 46;
const SOCK = process.env.MUSIC_SOCK || '/run/aurelm-music.sock';
const SERVICE_VERSION = '0.1.0';
const GREEN = '#1db954', AMBER = '#ffb020', RED = '#ef2b2d';
const TABS = ['Home', 'Library', 'Search', 'Playing', 'Status'];
const T_HOME = 0, T_LIB = 1, T_SEARCH = 2, T_PLAY = 3, T_STATUS = 4;
const KINDS = [['playlists', 'Playlists'], ['albums', 'Albums'], ['artists', 'Artists'], ['radios', 'Radio'], ['tracks', 'Tracks']];
const WHEEL = 'de.bmw.infotainment.controlelements.SteeringWheelPushButton';
const OPENS = ['album', 'playlist', 'artist', 'podcast', 'audiobook'];
const older = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };

function ask(cmd, extra, ms) {
    return new Promise((res) => {
        let buf = '', done = false;
        const end = (v) => { if (!done) { done = true; clearTimeout(t); try { c.destroy(); } catch (e) { /* gone */ } res(v); } };
        const c = net.connect(SOCK);
        const t = setTimeout(() => end(null), ms || 5000);
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
/** a request to Music Assistant through the service: its data, or throws its error */
function req(what, args, ms) {
    return ask('req', { what, args: args || {} }, ms || 35000).then((r) => {
        if (!r) throw new Error('the service did not answer');
        if (!r.ok) throw new Error(r.error || 'failed');
        return r.data;
    });
}
function clip(cv, s, size, w, font) {
    s = ascii(s);
    if (cv.textWidth(s, size, { font, literal: true }) <= w) return s;
    while (s.length > 1 && cv.textWidth(s + '...', size, { font, literal: true }) > w) s = s.slice(0, -1);
    return s.trim() + '...';
}
const mss = (ms) => { const s = Math.max(0, Math.floor((ms || 0) / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
/** the QR code's dark modules for `text`: { n, dark(r, c) } */
function qr(text) {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return { n: q.getModuleCount(), dark: (r, c) => q.isDark(r, c) };
}
/** where the track is now: the last position Sendspin told, moved on by the time since while it plays */
function position(c) {
    const m = c && c.meta;
    if (!m || m.progressMs == null) return null;
    const run = c.playback === 'playing' && m.speed ? (Date.now() - (m.progressAt || Date.now())) * m.speed / 1000 : 0;
    return Math.min(m.durationMs || Infinity, m.progressMs + run);
}

/** the steps, each { label, state: 'ok'|'wait'|'bad'|'off', detail }, from a status (null: no service) */
function steps(s, x) {
    if (!s) return [{ label: 'Service', state: 'bad', detail: 'not answering: install "Music Assistant service" from the Store, then restart the head unit once' }];
    const c = s.client || {}, up = s.uplink || {}, pl = s.player || {};
    const rows = [
        { label: 'Service', state: 'ok', detail: 'version ' + s.version },
        { label: 'Internet', state: up.online ? 'ok' : 'bad', detail: up.online ? 'mgu-uplink on ' + up.iface + ' ' + up.ip : 'offline: mgu-uplink has no connection' },
        { label: 'Account', state: s.account ? 'ok' : s.page && s.page.open ? 'wait' : 'off',
            detail: s.account ? s.account.userName + ' on ' + (s.account.serverName || s.account.server) + ' (' + s.account.server + (s.account.serverVersion ? ', ' + s.account.serverVersion : '') + ')'
                : (c.error ? c.error + ' - ' : '') + (s.page && s.page.open ? 'scan the QR code with the iPhone' : 'not signed in: press "Sign in"') },
    ];
    if (!s.account) return rows;
    rows.push({ label: 'Sendspin', state: c.conn === 'connected' ? 'ok' : c.conn === 'connecting' || c.conn === 'starting' ? 'wait' : 'bad',
        detail: c.conn === 'connected' ? 'connected' + (c.playerId ? ', the player "' + (s.device || 'BMW iDrive') + '" (' + c.playerId + ')' : '') + (c.format ? ', ' + c.format.codec + ' ' + c.format.rate + ' Hz' : '')
            : (c.conn || '?') + (c.error ? ': ' + c.error : '') + (c.reconnects ? ' (' + c.reconnects + ' reconnects)' : '') });
    rows.push({ label: 'Player', state: pl.error ? 'bad' : pl.running ? 'ok' : 'off',
        detail: pl.error ? pl.error : pl.running ? 'playing into ' + (pl.open ? (pl.open.device || pl.open.out) : '?') + ', ' + Math.round((pl.played || 0) / 48000) + ' s played' +
            (pl.underruns ? ', ' + pl.underruns + ' underruns' : '') + (c.ahead ? ', ' + Math.round(c.ahead / 1000) + ' s buffered' : '') : 'starts with the music' });
    const ca = x.carAudio || {};
    rows.push({ label: 'Speakers', state: ca.taken ? 'bad' : ca.error ? 'bad' : ca.connected ? 'ok' : 'off',
        detail: ca.taken ? 'in use by another app (myAirPlay, TVH Player, Emby): stop it there' : ca.error ? ca.error : ca.connected ? 'on the main speakers (source 287)' : 'connected while music plays' });
    const cl = x.cluster;
    if (cl) rows.push({ label: 'Cluster', state: cl.state === 'shown' ? 'ok' : cl.state === 'error' ? 'bad' : cl.state === 'off' || cl.state === 'missing' ? 'off' : 'wait', detail: cl.detail });
    rows.push({ label: 'Wheel', state: x.wheel.seen ? 'ok' : 'off', detail: x.wheel.seen ? 'last: ' + x.wheel.last : x.wheel.on ? 'press skip on the steering wheel while music plays' : 'off in the settings' });
    return rows;
}

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        let st = null, busy = null, polling = false, askedExit = false, toast = null;
        let tab = Number(process.env.MUSIC_PREVIEW_TAB || T_HOME) || T_HOME, code = null, codeFor = null;
        const say = (text, bad) => { toast = { text, bad, at: Date.now() }; render(); };

        async function poll() {
            if (polling) return;
            polling = true;
            try {
                const r = await ask('status');
                const before = st && st.client && st.client.meta && st.client.meta.title;
                st = r;
                if (st && st.version && older(st.version, SERVICE_VERSION) && !askedExit) {
                    askedExit = true;
                    log.info('music: service ' + st.version + ' running, ' + SERVICE_VERSION + ' installed: asking it to end');
                    await ask('exit');
                    await new Promise((x) => setTimeout(x, 1500));
                    st = await ask('status');
                }
                const now = st && st.client && st.client.meta && st.client.meta.title;
                if (now !== before) { queue.at = 0; }
                if (st && st.account && !home.rows && !home.loading) loadHome();
            } finally { polling = false; }
        }
        async function command(cmd, label) {
            busy = label; render();
            const r = await ask(cmd, {}, 15000);
            busy = null;
            if (r && r.version) st = r;
            return render();
        }
        const signedIn = () => !!(st && st.account);
        const client = () => (st && st.client) || {};
        const musicOn = () => { const c = client(); return c.playback === 'playing' || c.playback === 'paused'; };

        /* ---------- covers ---------- */
        const covers = createCovers({ ask, png, setImage, log,
            onChange: () => { const d = ctx.display; if (d) d.lastWords = null; render(); } });

        /* ---------- playing and controlling ---------- */
        async function play(item, startItem) {
            if (!item || !item.uri) return;
            busy = 'Playing ' + ascii(item.name).slice(0, 40) + '...'; render();
            try {
                await req('play', { uri: item.uri, startItem: startItem ? startItem.uri : undefined }, 45000);
                busy = null; tab = T_PLAY; queue.at = 0;
                setTimeout(poll, 600);
            } catch (e) { busy = null; say('Could not play: ' + e.message, true); }
            render();
        }
        async function control(cmd, arg, label) {
            try { await req('control', { cmd, arg }); setTimeout(poll, 400); }
            catch (e) { say((label || cmd) + ': ' + e.message, true); }
        }
        ui.onClick('BTN_PLAY', () => control('play_pause', null, 'Play / Pause'));
        ui.onClick('BTN_PREVTRACK', () => control('previous', null, 'Previous'));
        ui.onClick('BTN_NEXTTRACK', () => control('next', null, 'Next'));
        // Sign out wants a second press within 5 s (Sign in while signed in offers it)
        let confirmAt = 0;
        ui.onClick('BTN_SIGNIN', () => {
            if (signedIn() && !(st.page && st.page.open)) {
                if (Date.now() < confirmAt) { confirmAt = 0; home.rows = null; return command('signout', 'Signing out...'); }
                confirmAt = Date.now() + 5000;
                say('Signed in as ' + st.account.userName + ': press "Sign in" again within 5 s to sign out');
                return undefined;
            }
            tab = T_STATUS;
            return command('signin-open', 'Opening the sign-in page...');
        });

        /* ---------- the steering wheel: skip ---------- */
        const wheel = { on: true, seen: false, last: '', down: null };
        function onSkip(v) {
            const val = v && typeof v === 'object' ? v.operationPushButtonAudioAutomaticTuningSteeringWheel : v;
            if (!val) return;
            wheel.on = ctx.settings.get('wheel') !== false;
            if (/SKIP_RECHTS|SKIP_LINKS/.test(val)) { wheel.down = { dir: /RECHTS/.test(val) ? 1 : -1, at: Date.now() }; return; }
            if (!/KEINE_AKTION/.test(val) || !wheel.down) return;
            const d = wheel.down, held = Date.now() - d.at;
            wheel.down = null;
            if (!wheel.on || !musicOn()) return;
            wheel.seen = true;
            if (held >= 700) {
                const sec = d.dir * (held >= 2500 ? 30 : 15);
                wheel.last = (sec > 0 ? 'forward ' : 'back ') + Math.abs(sec) + ' s';
                control('skip', sec, 'Skip');
            } else {
                wheel.last = d.dir > 0 ? 'next' : 'previous';
                control(d.dir > 0 ? 'next' : 'previous', null, wheel.last);
            }
            log.info('music: wheel ' + wheel.last);
        }
        if (ctx.signals && ctx.signals.watch) {
            ctx.signals.watch(WHEEL, '1', { statusSearchSwitch1: onSkip }, log).then((r) => log.info('music: steering wheel ' + (r && r.available ? 'watched' : 'not available yet' + (r && r.error ? ': ' + r.error : ''))))
                .catch((e) => log.warn('music: steering wheel: ' + e));
        }

        /* ---------- the speakers and the cluster ---------- */
        const carAudio = createCarAudio(ctx.signals, log, { file: ctx.dataDir ? path.join(ctx.dataDir, 'car-audio.json') : null });
        let soundUntil = 0;
        function sync() {
            const on = musicOn() || !!(st && st.player && st.player.running);
            if (on) soundUntil = Date.now() + 5000;
            carAudio.want(on || Date.now() < soundUntil);
        }
        const offsetOf = (k) => { const v = Number(ctx.settings.get(k)); return isFinite(v) ? Math.max(-160, Math.min(160, v)) : 0; };
        const card = createClusterCard({ log, png, Canvas,
            enabled: () => ctx.settings.get('cluster') !== false,
            offset: () => ({ dx: offsetOf('clusterX'), dy: offsetOf('clusterY') }),
            cover: (id) => { const e = covers.artImage(Number(String(id).split('|')[0])); return e ? { w: e.w, h: e.h, data: e.data } : null; },
            info: () => {
                const c = client(), m = c.meta;
                if (!musicOn() || !m || !m.title) return null;
                const pos = position(c);
                return { id: (st.artVer || 0) + '|' + m.title, name: m.title, sub: m.artist || m.album || '', pos: pos != null ? pos / 1000 : null,
                    dur: m.durationMs ? m.durationMs / 1000 : null, paused: c.playback === 'paused', loading: false };
            } });
        setInterval(() => { try { card.update(); } catch (e) { log.warn('cluster: ' + (e && e.stack || e)); } }, 1000);
        if (ctx.app && ctx.app.on) ctx.app.on('shutdown', () => { card.close(); carAudio.want(false); });

        /* ---------- data: home, library, search, an item, the queue ---------- */
        const home = { rows: null, loading: false, error: null, first: 0 };
        function loadHome() {
            home.loading = true; home.error = null;
            req('home').then((rows) => { home.rows = rows.map((r) => Object.assign(r, { items: null, loading: false })); home.loading = false; render(); },
                (e) => { home.loading = false; home.error = e.message; render(); });
        }
        function loadRow(r) {
            if (r.items || r.loading) return;
            r.loading = true;
            req('row', { provider: r.provider, itemId: r.itemId }).then((items) => { r.items = items; r.loading = false; render(); },
                () => { r.items = []; r.loading = false; render(); });
        }
        const lib = { kind: 0, lists: {}, first: 0 };
        function libList() {
            const k = KINDS[lib.kind][0];
            let l = lib.lists[k];
            if (!l) { l = lib.lists[k] = { items: [], loading: false, done: false, error: null }; moreLib(l, k); }
            return l;
        }
        function moreLib(l, k) {
            if (l.loading || l.done) return;
            l.loading = true;
            req('library', { kind: k, offset: l.items.length, limit: 60 }).then((items) => {
                l.items = l.items.concat(items); l.loading = false; if (items.length < 60) l.done = true; render();
            }, (e) => { l.loading = false; l.error = e.message; render(); });
        }
        const search = { q: '', results: null, loading: false, error: null, keys: true, first: 0 };
        function runSearch() {
            if (!search.q.trim()) return;
            search.loading = true; search.keys = false; search.results = null; search.error = null; search.first = 0; render();
            req('search', { q: search.q.trim() }, 45000).then((r) => { search.results = r; search.loading = false; render(); },
                (e) => { search.loading = false; search.error = e.message; render(); });
        }
        // what was opened over the tab: [{ kind: 'item', uri, data, ... } | { kind: 'row', row }]
        const stack = [];
        function openItem(item) {
            const e = { kind: 'item', uri: item.uri, item, data: null, error: null, first: 0 };
            stack.push(e);
            req('open', { uri: item.uri }).then((d) => { e.data = d; render(); }, (err) => { e.error = err.message; render(); });
            render();
        }
        function act(item) {
            if (!item) return undefined;
            if (OPENS.indexOf(item.type) >= 0) return openItem(item);
            if (item.type === 'folder') return say('Folders open in the Music Assistant app');
            return play(item);
        }
        const back = () => { stack.pop(); render(); };
        const queue = { items: [], index: -1, at: 0, loading: false };
        function loadQueue() {
            if (queue.loading || Date.now() - queue.at < 15000 || !signedIn()) return;
            queue.loading = true;
            req('queue').then((q) => { Object.assign(queue, q, { at: Date.now(), loading: false }); render(); }, () => { queue.loading = false; queue.at = Date.now(); });
        }

        /* ---------- scrolling: a finger dragged on the page, the knob along the targets ---------- */
        let acc = 0;
        const STEP = { home: 226, grid: 196, list: 46 };
        function scroller() {
            if (stack.length) { const e = stack[stack.length - 1]; return e.kind === 'row' ? { obj: e, step: STEP.grid, max: Math.max(0, Math.ceil(((e.row.items || []).length) / 9) - 2) } : { obj: e, step: STEP.list, max: Math.max(0, ((e.data && e.data.children) || []).length - 8) }; }
            if (tab === T_HOME) return { obj: home, step: STEP.home, max: Math.max(0, visibleRows().length - 2) };
            if (tab === T_LIB) { const l = libList(); return { obj: lib, step: STEP.grid, max: Math.max(0, Math.ceil(l.items.length / 9) - 2), more: () => moreLib(l, KINDS[lib.kind][0]) }; }
            if (tab === T_SEARCH && search.results) return { obj: search, step: STEP.home, max: Math.max(0, search.results.length - 2) };
            return null;
        }
        if (ctx.onScroll) {
            ctx.onScroll((dy) => {
                const s = scroller();
                if (!s) return false;
                const k = ctx.display && ctx.display.place && ctx.display.place.scale ? ctx.display.place.scale : 1;
                acc += dy / k;
                const steps2 = acc > 0 ? Math.floor(acc / s.step) : Math.ceil(acc / s.step);
                if (!steps2) return true;
                acc -= steps2 * s.step;
                const to = Math.max(0, Math.min(s.max, s.obj.first + steps2));
                if (to === s.obj.first) return false;
                s.obj.first = to;
                if (s.more && to >= s.max - 1) s.more();
                render();
                return true;
            });
        }
        const disp0 = ctx.display;
        if (disp0 && typeof disp0._ring === 'function') {
            const ring0 = disp0._ring.bind(disp0);
            disp0._ring = () => ring0().filter((p) => !p.scroll);
        }
        if (disp0 && typeof disp0._focus === 'function') {
            // the knob on the last line shown (or the first) moves the page a line on, so the next one is there to turn to
            const focus0 = disp0._focus.bind(disp0);
            disp0._focus = (p) => { focus0(p); follow(p && p.k); };
        }
        function follow(key) {
            const m = /^tgt:(?:[a-z]+):(\d+):(?:\d+)$/.exec(key || '') || /^tgt:li:(\d+)$/.exec(key || '');
            if (!m) return;
            const s = scroller();
            if (!s) return;
            const line = Number(m[1]), slot = line - s.obj.first, shown = s.step === STEP.list ? 8 : 2;
            let to = s.obj.first;
            if (slot >= shown - 1 && line < s.max + shown - 1) to = Math.min(s.max, line - shown + 2);
            else if (slot <= 0 && line > 0) to = Math.max(0, line - 1);
            if (to !== s.obj.first) { s.obj.first = to; if (s.more && to >= s.max - 1) s.more(); render(); }
        }
        if (ctx.onTab) ctx.onTab((i) => { tab = i; stack.length = 0; acc = 0; if (i === T_PLAY) queue.at = 0; return render(); });

        /* ---------- drawing ---------- */
        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const c = client();
            const live = !signedIn() ? null : c.conn !== 'connected' ? { text: c.conn === 'reconnecting' ? 'RECONNECTING' : 'CONNECTING', color: 'accent' }
                : c.playback === 'playing' ? { text: 'PLAYING', color: 'cold' } : c.playback === 'paused' ? { text: 'PAUSED' } : null;
            G.frame(cv, t, TABS, tab, [busy && { text: ascii(busy).slice(0, 48), color: 'accent' }, st && st.page && st.page.open && { text: 'SIGN-IN ' + Math.ceil((st.page.left || 0) / 60) + ' MIN' }, live]);
            const touch = !!(cv.own && cv.target);
            try {
                if (!st || !signedIn()) drawWelcome(cv, t, touch);
                else if (stack.length) drawStack(cv, t, touch);
                else if (tab === T_HOME) drawHome(cv, t, touch);
                else if (tab === T_LIB) drawLibrary(cv, t, touch);
                else if (tab === T_SEARCH) drawSearch(cv, t, touch);
                else if (tab === T_PLAY) drawPlaying(cv, t, touch);
                else drawStatus(cv, t);
            } catch (e) { log.warn('music draw: ' + (e && e.stack || e)); }
            if (toast && Date.now() - toast.at < 5000) {
                const w = Math.min(1200, cv.textWidth(ascii(toast.text), 20, { literal: true }) + 48);
                cv.roundRect((W - w) / 2, H - 58, w, 42, 21, toast.bad ? [120, 30, 34, 235] : [30, 36, 44, 235]);
                cv.text(clip(cv, toast.text, 20, w - 40, 'label'), W / 2, H - 30, 20, t.text, { align: 'center', literal: true });
            }
            return ui.image('MAIN_GFX', cv);
        }

        /** a tile: the cover, the name and what it is; a tap acts on it */
        function tile(cv, t, touch, item, x, y, size, key) {
            covers.draw(cv, item.img, x, y, size, item.type === 'artist' ? size / 2 : 8, item.name);
            if (item.type === 'radio' || item.type === 'track') {
                cv.circle(x + size - 22, y + size - 22, 16, withAlpha(GREEN, 0.92));
                cv.quad([[x + size - 28, y + size - 31], [x + size - 13, y + size - 22], [x + size - 28, y + size - 13], [x + size - 28, y + size - 13]], '#000000');
            }
            cv.text(clip(cv, item.name, 18, size + 8, 'bold'), x, y + size + 24, 18, t.text, { font: 'bold', literal: true });
            cv.text(clip(cv, item.sub, 16, size + 8, 'label'), x, y + size + 46, 16, t.dim, { literal: true });
            if (touch) cv.target(x - 6, y - 6, size + 12, size + 58, () => act(item), key, 10);
        }
        function arrows(cv, t, touch, s, total, x, y) {
            if (total <= 0) return;
            const up = s.obj.first > 0, down = s.obj.first < s.max;
            cv.text((s.obj.first + 1) + ' / ' + (s.max + 1), x - 96, y + 6, 16, t.dim, { align: 'right', literal: true });
            cv.quad([[x - 80, y + 8], [x - 70, y - 4], [x - 60, y + 8], [x - 60, y + 8]], up ? t.text : withAlpha('#ffffff', 0.2));
            cv.quad([[x - 34, y - 4], [x - 14, y - 4], [x - 24, y + 8], [x - 24, y + 8]], down ? t.text : withAlpha('#ffffff', 0.2));
            if (touch) {
                cv.target(x - 92, y - 18, 44, 40, () => { s.obj.first = Math.max(0, s.obj.first - 1); render(); }, 'up', 8);
                cv.target(x - 46, y - 18, 44, 40, () => { s.obj.first = Math.min(s.max, s.obj.first + 1); if (s.more && s.obj.first >= s.max - 1) s.more(); render(); }, 'down', 8);
            }
        }
        function message(cv, t, text, sub) {
            cv.text(ascii(text), W / 2, 230, 28, t.text, { align: 'center', font: 'bold', literal: true });
            if (sub) cv.text(clip(cv, sub, 20, 1400, 'label'), W / 2, 270, 20, t.dim, { align: 'center', literal: true });
        }

        /** not signed in: what to do, and the QR code while the page is open */
        function drawWelcome(cv, t, touch) {
            if (!st) { message(cv, t, 'The Music Assistant service does not answer', 'Install "Music Assistant service" from the Store, then restart the head unit once.'); return; }
            const page = st.page && st.page.open ? st.page : null;
            if (tab === T_STATUS) return drawStatus(cv, t);
            cv.text('Music Assistant', 60, 130, 44, t.text, { font: 'bold', literal: true });
            const lines2 = ['Your music server, in the car: its recommendations, your library,', 'search, and what plays on the cluster. Skip on the steering wheel works.',
                '', page ? 'Scan the code with the iPhone (on the car Wi-Fi for wireless CarPlay),' : 'Press "Sign in" (below) and scan the code with the iPhone.',
                page ? 'enter the server\'s address and your user and password, or a token.' : 'You need your server\'s address from outside your home (e.g. music.example.com).'];
            lines2.forEach((l, i) => cv.text(l, 60, 186 + i * 32, 22, i < 2 ? t.text : t.dim, { literal: true }));
            if (st.lastSignIn && st.lastSignIn.error) cv.text(clip(cv, 'Last try: ' + st.lastSignIn.error, 20, 900, 'label'), 60, 380, 20, RED, { literal: true });
            if (!page && touch) {
                cv.roundRect(60, 410, 220, 56, 28, GREEN);
                cv.text('Sign in', 170, 446, 24, '#000000', { align: 'center', font: 'bold', literal: true });
                cv.target(60, 410, 220, 56, () => command('signin-open', 'Opening the sign-in page...'), 'signin', 28);
            }
            if (page) drawCode(cv, t, page, 1130, 70);
        }
        function drawCode(cv, t, page, x0, y0) {
            const box = 360;
            if (!page.url) {
                cv.text('No car Wi-Fi yet:', x0, y0 + 40, 22, t.text, { font: 'bold', literal: true });
                cv.text('connect the iPhone with wireless CarPlay', x0, y0 + 72, 18, t.dim, { literal: true });
                return;
            }
            if (codeFor !== page.url) { code = qr(page.url); codeFor = page.url; }
            const cell = Math.floor(box / (code.n + 8)), size = cell * (code.n + 8);
            const ox = x0 + Math.floor((box - size) / 2), oy = y0;
            cv.fillRect(ox, oy, size, size, '#ffffff');
            for (let r = 0; r < code.n; r++) for (let cc = 0; cc < code.n; cc++) if (code.dark(r, cc)) cv.fillRect(ox + (cc + 4) * cell, oy + (r + 4) * cell, cell, cell, '#000000');
            cv.text('Scan with the iPhone camera', x0 + box / 2, oy + size + 32, 20, t.text, { font: 'bold', align: 'center', literal: true });
            cv.text(clip(cv, page.url, 16, box + 40, 'label'), x0 + box / 2, oy + size + 56, 16, t.dim, { align: 'center', literal: true });
        }

        /** Home: the rows, two at a time, up to 8 covers each (a ninth opens the whole row) */
        function visibleRows() { return (home.rows || []).filter((r) => !(r.items && r.items.length === 0)); }
        function drawHome(cv, t, touch) {
            if (!home.rows) { message(cv, t, home.error ? 'Could not load the home page' : 'Loading...', home.error || ''); if (home.error && touch) cv.target(600, 200, 400, 80, () => loadHome(), 'retry', 8); return; }
            if (touch) cv.scroll = true;
            const rows = visibleRows();
            const s = { obj: home, max: Math.max(0, rows.length - 2) };
            home.first = Math.min(home.first, s.max);
            rows.slice(home.first, home.first + 3).forEach((r) => loadRow(r));
            rows.slice(home.first, home.first + 2).forEach((r, k) => drawShelf(cv, t, touch, r.name, r.items, r.loading, TOP + 4 + k * 226, 'h:' + (home.first + k), () => { stack.push({ kind: 'row', row: r, first: 0 }); render(); }));
            arrows(cv, t, touch, s, rows.length, W - 24, TOP + 22);
        }
        function drawShelf(cv, t, touch, name, items, loading, y, key, more) {
            cv.text(clip(cv, name, 24, 1100, 'bold'), 24, y + 24, 24, t.text, { font: 'bold', literal: true });
            if (!items) { cv.text(loading ? 'Loading...' : '', 24, y + 110, 18, t.dim, { literal: true }); return; }
            const size = 140, gap = 30;
            const n = items.length > 9 ? 8 : 9;
            items.slice(0, n).forEach((it, i) => tile(cv, t, touch, it, 24 + i * (size + gap), y + 36, size, key + ':' + i));
            if (items.length > 9) {
                const x = 24 + 8 * (size + gap);
                cv.roundRect(x, y + 36, size, size, 8, withAlpha('#ffffff', 0.08));
                cv.text('All ' + items.length, x + size / 2, y + 36 + size / 2 + 8, 22, t.text, { align: 'center', font: 'bold', literal: true });
                if (touch) cv.target(x - 6, y + 30, size + 12, size + 58, more, key + ':8', 10);
            }
        }

        /** a grid of tiles, 9 a line, two lines and a part shown */
        function drawGrid(cv, t, touch, items, obj, y0, keyPrefix, more) {
            const size = 140, gap = 30, lineH = 196, per = 9;
            const lines = Math.ceil(items.length / per);
            const s = { obj, max: Math.max(0, lines - 2), more };
            obj.first = Math.min(obj.first, s.max);
            for (let li = obj.first; li < Math.min(lines, obj.first + 3); li++) {
                const y = y0 + (li - obj.first) * lineH;
                if (y + size > H) break;
                items.slice(li * per, li * per + per).forEach((it, i) => tile(cv, t, touch, it, 24 + i * (size + gap), y, size, keyPrefix + ':' + li + ':' + i));
            }
            return s;
        }
        function drawLibrary(cv, t, touch) {
            if (touch) cv.scroll = true;
            KINDS.forEach((k, i) => {
                const x = 24 + i * 150, on = i === lib.kind;
                cv.roundRect(x, TOP + 6, 136, 40, 20, on ? GREEN : withAlpha('#ffffff', 0.1));
                cv.text(k[1], x + 68, TOP + 33, 18, on ? '#000000' : t.text, { align: 'center', font: 'bold', literal: true });
                if (touch) cv.target(x, TOP + 6, 136, 40, () => { lib.kind = i; lib.first = 0; render(); }, 'kind' + i, 20);
            });
            const l = libList();
            if (!l.items.length) { message(cv, t, l.loading ? 'Loading...' : l.error ? 'Could not load: ' + l.error : 'Nothing here yet'); return; }
            const s = drawGrid(cv, t, touch, l.items, lib, TOP + 62, 'l', () => moreLib(l, KINDS[lib.kind][0]));
            arrows(cv, t, touch, s, l.items.length, W - 24, TOP + 26);
        }

        /** Search: the keyboard, or the results as rows */
        const KEYS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
        function drawSearch(cv, t, touch) {
            cv.roundRect(24, TOP + 6, 900, 50, 25, withAlpha('#ffffff', 0.1));
            cv.text(search.q ? clip(cv, search.q, 24, 820, 'label') + (search.keys ? '_' : '') : 'What do you want to listen to?', 52, TOP + 40, 24, search.q ? t.text : t.dim, { literal: true });
            if (touch) cv.target(24, TOP + 6, 900, 50, () => { search.keys = true; render(); }, 'field', 25);
            if (search.keys) return drawKeys(cv, t, touch);
            if (touch) cv.scroll = true;
            if (search.loading) return message(cv, t, 'Searching...');
            if (search.error) return message(cv, t, 'Could not search', search.error);
            const r = search.results || [];
            if (!r.length) return message(cv, t, 'Nothing found');
            const s = { obj: search, max: Math.max(0, r.length - 2) };
            search.first = Math.min(search.first, s.max);
            r.slice(search.first, search.first + 2).forEach((sec, k) => drawShelf(cv, t, touch, sec.name, sec.items, false, TOP + 60 + k * 212, 's:' + (search.first + k), () => { stack.push({ kind: 'row', row: { name: sec.name, items: sec.items }, first: 0 }); render(); }));
            arrows(cv, t, touch, s, r.length, W - 24, TOP + 30);
        }
        function drawKeys(cv, t, touch) {
            const kw = 112, kh = 62, gap = 10, y0 = TOP + 86;
            KEYS.forEach((row, ri) => {
                const x0 = 24 + ri * (kw / 2);
                row.split('').forEach((ch, i) => {
                    const x = x0 + i * (kw + gap), y = y0 + ri * (kh + gap);
                    cv.roundRect(x, y, kw, kh, 10, withAlpha('#ffffff', 0.12));
                    cv.text(ch.toUpperCase(), x + kw / 2, y + 41, 26, t.text, { align: 'center', font: 'bold', literal: true });
                    if (touch) cv.target(x, y, kw, kh, () => { search.q += ch; render(); }, 'k' + ch, 10);
                });
            });
            const y = y0 + 3 * (kh + gap);
            const keys = [['Space', 360, () => { search.q += ' '; }], ['Delete', 200, () => { search.q = search.q.slice(0, -1); }],
                ['Clear', 180, () => { search.q = ''; }], ['Search', 260, () => runSearch()]];
            let x = 24 + kw;
            keys.forEach((k) => {
                const go = k[0] === 'Search';
                cv.roundRect(x, y, k[1], kh, 10, go ? GREEN : withAlpha('#ffffff', 0.12));
                cv.text(k[0], x + k[1] / 2, y + 40, 22, go ? '#000000' : t.text, { align: 'center', font: 'bold', literal: true });
                if (touch) cv.target(x, y, k[1], kh, () => { k[2](); render(); }, 'k-' + k[0], 10);
                x += k[1] + gap;
            });
            if (search.results) {
                cv.text('Results', 1330, TOP + 40, 20, t.dim, { literal: true });
                if (touch) cv.target(1300, TOP + 6, 200, 50, () => { search.keys = false; render(); }, 'results', 8);
            }
        }

        /** an album / playlist / artist, or a whole home row */
        function drawStack(cv, t, touch) {
            const e = stack[stack.length - 1];
            if (touch) cv.scroll = true;
            cv.roundRect(24, TOP + 6, 110, 40, 20, withAlpha('#ffffff', 0.12));
            cv.text('< Back', 79, TOP + 33, 18, t.text, { align: 'center', font: 'bold', literal: true });
            if (touch) cv.target(24, TOP + 6, 110, 40, back, 'back', 20);
            if (e.kind === 'row') {
                cv.text(clip(cv, e.row.name, 26, 1100, 'bold'), 160, TOP + 36, 26, t.text, { font: 'bold', literal: true });
                const s = drawGrid(cv, t, touch, e.row.items || [], e, TOP + 62, 'r');
                arrows(cv, t, touch, s, (e.row.items || []).length, W - 24, TOP + 26);
                return;
            }
            const it = (e.data && e.data.item) || e.item;
            covers.draw(cv, it.img, 24, TOP + 62, 240, it.type === 'artist' ? 120 : 10, it.name);
            cv.text(clip(cv, it.name, 26, 260, 'bold'), 24, TOP + 340, 26, t.text, { font: 'bold', literal: true });
            cv.text(clip(cv, it.sub + (it.year ? '  ' + it.year : ''), 18, 260, 'label'), 24, TOP + 368, 18, t.dim, { literal: true });
            const kids = (e.data && e.data.children) || [];
            if (it.type !== 'artist' && kids.length) {
                cv.roundRect(24, TOP + 392, 120, 48, 24, GREEN);
                cv.text('Play', 84, TOP + 424, 20, '#000000', { align: 'center', font: 'bold', literal: true });
                cv.roundRect(154, TOP + 392, 130, 48, 24, withAlpha('#ffffff', 0.12));
                cv.text('Shuffle', 219, TOP + 424, 20, t.text, { align: 'center', font: 'bold', literal: true });
                if (touch) {
                    cv.target(24, TOP + 392, 120, 48, () => play(it), 'play', 24);
                    cv.target(154, TOP + 392, 130, 48, () => control('shuffle', true, 'Shuffle').then(() => play(it)), 'shuffle', 24);
                }
            }
            if (!e.data) { cv.text(e.error ? 'Could not open: ' + ascii(e.error) : 'Loading...', 320, TOP + 120, 20, e.error ? RED : t.dim, { literal: true }); return; }
            const rows = 9, rowH = 46, x0 = 320, w = 1256, y0 = TOP + 56;
            const s = { obj: e, max: Math.max(0, kids.length - rows + 1) };
            e.first = Math.min(e.first, s.max);
            arrows(cv, t, touch, s, kids.length, W - 24, TOP + 26);
            const playing = client().meta && client().meta.title;
            kids.slice(e.first, e.first + rows).forEach((k, i) => {
                const y = y0 + i * rowH, n = e.first + i, isOn = playing && ascii(k.name) === ascii(playing);
                if (isOn) cv.fillRect(x0 - 8, y, w + 8, rowH - 4, withAlpha(GREEN, 0.18));
                if (k.type === 'track' || k.type === 'podcast_episode') cv.text(String(n + 1), x0 + 24, y + 29, 18, isOn ? GREEN : t.dim, { align: 'right', literal: true });
                else covers.draw(cv, k.img, x0, y + 2, 38, 4, k.name);
                cv.text(clip(cv, k.name, 20, 760, k.type === 'track' ? 'label' : 'bold'), x0 + 50, y + 29, 20, isOn ? GREEN : t.text, { literal: true });
                cv.text(clip(cv, k.type === 'track' ? k.sub : k.type === 'podcast_episode' ? '' : k.type, 18, 360, 'label'), x0 + 830, y + 29, 18, t.dim, { literal: true });
                if (k.duration) cv.text(mss(k.duration * 1000), x0 + w - 16, y + 29, 18, t.dim, { align: 'right', literal: true });
                if (touch) cv.target(x0 - 8, y, w + 8, rowH - 4, () => (k.type === 'track' && it.type !== 'artist' ? play(it, k) : act(k)), 'li:' + n, 6);
            });
        }

        /** Playing: the cover, what plays, the progress, the controls; the queue on the right */
        function drawPlaying(cv, t, touch) {
            const c = client(), m = c.meta;
            loadQueue();
            if (!m || !m.title) {
                message(cv, t, c.conn === 'connected' ? 'Nothing plays' : 'Connecting to Music Assistant...', c.conn === 'connected' ? 'Choose something on Home, in the Library or in Search, or send music to "' + ((st && st.device) || 'BMW iDrive') + '" from the Music Assistant app.' : c.error || '');
                return;
            }
            covers.art(cv, st.artVer || 0, 40, TOP + 18, 360, 14);
            const x = 450, w = 600;
            cv.text(clip(cv, m.title, 34, w, 'bold'), x, TOP + 80, 34, t.text, { font: 'bold', literal: true });
            cv.text(clip(cv, m.artist || '', 24, w, 'label'), x, TOP + 120, 24, t.text, { literal: true });
            cv.text(clip(cv, [m.album, m.year].filter(Boolean).join('  -  '), 20, w, 'label'), x, TOP + 152, 20, t.dim, { literal: true });
            const pos = position(c), dur = m.durationMs;
            const by = TOP + 230;
            cv.roundRect(x, by, w, 6, 3, withAlpha('#ffffff', 0.15));
            if (dur && pos != null) {
                const f = Math.max(0, Math.min(1, pos / dur));
                cv.roundRect(x, by, Math.max(6, w * f), 6, 3, c.playback === 'paused' ? t.dim : GREEN);
                cv.circle(x + w * f, by + 3, 9, '#ffffff');
                cv.text(mss(pos), x, by + 34, 18, t.dim, { literal: true });
                cv.text(mss(dur), x + w, by + 34, 18, t.dim, { align: 'right', literal: true });
                // a tap on the bar seeks there (ctx.onTap, below: a page tap that is on no target)
            } else if (c.playback === 'playing') cv.text('LIVE', x, by + 34, 18, GREEN, { font: 'bold', literal: true });
            // the controls
            const cy = TOP + 340, cx = x + w / 2;
            const btn = (bx, r, fill, drawIcon, fn, key) => { cv.circle(bx, cy, r, fill); drawIcon(bx); if (touch) cv.target(bx - r, cy - r, 2 * r, 2 * r, fn, key, r); };
            const ctl = c.controller || {};
            btn(cx - 220, 26, ctl.shuffle ? withAlpha(GREEN, 0.3) : withAlpha('#ffffff', 0.08), (bx) => cv.text('SHUF', bx, cy + 6, 14, ctl.shuffle ? GREEN : t.dim, { align: 'center', font: 'bold', literal: true }),
                () => control('shuffle', !ctl.shuffle, 'Shuffle'), 'shuffle');
            btn(cx - 110, 32, withAlpha('#ffffff', 0.1), (bx) => { cv.fillRect(bx - 14, cy - 12, 4, 24, t.text); cv.quad([[bx + 12, cy - 12], [bx + 12, cy + 12], [bx - 8, cy], [bx - 8, cy]], t.text); },
                () => control('previous', null, 'Previous'), 'prev');
            btn(cx, 42, '#ffffff', (bx) => {
                if (c.playback === 'playing') { cv.fillRect(bx - 12, cy - 15, 8, 30, '#000000'); cv.fillRect(bx + 4, cy - 15, 8, 30, '#000000'); }
                else cv.quad([[bx - 10, cy - 16], [bx + 16, cy], [bx - 10, cy + 16], [bx - 10, cy + 16]], '#000000');
            }, () => control('play_pause', null, 'Play / Pause'), 'playpause');
            btn(cx + 110, 32, withAlpha('#ffffff', 0.1), (bx) => { cv.fillRect(bx + 10, cy - 12, 4, 24, t.text); cv.quad([[bx - 12, cy - 12], [bx + 8, cy], [bx - 12, cy + 12], [bx - 12, cy + 12]], t.text); },
                () => control('next', null, 'Next'), 'next');
            const rep = ctl.repeat || 'off';
            btn(cx + 220, 26, rep !== 'off' ? withAlpha(GREEN, 0.3) : withAlpha('#ffffff', 0.08), (bx) => cv.text(rep === 'one' ? 'REP 1' : 'REP', bx, cy + 6, 14, rep !== 'off' ? GREEN : t.dim, { align: 'center', font: 'bold', literal: true }),
                () => control('repeat', rep === 'off' ? 'all' : rep === 'all' ? 'one' : 'off', 'Repeat'), 'repeat');
            if (c.ahead) cv.text(Math.round(c.ahead / 1000) + ' s buffered', x, TOP + 430, 16, t.dim, { literal: true });
            // up next
            const qx = 1110, qw = 466;
            cv.fillRect(qx - 20, TOP + 10, 1, 450, withAlpha('#ffffff', 0.12));
            cv.text('Up next', qx, TOP + 36, 22, t.text, { font: 'bold', literal: true });
            const next = (queue.items || []).filter((q) => q.index > queue.index).slice(0, 8);
            if (!next.length) cv.text(queue.loading ? 'Loading...' : 'Nothing queued after this', qx, TOP + 76, 18, t.dim, { literal: true });
            next.forEach((q, i) => {
                const y = TOP + 56 + i * 52;
                covers.draw(cv, q.img, qx, y, 44, 4, q.name);
                cv.text(clip(cv, q.name, 18, qw - 60, 'label'), qx + 56, y + 20, 18, t.text, { literal: true });
                cv.text(clip(cv, q.sub, 16, qw - 60, 'label'), qx + 56, y + 40, 16, t.dim, { literal: true });
                if (touch) cv.target(qx - 6, y - 4, qw, 50, () => control('play_index', q.queueItemId || q.index, 'Play'), 'q:' + i, 6);
            });
        }

        function drawStatus(cv, t) {
            const x = { carAudio: carAudio.state(), cluster: card.state(), wheel: Object.assign(wheel, { on: ctx.settings.get('wheel') !== false }) };
            const rows = steps(st, x);
            const COL = { ok: GREEN, wait: AMBER, bad: RED, off: withAlpha('#ffffff', 0.3) };
            const page = st && st.page && st.page.open ? st.page : null;
            const textW = page ? 820 : 1300, rowH = 42;
            rows.forEach((r, i) => {
                const y = TOP + 34 + i * rowH;
                cv.circle(44, y - 8, 10, COL[r.state]);
                cv.text(r.label, 68, y, 22, t.text, { font: 'bold', literal: true });
                cv.text(clip(cv, r.detail || '', 20, textW, 'label'), 230, y, 20, r.state === 'off' ? t.dim : t.text, { literal: true });
            });
            if (page) return drawCode(cv, t, page, 1150, 60);
            const n = Math.max(2, Math.floor((H - 10 - (TOP + 34 + rows.length * rowH)) / 20));
            (st && st.log ? st.log : []).slice(-n).forEach((l, i, a) => cv.text(clip(cv, l, 15, 1520, 'label'), 44, H - 12 - (a.length - 1 - i) * 20, 15, t.dim, { literal: true }));
        }

        // a tap on the progress bar: seek where it was tapped
        if (ctx.onTap) ctx.onTap((x) => {
            if (tab !== T_PLAY || stack.length) return;
            const c = client(), m = c.meta;
            if (!m || !m.durationMs || x < 440 || x > 1060) return;
            const f = Math.max(0, Math.min(1, (x - 450) / 600));
            control('seek', Math.round(f * m.durationMs / 1000), 'Seek');
        });

        // the status every second while the page shows; in the background every 2 s while music plays (the speakers,
        // the cluster)
        function shown() { return !ui.isVisible || ui.isVisible('MAIN'); }
        let tick = 0;
        setInterval(() => {
            tick++;
            if (shown() || (musicOn() && tick % 2 === 0) || tick % 10 === 0) poll().catch(() => {});
            sync();
        }, 1000);
        if (ui.onVisible) ui.onVisible(() => { sync(); render(); });
        await poll();
        if (process.env.MUSIC_PREVIEW_OPEN) openItem({ uri: process.env.MUSIC_PREVIEW_OPEN, name: '', sub: '', type: 'album' });
        if (process.env.MUSIC_PREVIEW_SEARCH) { search.q = process.env.MUSIC_PREVIEW_SEARCH; if (process.env.MUSIC_PREVIEW_SEARCH_RUN) runSearch(); }
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('Music Assistant first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});

module.exports = { steps, position, qr, ask };
