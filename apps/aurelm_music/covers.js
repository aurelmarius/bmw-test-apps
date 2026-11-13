'use strict';
/**
 * covers.js - the covers on the page: album, playlist, radio and artist pictures, and what plays.
 *
 * The service fetches them from Music Assistant's /imageproxy as PNG in a fixed size (80, 160, 256, 512) and keeps
 * them in memory ({"cmd":"req","what":"image"}); what plays comes from Sendspin ({"cmd":"art"}, 400 px). Here they are
 * decoded (the kit's png.js, bounded: pictures from outside), fitted to the size they are drawn at, and handed to the
 * renderer as pixel images (kit record.js setImage; mgu-render/1's IMAGE, drawn filtered with rounded corners). The
 * renderer holds 64 pictures an app: a pool of POOL ids is reused, the least recently drawn picture giving up its id.
 *
 *   const covers = createCovers({ ask, png, setImage, log, onChange });
 *   covers.draw(cv, key, x, y, size, r, label)   the picture `key` (a proxy id) at x, y; a plate with `label` meanwhile
 *   covers.art(cv, ver, x, y, size, r)           what plays (Sendspin's artwork of version ver)
 *   covers.version()                             changes when a picture arrives (redraw)
 */
const POOL = 48, FIRST_ID = 7000, PARALLEL = 3, RETRY_MS = 5 * 60 * 1000;
const PLATE = [0x28, 0x2d, 0x34, 0xff];

function createCovers(o) {
    const log = o.log || { info() {}, warn() {} };
    const map = new Map();            // key|size -> { state, id, w, h, data, at, used }
    const free = [];
    for (let i = 0; i < POOL; i++) free.push(FIRST_ID + i);
    const queue = [];
    let running = 0, ver = 0;

    function changed() { ver++; if (o.onChange) { try { o.onChange(); } catch (e) { /* the app's */ } } }
    /** an id for a new picture: a free one, else the one drawn longest ago */
    function takeId() {
        if (free.length) return free.shift();
        let old = null, oldKey = null;
        map.forEach((e, k) => { if (e.id != null && (!old || e.used < old.used)) { old = e; oldKey = k; } });
        if (!old) return null;
        const id = old.id;
        map.delete(oldKey);
        return id;
    }
    function decode(key, buf, size) {
        return new Promise((res) => o.png.decodeAsync(buf, (err, img) => {
            if (err) { log.info('cover ' + String(key).slice(0, 8) + ': ' + err.message); map.set(key, { state: 'none', at: Date.now() }); return res(); }
            const f = Math.max(img.w, img.h) > size ? o.png.fit(img, size) : img;
            const id = takeId();
            if (id == null) { map.set(key, { state: 'none', at: Date.now() }); return res(); }
            o.setImage(id, f.w, f.h, f.data);
            map.set(key, { state: 'ok', id, w: f.w, h: f.h, data: f.data, at: Date.now(), used: Date.now() });
            changed();
            res();
        }));
    }
    function pump() {
        while (running < PARALLEL && queue.length) {
            const q = queue.shift();
            running++;
            q.run().then(() => { running--; pump(); }, () => { running--; pump(); });
        }
    }
    function want(mapKey, run) {
        const e = map.get(mapKey);
        if (e && (e.state !== 'none' || Date.now() - e.at < RETRY_MS)) return e;
        map.set(mapKey, { state: 'loading', at: Date.now() });
        queue.push({ run });
        pump();
        return map.get(mapKey);
    }
    /** a picture by its proxy id, asked for in the size it is drawn at (the next larger the server makes) */
    function entry(key, size) {
        const ask = size <= 80 ? 80 : size <= 160 ? 160 : size <= 256 ? 256 : 512;
        const mk = key + '|' + ask;
        return want(mk, () => o.ask('req', { what: 'image', args: { key, size: ask } }, 30000).then((r) => {
            if (!r || !r.ok || !r.data) { map.set(mk, { state: 'none', at: Date.now() }); return; }
            return decode(mk, Buffer.from(r.data, 'base64'), ask);
        }));
    }
    function plate(cv, x, y, size, r, label) {
        cv.roundRect(x, y, size, size, r || 0, PLATE);
        if (label) {
            const t = String(label).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
            const s = Math.round(size * 0.28);
            cv.text(t || '?', x + size / 2, y + size / 2 + s * 0.36, s, 0xffffff60, { align: 'center', font: 'bold', literal: true });
        }
    }
    function put(cv, e, x, y, size, r) {
        e.used = Date.now();
        // the picture keeps its shape inside the square (most are square)
        const k = Math.min(size / e.w, size / e.h), w = Math.round(e.w * k), h = Math.round(e.h * k);
        const px = x + Math.round((size - w) / 2), py = y + Math.round((size - h) / 2);
        if (typeof cv.image === 'function') cv.image(e.id, px, py, w, h, r || 0);
        else if (typeof cv.drawImage === 'function') cv.drawImage(e.data, e.w, e.h, px, py, w, h);
    }
    function draw(cv, key, x, y, size, r, label) {
        if (!key) { plate(cv, x, y, size, r, label); return false; }
        const e = entry(key, size);
        if (!e || e.state !== 'ok') { plate(cv, x, y, size, r, label); return false; }
        plate(cv, x, y, size, r, null);
        put(cv, e, x, y, size, r);
        return true;
    }
    let artVer = -1;
    function art(cv, v, x, y, size, r) {
        const mk = 'art|' + v;
        if (v !== artVer) {
            // the last track's picture gives its id back
            map.forEach((e, k) => { if (k.indexOf('art|') === 0 && k !== mk && e.id != null) { free.push(e.id); map.delete(k); } });
            artVer = v;
        }
        const e = v ? want(mk, () => o.ask('art', {}, 15000).then((r2) => {
            if (!r2 || !r2.png) { map.set(mk, { state: 'none', at: Date.now() }); return; }
            return decode(mk, Buffer.from(r2.png, 'base64'), 400);
        })) : null;
        if (!e || e.state !== 'ok') { plate(cv, x, y, size, r, null); return false; }
        plate(cv, x, y, size, r, null);
        put(cv, e, x, y, size, r);
        return true;
    }
    /** the current artwork, decoded (the cluster card) */
    function artImage(v) { const e = map.get('art|' + v); return e && e.state === 'ok' ? e : null; }
    return { draw, art, artImage, version: () => ver, stats: () => ({ pictures: map.size, free: free.length }) };
}

module.exports = { createCovers, POOL };
