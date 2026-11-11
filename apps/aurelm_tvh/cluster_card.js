'use strict';
/**
 * cluster_card.js - the channel playing on the instrument cluster: its logo, its name, the programme on now with its
 * times and how far it is, and what follows; over the media widget in the right dial, while a channel is on.
 *
 * Why a card of our own: the cluster's media widget shows what BMW's mediaapp fills in; nothing else gives it a title
 * (Iterio's mediabridge 1.0.10 found no way: "only mediaapp fills the widget's metadata"). TVH's sound comes in by the
 * CarLife input, so the widget says CarLife's "Not connected." (0.1.8 in the car). So the card is drawn over it, through
 * cluster-render (robertnisipeanu/idrive-apps, the Store; Waze on cluster installs it): an image layer on its `panel`
 * target (1920x720, the whole cluster, over the gauges and under the telltales), transparent around the card.
 *
 * Its place (PLACE): the media widget in a 2020s G-series cluster with the map in the middle (a photo of the car,
 * 2026-11-11: the cover at about 1320-1460 x 195-330, its three lines to y 490, from 1210 to 1630 at the widest);
 * the settings move it by up to 160 px. The client is the one cluster-render installs beside itself
 * (/var/opt/cluster-render/current/cluster_render_client.js, MPL-2.0, Node 8), so it speaks the service's protocol.
 *
 *   const card = createClusterCard({ log, ask, png, Canvas (the kit's), info, enabled, offset, hm });
 *   card.update()     called each second: shows, hides, draws again when what it shows changes (at most every 5 s)
 *   card.state()      { state: 'off'|'missing'|'waiting'|'shown'|..., detail }  (the Status tab's "Cluster" row)
 *   card.render(i)    the card's RGBA (CARD.w x CARD.h) for an info i (tests)
 */
const fs = require('fs');

const CLIENT = '/var/opt/cluster-render/current/cluster_render_client.js';
const SOCKET = '/dev/shm/cluster-render/render.sock';
const CARD = { w: 440, h: 330 };
const PLACE = { x: 1170, y: 180 };      // panel pixels (1920x720): the right dial's media widget
const LOGO = { w: 200, h: 120 };        // the server's logos are 5:3
const MIN_MS = 5000;

const BG = [16, 20, 26, 255], TEXT = [255, 255, 255, 255], DIM = [255, 255, 255, 170], BLUE = [64, 160, 235, 255], TRACK = [255, 255, 255, 50];

function clip(cv, s, size, w, font) {
    s = String(s || '');
    if (cv.textWidth(s, size, { font, literal: true }) <= w) return s;
    while (s.length > 1 && cv.textWidth(s + '...', size, { font, literal: true }) > w) s = s.slice(0, -1);
    return s.trim() + '...';
}

/** the card: i = { name, title, start, stop, next: { start, title } | null, logo: { w, h, d } | null, now (ms) } */
function render(i, hm, Canvas) {
    const cv = new Canvas(CARD.w, CARD.h).clear([0, 0, 0, 0]);
    cv.roundRect(0, 0, CARD.w, CARD.h, 22, BG);
    const cx = CARD.w / 2, pad = 24, w = CARD.w - 2 * pad;
    if (i.logo) cv.blit(i.logo, Math.round(cx - i.logo.w / 2), 16 + Math.round((LOGO.h - i.logo.h) / 2));
    else {
        cv.roundRect(cx - LOGO.w / 2, 16, LOGO.w, LOGO.h, 14, [42, 48, 56, 255]);
        cv.text(clip(cv, String(i.name).replace(/^\d+\s+/, ''), 30, LOGO.w - 16, 'bold'), cx, 16 + LOGO.h / 2 + 11, 30, TEXT, { align: 'center', font: 'bold', literal: true });
    }
    let y = 16 + LOGO.h + 38;
    cv.text(clip(cv, i.name, 30, w, 'bold'), cx, y, 30, TEXT, { align: 'center', font: 'bold', literal: true });
    y += 38;
    if (i.title) {
        cv.text(clip(cv, i.title, 28, w, 'label'), cx, y, 28, TEXT, { align: 'center', literal: true });
        y += 32;
        if (i.start && i.stop && i.stop > i.start) {
            const left = Math.max(0, Math.round((i.stop * 1000 - i.now) / 60000));
            cv.text(hm(i.start) + ' - ' + hm(i.stop) + (left ? '   ' + left + ' min left' : ''), cx, y, 21, DIM, { align: 'center', literal: true });
            y += 14;
            const f = Math.max(0, Math.min(1, (i.now / 1000 - i.start) / (i.stop - i.start)));
            cv.roundRect(pad, y, w, 6, 3, TRACK);
            if (f > 0) cv.roundRect(pad, y, Math.max(6, w * f), 6, 3, BLUE);
            y += 32;
        }
        if (i.next && i.next.title) cv.text(clip(cv, hm(i.next.start) + '  ' + i.next.title, 20, w, 'label'), cx, y, 20, DIM, { align: 'center', literal: true });
    } else cv.text('No programme', cx, y, 24, DIM, { align: 'center', literal: true });
    return cv;
}

