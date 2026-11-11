'use strict';
/**
 * logos.js - the channels' logos, small, for the page's list and the controls over the picture.
 *
 * The service fetches a logo once from Tvheadend (the channel's icon: its imagecache, or the address the server
 * gives) and keeps the PNG; this module asks for the ones it is about to draw ({"cmd":"logo","uuid"}), two at a
 * time, decodes them with the kit's png.js (bounded: a picture from outside), fits them into BOX (64x36, the aspect
 * kept), lays them over the tile's colour (no alpha left) and keeps them as runs of one colour along each row.
 *
 * Why runs and not a pixel image: mgu-render's own dialect (mgu-render/1, which the app needs for touch and the
 * controller) takes no pixel images (kit/runtime/renderd.js: "pixel images need the upstream dialect"). Rectangles
 * every renderer draws: a logo of flat colours is a few hundred of them, its colours rounded to 32 levels.
 *
 *   const logos = createLogos({ ask, png, log, onChange });
 *   logos.draw(rec, uuid, x, y)   draws the logo in its BOX at x, y (the tile, then the logo); false: none (yet)
 *   logos.version()               changes each time a logo arrives (a frame's key)
 *   logos.state(uuid)             'ok' | 'loading' | 'none' | undefined
 *   logos.stats()                 { ok, loading, none, why }: how many, and the last reason one is missing (the Status tab)
 *
 * A logo that is not a PNG (JPEG, SVG), too large, or missing is 'none': the channel shows its name only.
 */
const BOX = { w: 64, h: 36 };
const TILE = [0x22, 0x28, 0x2f];     // the tile behind a logo: transparent parts show it
const PARALLEL = 2;
const RETRY_MS = 10 * 60 * 1000;
const RETRY_LOST_MS = 60 * 1000;   // the service did not answer in time (the first fetch over LTE): again sooner

const hex = (r, g, b) => ((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0;

/** RGBA (straight alpha) of w x h -> over the tile, rounded to 32 levels a channel, as runs [x, y, len, colour] */
function toRuns(img) {
    const { w, h, data } = img;
    const runs = [];
    const q = (v) => Math.min(255, Math.round(v / 8) * 8);
    const tile = hex(q(TILE[0]), q(TILE[1]), q(TILE[2]));
    for (let y = 0; y < h; y++) {
        let start = 0, cur = null;
        for (let x = 0; x <= w; x++) {
            let c = null;
            if (x < w) {
                const i = (y * w + x) * 4, a = data[i + 3] / 255;
                c = hex(q(data[i] * a + TILE[0] * (1 - a)), q(data[i + 1] * a + TILE[1] * (1 - a)), q(data[i + 2] * a + TILE[2] * (1 - a)));
            }
            if (c !== cur) {
                if (cur !== null && cur !== tile) runs.push([start, y, x - start, cur]);
                start = x; cur = c;
            }
        }
    }
    return runs;
}

/** a decoded picture fitted into the box (never up) */
function fitBox(png, img) {
    const k = Math.min(BOX.w / img.w, BOX.h / img.h, 1);
    return k >= 1 ? img : png.fit(img, Math.max(1, Math.round(Math.max(img.w, img.h) * k)));
}

function createLogos(o) {
    const log = o.log || { info() {}, warn() {} };
    const png = o.png;
    const map = new Map();   // uuid -> { state, runs, w, h, at }
    const queue = [];
    let running = 0, ver = 0;

    function pump() {
        while (running < PARALLEL && queue.length) {
            const uuid = queue.shift();
            running++;
            load(uuid).then(() => { running--; pump(); }, () => { running--; pump(); });
        }
    }
    let lastWhy = null;   // the last reason a logo is missing
    function done(uuid, e) {
        if (e.state === 'none' && e.why) lastWhy = e.why;
        map.set(uuid, e);
        ver++;
        if (o.onChange) { try { o.onChange(uuid); } catch (x) { /* the app's */ } }
    }
    async function load(uuid) {
        const r = await o.ask('logo', { uuid });
        if (!r || !r.png) {
            const why = r ? r.why || 'none' : 'no answer from the service in time';
            log.info('tvh logo ' + uuid.slice(0, 6) + ': ' + why);
            return done(uuid, { state: 'none', at: Date.now(), why, retry: r ? RETRY_MS : RETRY_LOST_MS });
        }
        const buf = Buffer.from(r.png, 'base64');
        await new Promise((res) => png.decodeAsync(buf, (err, img) => {
            if (err) { log.info('tvh logo ' + uuid.slice(0, 6) + ': ' + err.message); done(uuid, { state: 'none', at: Date.now(), why: err.message, retry: RETRY_MS }); return res(); }
            const f = fitBox(png, img);
            done(uuid, { state: 'ok', runs: toRuns(f), w: f.w, h: f.h, at: Date.now() });
            res();
        }));
    }
    function want(uuid) {
        const e = map.get(uuid);
        if (e && (e.state !== 'none' || Date.now() - e.at < (e.retry || RETRY_MS))) return e;
        map.set(uuid, { state: 'loading', at: Date.now() });
        queue.push(uuid);
        pump();
        return map.get(uuid);
    }
    /** the tile and the logo at x, y; false while there is none */
    function draw(rec, uuid, x, y) {
        if (!uuid) return false;
        const e = want(uuid);
        if (!e || e.state !== 'ok') return false;
        rec.fillRect(x, y, BOX.w, BOX.h, hex(TILE[0], TILE[1], TILE[2]));
        const ox = x + Math.floor((BOX.w - e.w) / 2), oy = y + Math.floor((BOX.h - e.h) / 2);
        for (let i = 0; i < e.runs.length; i++) { const r = e.runs[i]; rec.fillRect(ox + r[0], oy + r[1], r[2], 1, r[3]); }
        return true;
    }
    function stats() {
        const n = { ok: 0, loading: 0, none: 0, why: lastWhy };
        map.forEach((e) => { n[e.state] = (n[e.state] || 0) + 1; });
        return n;
    }
    return { draw, version: () => ver, state: (uuid) => (map.get(uuid) || {}).state, want, stats };
}

module.exports = { createLogos, toRuns, fitBox, BOX, TILE };
