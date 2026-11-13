'use strict';
/**
 * cluster_card.js - what plays on the instrument cluster: its cover, the title, the artist, the time and how far it is;
 * over the media widget in the right dial, while music plays. Emby's card (apps/aurelm_emby/cluster_card.js 0.3.12),
 * with the music's cover (Sendspin's artwork, square) in the poster's place.
 *
 * Why a card of our own: the cluster's media widget shows what BMW's mediaapp fills in, and the sound comes in by
 * the CarLife input (source 287), so the widget says CarLife's "Not connected" (Media Probe 0.1.2: CarLifeMp takes
 * fields, but nothing shows them on a European car). So the card is drawn over it, through cluster-render
 * (robertnisipeanu/idrive-apps, the Store; Waze on cluster installs it): an image layer on its `panel` target.
 *
 *   const card = createClusterCard({ log, png, Canvas (the kit's), info, cover, enabled, offset });
 *   info()  -> { id, name, sub, pos, dur, paused, loading } | null      cover(id) -> { w, h, data } | null (RGBA)
 *   card.update()     called each second: shows, hides, draws again when what it shows changes (at most every 5 s)
 *   card.state()      { state: 'off'|'missing'|'waiting'|'shown'|..., detail }
 */
const fs = require('fs');

const CLIENT = '/var/opt/cluster-render/current/cluster_render_client.js';
const SOCKET = '/dev/shm/cluster-render/render.sock';
const CARD = { w: 520, h: 420 };
const PLACE = { x: 1130, y: 140 };      // panel pixels (1920x720): centred on the right dial's media widget (1390, 345)
const LOGO = { w: 150, h: 150 };        // the cover, as BMW's widget has it (square)
const MIN_MS = 5000;

// as BMW's widget: no frame, the lines centred under the cover, white and a softer white; behind them a dark field
// that fades out to the dial (an ellipse, opaque inside FADE_IN of its radius: it hides the widget underneath)
const FIELD = [10, 12, 16], FADE_IN = 0.7;
const TEXT = [255, 255, 255, 255], SOFT = [255, 255, 255, 205], DIM = [255, 255, 255, 150], BLUE = [64, 160, 235, 255], TRACK = [255, 255, 255, 46];

/** the kit's fonts have ASCII only */
const ASCII = { 'ș': 's', 'ş': 's', 'Ș': 'S', 'Ş': 'S', 'ț': 't', 'ţ': 't', 'Ț': 'T', 'Ţ': 'T', '„': '"', '“': '"', '”': '"',
    '‘': "'", '’': "'", '–': '-', '—': '-', '…': '...', 'ß': 'ss', 'æ': 'ae', 'ø': 'o', 'œ': 'oe', 'ł': 'l' };