function createClusterCard(o) {
    const log = o.log || { info() {}, warn() {} };
    const CLIENT_PATH = o.clientPath || CLIENT, SOCKET_PATH = o.socketPath || SOCKET;
    let cr = null, layer = null, loadError = null;
    let st = { state: 'off', detail: 'off in the settings' };
    let key = null, drawnAt = 0, shownWant = false, place = null;
    const logos = new Map();   // uuid -> { state, img }

    function client() {
        if (cr) return cr;
        if (!fs.existsSync(SOCKET_PATH) && !fs.existsSync(CLIENT_PATH)) { st = { state: 'missing', detail: 'cluster-render is not installed (the Store: robertnisipeanu/idrive-apps)' }; return null; }
        let mod;
        try { mod = require(CLIENT_PATH); } catch (e) {
            if (loadError !== e.message) { loadError = e.message; log.warn('cluster: ' + e.message); }
            st = { state: 'missing', detail: 'cluster-render\'s client: ' + e.message };
            return null;
        }
        cr = new mod.ClusterRender('aurelm_tvh');
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

    /** the channel's logo, fitted to LOGO (asked for once; a failure tried again after 10 minutes) */
    function logoOf(uuid) {
        const e = logos.get(uuid);
        if (e && (e.state !== 'none' || Date.now() - e.at < 600000)) return e.img || null;
        logos.set(uuid, { state: 'loading', at: Date.now() });
        o.ask('logo', { uuid }, 20000).then((r) => {
            if (!r || !r.png) { logos.set(uuid, { state: 'none', at: Date.now() }); return; }
            o.png.decodeAsync(Buffer.from(r.png, 'base64'), (err, img) => {
                if (err) { logos.set(uuid, { state: 'none', at: Date.now() }); return; }
                const k = Math.min(LOGO.w / img.w, LOGO.h / img.h, 1);
                const f = k >= 1 ? img : o.png.fit(img, Math.max(1, Math.round(Math.max(img.w, img.h) * k)));
                logos.set(uuid, { state: 'ok', img: { w: f.w, h: f.h, d: f.data } });
                key = null;
            });
        }, () => logos.set(uuid, { state: 'none', at: Date.now() }));
        return null;
    }

    function hide(why) {
        if (layer && shownWant) { cr.set(layer, { visible: 0 }); shownWant = false; log.info('cluster: card hidden (' + why + ')'); }
        key = null;
    }

    function update() {
        if (!o.enabled()) { hide('the setting'); st = { state: 'off', detail: 'off in the settings' }; return; }
        const i = o.info();
        if (!i) { hide('nothing playing'); st = { state: 'off', detail: 'nothing playing (cluster-render is asked once a channel plays)' }; return; }
        const c = client();
        if (!c) return;
        const off = o.offset ? o.offset() : { dx: 0, dy: 0 };
        const x = PLACE.x + (off.dx || 0), y = PLACE.y + (off.dy || 0);
        if (!layer) {
            layer = c.image({ target: 'panel', klass: 'overlay', x, y, w: CARD.w, h: CARD.h, iw: CARD.w, ih: CARD.h, visible: 0 });
            place = x + ',' + y;
            st = { state: 'waiting', detail: 'asking cluster-render for the panel' };
        } else if (place !== x + ',' + y) { c.set(layer, { x, y }); place = x + ',' + y; }
        i.logo = logoOf(i.uuid);
        i.now = Date.now();
        // what is drawn changes with the programme, the logo and the minute (the progress)
        const k = [i.uuid, i.name, i.title, i.start, i.stop, i.next ? i.next.start + i.next.title : '', i.logo ? i.logo.w : 0, Math.floor(i.now / 60000), o.hmKey ? o.hmKey() : ''].join('|');
        if (k !== key && Date.now() - drawnAt >= MIN_MS) {
            const cv = render(i, o.hm, o.Canvas);
            c.pixels(layer, null, Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length));
            key = k; drawnAt = Date.now();
        }
        if (!shownWant) { c.set(layer, { visible: 1 }); shownWant = true; log.info('cluster: card for ' + i.name + ' at ' + x + ',' + y); }
    }

    function close() { if (cr) { try { cr.close(); } catch (e) { /* gone */ } } cr = null; layer = null; }

    return { update, state: () => st, close, render: (i) => render(i, o.hm, o.Canvas) };
}

module.exports = { createClusterCard, render, CARD, PLACE, LOGO };