function ascii(s) {
    return String(s || '').replace(/[\s\S]/g, (ch) => (ASCII[ch] !== undefined ? ASCII[ch] : ch)).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\x20-\x7e]/g, '');
}
/** seconds -> m:ss (h:mm:ss from an hour) */
function hm(sec) {
    const s = Math.floor(Math.max(0, sec || 0)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0');
}

function clip(cv, s, size, w, font) {
    s = String(s || '');
    if (cv.textWidth(s, size, { font, literal: true }) <= w) return s;
    while (s.length > 1 && cv.textWidth(s + '...', size, { font, literal: true }) > w) s = s.slice(0, -1);
    return s.trim() + '...';
}

/** the dark field: opaque in the middle, smoothly transparent at the ellipse's edge */
function field(cv) {
    const rx = CARD.w / 2 - 2, ry = CARD.h / 2 - 2, cx = CARD.w / 2, cy = CARD.h / 2, d = cv.d;
    for (let y = 0; y < CARD.h; y++) {
        for (let x = 0; x < CARD.w; x++) {
            const ex = (x + 0.5 - cx) / rx, ey = (y + 0.5 - cy) / ry, r = Math.sqrt(ex * ex + ey * ey);
            if (r >= 1) continue;
            const t = r <= FADE_IN ? 1 : 1 - (r - FADE_IN) / (1 - FADE_IN), a = t * t * (3 - 2 * t);
            const i = (y * CARD.w + x) * 4;
            d[i] = FIELD[0]; d[i + 1] = FIELD[1]; d[i + 2] = FIELD[2]; d[i + 3] = Math.round(a * 255);
        }
    }
}

/** the card: i = { id, name, sub, pos, dur, paused, loading, cover: { w, h, d } | null } */
function render(i, Canvas) {
    const cv = new Canvas(CARD.w, CARD.h).clear([0, 0, 0, 0]);
    field(cv);
    const cx = CARD.w / 2, w = 360, top = 40;
    if (i.cover) cv.blit(i.cover, Math.round(cx - i.cover.w / 2), top + Math.round((LOGO.h - i.cover.h) / 2));
    else {
        const pw = LOGO.w, cy = top + LOGO.h / 2, r = 22;   // the cover's place (none yet): a play sign
        cv.roundRect(cx - pw / 2, top, pw, LOGO.h, 10, [44, 50, 58, 255]);
        cv.quad([[cx - r * 0.7, cy - r], [cx + r, cy], [cx - r * 0.7, cy + r], [cx - r * 0.7, cy + r]], SOFT);
    }
    let y = top + LOGO.h + 46;
    cv.text(clip(cv, ascii(i.name), 34, w, 'label'), cx, y, 34, TEXT, { align: 'center', literal: true });
    y += 40;
    if (i.sub) { cv.text(clip(cv, ascii(i.sub), 28, w, 'label'), cx, y, 28, SOFT, { align: 'center', literal: true }); y += 38; }
    if (i.loading) cv.text('Loading...', cx, y, 26, DIM, { align: 'center', literal: true });
    else if (i.dur) {
        cv.text((i.paused ? 'Paused  ' : '') + hm(i.pos) + ' / ' + hm(i.dur), cx, y, 26, i.paused ? SOFT : TEXT, { align: 'center', literal: true });
        y += 16;
        const bw = 240, f = Math.max(0, Math.min(1, (i.pos || 0) / i.dur));
        cv.roundRect(cx - bw / 2, y, bw, 4, 2, TRACK);
        if (f > 0) cv.roundRect(cx - bw / 2, y, Math.max(4, bw * f), 4, 2, i.paused ? DIM : BLUE);
    } else if (i.paused) cv.text('Paused', cx, y, 26, SOFT, { align: 'center', literal: true });
    return cv;
}

function createClusterCard(o) {
    const log = o.log || { info() {}, warn() {} };
    const CLIENT_PATH = o.clientPath || CLIENT, SOCKET_PATH = o.socketPath || SOCKET;
    let cr = null, layer = null, loadError = null;
    let st = { state: 'off', detail: 'off in the settings' };
    let key = null, drawnAt = 0, shownWant = false, place = null;
    const covers = new Map();   // item id -> { state, img, at }

    function client() {
        if (cr) return cr;
        if (!fs.existsSync(SOCKET_PATH) && !fs.existsSync(CLIENT_PATH)) { st = { state: 'missing', detail: 'cluster-render is not installed (the Store: robertnisipeanu/idrive-apps)' }; return null; }
        let mod;
        try { mod = require(CLIENT_PATH); } catch (e) {
            if (loadError !== e.message) { loadError = e.message; log.warn('cluster: ' + e.message); }
            st = { state: 'missing', detail: 'cluster-render\'s client: ' + e.message };
            return null;
        }
        cr = new mod.ClusterRender('aurelm_music');
        cr.on('layer', (ref, s, reason) => {
            if (ref !== layer) return;
            st = { state: s, detail: s === 'shown' ? 'on the cluster' : s + (reason ? ': ' + reason : '') };
            log.info('cluster: card ' + s + (reason ? ' (' + reason + ')' : ''));
        });
        cr.on('target', (name, s, holder, reason) => { if (name === 'panel' && s !== 'shown') log.info('cluster: panel ' + s + (holder ? ' (held by ' + holder + ')' : '') + (reason ? ': ' + reason : '')); });
        cr.on('refused', (op, ref, reason) => { st = { state: 'error', detail: 'refused (' + op + '): ' + reason }; log.warn('cluster: ' + op + ' refused: ' + reason); });
        cr.on('disconnected', () => { if (layer) st = { state: 'waiting', detail: 'cluster-render restarting' }; });
        cr.connect();
        return cr;
    }

    /** the cover (the app's decoded artwork), fitted to LOGO once for each track */
    function coverOf(id) {
        const e = covers.get(id);
        if (e) return e.img;
        const src = o.cover ? o.cover(id) : null;
        if (!src) return null;
        if (covers.size > 8) covers.clear();
        const k = Math.min(LOGO.w / src.w, LOGO.h / src.h, 1);
        const f = k >= 1 ? src : o.png.fit(src, Math.max(1, Math.round(Math.max(src.w, src.h) * k)));
        const img = { w: f.w, h: f.h, d: f.data };
        covers.set(id, { img });
        return img;
    }

    function hide(why) {
        if (layer && shownWant) { cr.set(layer, { visible: 0 }); shownWant = false; log.info('cluster: card hidden (' + why + ')'); }
        key = null;
    }

    function update() {
        if (!o.enabled()) { hide('the setting'); st = { state: 'off', detail: 'off in the settings' }; return; }
        const i = o.info();
        if (!i) { hide('nothing playing'); st = { state: 'off', detail: 'nothing playing (cluster-render is asked once music plays)' }; return; }
        const c = client();
        if (!c) return;
        const off = o.offset ? o.offset() : { dx: 0, dy: 0 };
        const x = PLACE.x + (off.dx || 0), y = PLACE.y + (off.dy || 0);
        if (!layer) {
            layer = c.image({ target: 'panel', klass: 'overlay', x, y, w: CARD.w, h: CARD.h, iw: CARD.w, ih: CARD.h, visible: 0 });
            place = x + ',' + y;
            st = { state: 'waiting', detail: 'asking cluster-render for the panel' };
        } else if (place !== x + ',' + y) { c.set(layer, { x, y }); place = x + ',' + y; }
        i.cover = coverOf(i.id);
        // what is drawn changes with the track, the cover, paused or loading and the minute (the progress)
        const k = [i.id, i.name, i.sub, i.cover ? i.cover.w : 0, Math.floor((i.pos || 0) / 5), i.dur, !!i.paused, !!i.loading].join('|');
        if (k !== key && Date.now() - drawnAt >= MIN_MS) {
            const cv = render(i, o.Canvas);
            c.pixels(layer, null, Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length));
            key = k; drawnAt = Date.now();
        }
        if (!shownWant) { c.set(layer, { visible: 1 }); shownWant = true; log.info('cluster: card for ' + ascii(i.name) + ' at ' + x + ',' + y); }
    }

    function close() { if (cr) { try { cr.close(); } catch (e) { /* gone */ } } cr = null; layer = null; }

    return { update, state: () => st, close, render: (i) => render(i, o.Canvas) };
}

module.exports = { createClusterCard, render, CARD, PLACE, LOGO, ascii, hm };
