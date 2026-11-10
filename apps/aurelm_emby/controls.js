'use strict';
/**
 * controls.js - the film's controls over the picture: a bar at the bottom with the title, the position, a progress
 * bar and the buttons  -10 s, play / pause, stop, +30 s, audio, subtitles, aspect (fit, zoom, fill), exit. AUDIO and SUBS
 * open a list of the film's tracks above the bar (subtitles with "Off" first; the current one marked): a touch on one,
 * or the knob (or a push up / down) and a press, chooses it; a push left / right, a touch outside or 10 s idle closes it.
 *
 * Shown by a touch on the picture or the iDrive controller (turn, press or push), hidden 5 s after the last one
 * (not while paused), by a touch outside the bar or a push down. On the bar: a touch on a button or on the progress
 * bar (dragged: the target follows the finger, the seek goes when it lifts); the knob moves the focus along the buttons and a press runs the focused one, a push left or
 * right moves it too. The controller's codes are the kit's (kit/runtime/display.js): the knob a 16-bit counter, the
 * press 1 or 2, a push 1/2 north, 4/5 east, 7/8 south, 10/11 west; 15 and 15: no controller behind it.
 *
 *   const ctl = createControls({ now, act });   // act('back10' | 'playpause' | 'stop' | 'fwd30' | 'aspect' | 'exit' | { seek }
 *                                               //     | { track: 'audio' | 'subs', index })  (index -1: subtitles off)
 *   ctl.touch(phase, x, y, placement, info)     // true: taken
 *   ctl.ccu({ knob, press, tilt })               // true: taken (the picture stays)
 *   ctl.visible()  ctl.show()  ctl.hide()
 *   ctl.key(info)                                // changes when the bar must be drawn again
 *   ctl.draw(rec, placement, info)               // info: { title, pos, dur, paused, aspect, seeking,
 *                                                //         tracks: { audio: [{ i, t }], subs: [{ i, t }] }, audioIndex, subtitleIndex }
 *   ctl.height(placement)                        // the bar's height (the subtitles go above it)
 */
const BUTTONS = ['back10', 'playpause', 'stop', 'fwd30', 'audio', 'subs', 'aspect', 'exit'];
const SHOW_MS = 5000, MENU_MS = 10000;
const MENU_TITLE = { audio: 'AUDIO', subs: 'SUBTITLES' };
const TILT = { 1: 'N', 2: 'N', 4: 'E', 5: 'E', 7: 'S', 8: 'S', 10: 'W', 11: 'W' };
const ASPECT_NAME = { fit: 'FIT', zoom: 'ZOOM', fill: 'FILL' };

const hms = (s) => {
    s = Math.max(0, Math.round(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};

function createControls(o) {
    const now = o.now || Date.now;
    const act = o.act || (() => {});
    let until = 0, focus = 1, last = null, keepOpen = false;
    let menu = null;       // { kind, items: [{ i, t }], focus, first, cur, until } while a track list is open
    let lastInfo = {};     // the bar's info as last given (a press of the controller opens a list from it)

    function menuOpen() { if (menu && now() > menu.until) menu = null; return !!menu; }
    const visible = () => menuOpen() || keepOpen || now() < until;
    function show() { until = now() + SHOW_MS; if (menu) menu.until = now() + MENU_MS; }
    function hide() { until = 0; keepOpen = false; menu = null; }

    /** the list of a kind's tracks, on the current one */
    function openMenu(kind) {
        const tr = (lastInfo.tracks && lastInfo.tracks[kind]) || [];
        const items = kind === 'subs' ? [{ i: -1, t: 'Off' }].concat(tr) : tr.slice();
        const now0 = kind === 'subs' ? (lastInfo.subtitleIndex != null && lastInfo.subtitleIndex >= 0 ? lastInfo.subtitleIndex : -1) : lastInfo.audioIndex;
        if (!items.length) items.push({ i: null, t: 'No audio tracks known' });
        const at = Math.max(0, items.findIndex((x) => x.i === now0));
        menu = { kind, items, focus: at, first: 0, cur: now0, until: now() + MENU_MS };
    }
    function choose(n) {
        const it = menu && menu.items[n];
        const kind = menu && menu.kind;
        menu = null;
        show();
        if (it && it.i != null && it.i !== (kind === 'subs' ? (lastInfo.subtitleIndex != null && lastInfo.subtitleIndex >= 0 ? lastInfo.subtitleIndex : -1) : lastInfo.audioIndex)) act({ track: kind, index: it.i });
    }
    /** the open list's place: above its button, as many rows as fit above the bar */
    function menuLayout(pl) {
        const L = layout(pl), ih = Math.max(36, Math.round(L.H * 0.21)), pad = Math.round(ih * 0.25);
        const room = Math.max(1, Math.floor((L.y0 - 2 * pad - ih - 20) / ih));
        const rows = Math.min(menu.items.length, room);
        if (menu.focus < menu.first) menu.first = menu.focus;
        if (menu.focus >= menu.first + rows) menu.first = menu.focus - rows + 1;
        const w = Math.min(Math.round(pl.w * 0.42), 860), h = (rows + 1) * ih + 2 * pad;
        const b = L.buttons.find((q) => q.id === menu.kind);
        const x = Math.max(L.pad, Math.min(pl.w - L.pad - w, Math.round(b.x + b.w / 2 - w / 2)));
        const y = L.y0 - 10 - h;
        return { x, y, w, h, ih, pad, rows, row: (k) => ({ x: x + pad, y: y + pad + (k + 1) * ih, w: w - 2 * pad, h: ih }) };
    }

    /** the bar's places on the screen */
    function layout(pl) {
        const H = height(pl), y0 = pl.h - H, pad = Math.round(pl.w * 0.03);
        const bw = Math.round(pl.w * 0.075), bh = Math.round(H * 0.36), gap = Math.round(bw * 0.25);
        const total = BUTTONS.length * bw + (BUTTONS.length - 1) * gap, bx = Math.round((pl.w - total) / 2), by = pl.h - bh - Math.round(H * 0.1);
        return {
            y0, pad, H,
            title: { x: pad, y: y0 + Math.round(H * 0.24) },
            bar: { x: pad, y: y0 + Math.round(H * 0.38), w: pl.w - 2 * pad, h: Math.max(6, Math.round(H * 0.05)) },
            buttons: BUTTONS.map((id, i) => ({ id, x: bx + i * (bw + gap), y: by, w: bw, h: bh })),
        };
    }
    function height(pl) { return Math.round(pl.h * 0.3); }

    // a finger on the progress bar: the target follows it (shown, not sent), the seek goes when it lifts (0.3.5 in
    // the car: only where it came down counted, so a drag of the knob moved a few seconds)
    let scrub = null;   // { t } while a finger drags the progress bar
    const fraction = (x, L) => Math.max(0, Math.min(1, (x - L.bar.x) / L.bar.w));
    function touch(phase, x, y, pl, info) {
        const L = layout(pl);
        if (scrub) {
            if (info && info.dur) scrub.t = fraction(x, L) * info.dur;
            show();
            if (phase === 'up') { const t = scrub.t; scrub = null; act({ seek: t }); }
            return true;
        }
        if (phase !== 'down') return true;   // the picture keeps its touches; a tap acts on its way down
        if (!visible()) { show(); return true; }
        if (menuOpen()) {
            const M = menuLayout(pl);
            if (x >= M.x && x <= M.x + M.w && y >= M.y && y <= M.y + M.h) {
                for (let k = 0; k < M.rows; k++) {
                    const r = M.row(k);
                    if (y >= r.y && y < r.y + r.h) { choose(menu.first + k); return true; }
                }
                show();
                return true;
            }
            menu = null;   // a touch outside: the list closes (on the bar, the touch goes on to it)
            if (y < layout(pl).y0) { show(); return true; }
        }
        // the progress bar (a generous band around it): the finger drags the target
        if (info && info.dur && y >= L.bar.y - 36 && y <= L.bar.y + L.bar.h + 36 && x >= L.bar.x - 20 && x <= L.bar.x + L.bar.w + 20) {
            scrub = { t: fraction(x, L) * info.dur };
            show();
            return true;
        }
        if (y < L.y0) { hide(); return true; }
        const b = L.buttons.find((q) => x >= q.x && x <= q.x + q.w && y >= q.y - 10 && y <= q.y + q.h + 10);
        if (b) { focus = BUTTONS.indexOf(b.id); if (b.id !== 'exit' && b.id !== 'stop') show(); run(b.id); return true; }
        return true;
    }

    function ccu(c) {
        const k = Number(c.knob), pb = Number(c.press), df = Number(c.tilt);
        const L = last;
        last = { k, pb, df };
        if (pb === 15 && df === 15) return true;   // no controller behind it
        let d = L ? ((k - L.k + 32768) & 0xffff) - 32768 : 0;
        if (Math.abs(d) > 64) d = 0;                // a counter reset
        const down = (x) => x === 1 || x === 2;
        const press = down(pb) && !(L && down(L.pb));
        const tilt = TILT[df] && !(L && TILT[L.df] === TILT[df]) ? TILT[df] : null;
        if (!d && !press && !tilt) return true;
        if (!visible()) { focus = 1; show(); return true; }   // the first touch of the controller: the bar, nothing else
        if (menuOpen()) {
            if (tilt === 'E' || tilt === 'W') { menu = null; show(); return true; }
            if (tilt === 'N') d = -1;
            if (tilt === 'S') d = 1;
            if (d) menu.focus = Math.max(0, Math.min(menu.items.length - 1, menu.focus + d));
            if (press) { choose(menu.focus); return true; }
            show();
            return true;
        }
        if (tilt === 'S') { hide(); return true; }
        if (tilt === 'E' || tilt === 'W') d = tilt === 'E' ? 1 : -1;
        if (d) focus = Math.max(0, Math.min(BUTTONS.length - 1, focus + d));
        if (press && (BUTTONS[focus] === 'exit' || BUTTONS[focus] === 'stop')) { run(BUTTONS[focus]); return true; }
        if (press) run(BUTTONS[focus]);
        show();
        return true;
    }

    function run(id) {
        if (id === 'audio' || id === 'subs') { openMenu(id); show(); return; }
        if (id === 'exit' || id === 'stop') hide();
        act(id);
    }

    /** the bar's info with a drag's target in place of the position */
    function view(info) {
        return scrub ? Object.assign({}, info, { seeking: scrub.t }) : info;
    }
    function key(info0) {
        if (info0) lastInfo = info0;
        if (!visible()) return null;
        const i = view(info0 || {});
        const m = menu ? [menu.kind, menu.focus, menu.first, menu.items.length].join(',') : '';
        return [focus, Math.floor(i.seeking != null ? i.seeking : i.pos || 0), i.dur, !!i.paused, i.aspect, i.title, m, i.seeking != null].join('|');
    }
    /** a text cut to a width, with "..." */
    function fit(rec, t, w, size) {
        if (!rec.textWidth || rec.textWidth(t, size, { font: 'bold', literal: true }) <= w) return t;
        while (t.length > 1 && rec.textWidth(t + '...', size, { font: 'bold', literal: true }) > w) t = t.slice(0, -1);
        return t + '...';
    }
    function drawMenu(rec, pl) {
        const M = menuLayout(pl), fs = Math.round(M.ih * 0.5);
        rec.roundRect(M.x, M.y, M.w, M.h, M.pad, 0x101418f0);
        rec.strokeRoundRect(M.x, M.y, M.w, M.h, M.pad, 2, 0xffffff30);
        rec.text(MENU_TITLE[menu.kind], M.x + M.pad * 2, M.y + M.pad + M.ih * 0.68, Math.round(fs * 0.85), 0xffffff90, { font: 'bold', literal: true });
        if (menu.items.length > M.rows) {
            rec.text((menu.first + 1) + '-' + (menu.first + M.rows) + ' / ' + menu.items.length, M.x + M.w - M.pad * 2, M.y + M.pad + M.ih * 0.68,
                Math.round(fs * 0.8), 0xffffff70, { align: 'right', font: 'bold', literal: true });
        }
        for (let k = 0; k < M.rows; k++) {
            const n = menu.first + k, it = menu.items[n], r = M.row(k);
            if (n === menu.focus) {
                rec.roundRect(r.x, r.y + 2, r.w, r.h - 4, (r.h - 4) / 2, 0xffffff26);
                rec.strokeRoundRect(r.x, r.y + 2, r.w, r.h - 4, (r.h - 4) / 2, 3, 0x52b54bff);
            }
            const on = it.i != null && it.i === menu.cur;
            if (on) rec.circle(r.x + r.h * 0.5, r.y + r.h / 2, r.h * 0.13, 0x52b54bff);
            rec.text(fit(rec, it.t, r.w - r.h * 1.3, fs), r.x + r.h, r.y + r.h / 2 + fs * 0.36, fs, on ? 0xffffffff : 0xffffffc8, { font: 'bold', literal: true });
        }
    }

    function draw(rec, pl, info) {
        if (info) lastInfo = info;
        const i = view(info || {});
        const L = layout(pl);
        rec.gradientRect(0, L.y0 - 40, pl.w, L.H + 40, [[0, 0x00000000], [0.3, 0x000000a8], [1, 0x000000e0]]);
        const fs = Math.round(L.H * 0.13);
        const pos = i.seeking != null ? i.seeking : i.pos || 0;
        rec.text(i.title || '', L.title.x, L.title.y, fs, 0xffffffff, { font: 'bold', literal: true });
        rec.text(hms(pos) + (i.dur ? ' / ' + hms(i.dur) : ''), pl.w - L.pad, L.title.y, fs, i.seeking != null ? 0xffd166ff : 0xffffffff, { align: 'right', font: 'bold', literal: true });
        // progress
        const b = L.bar, f = i.dur ? Math.max(0, Math.min(1, pos / i.dur)) : 0;
        rec.roundRect(b.x, b.y, b.w, b.h, b.h / 2, 0xffffff40);
        if (f > 0) rec.roundRect(b.x, b.y, Math.max(b.h, b.w * f), b.h, b.h / 2, 0x52b54bff);
        rec.circle(b.x + b.w * f, b.y + b.h / 2, b.h * 1.4, 0xffffffff);
        // buttons
        L.buttons.forEach((q, n) => {
            const cx = q.x + q.w / 2, cy = q.y + q.h / 2, s = q.h * 0.28, white = 0xffffffff;
            rec.roundRect(q.x, q.y, q.w, q.h, q.h / 2, n === focus ? 0xffffff38 : 0xffffff14);
            if (n === focus) rec.strokeRoundRect(q.x, q.y, q.w, q.h, q.h / 2, 3, 0x52b54bff);
            const label = (t) => {
                let z = Math.round(fs * 0.95);
                while (rec.textWidth && z > 10 && rec.textWidth(t, z, { font: 'bold', literal: true }) > q.w * 0.84) z--;
                rec.text(t, cx, cy + z * 0.36, z, white, { align: 'center', font: 'bold', literal: true });
            };
            if (q.id === 'back10') label('-10s');
            else if (q.id === 'fwd30') label('+30s');
            else if (q.id === 'aspect') label(ASPECT_NAME[i.aspect] || 'FIT');
            else if (q.id === 'audio') label('AUDIO');
            else if (q.id === 'subs') label('SUBS');
            else if (q.id === 'stop') rec.fillRect(cx - s, cy - s, 2 * s, 2 * s, white);
            else if (q.id === 'exit') { rec.line(cx - s, cy - s, cx + s, cy + s, 5, white); rec.line(cx - s, cy + s, cx + s, cy - s, 5, white); }
            else if (q.id === 'playpause') {
                if (i.paused) rec.quad([[cx - s * 0.8, cy - s * 1.1], [cx + s * 1.2, cy], [cx - s * 0.8, cy + s * 1.1], [cx - s * 0.8, cy + s * 1.1]], white);
                else { rec.fillRect(cx - s, cy - s * 1.1, s * 0.7, s * 2.2, white); rec.fillRect(cx + s * 0.3, cy - s * 1.1, s * 0.7, s * 2.2, white); }
            }
        });
        if (menuOpen()) drawMenu(rec, pl);
    }

    return { touch, ccu, visible, show, hide, key, draw, height, layout,
        keepOpen: (on) => { keepOpen = !!on; }, focus: () => BUTTONS[focus], menu: () => (menuOpen() ? menu : null), menuLayout };
}

/** where the picture goes for an aspect: fit (whole, bars), fill (the screen full, the edges cut), zoom (between) */
function videoRect(mode, fw, fh, pl) {
    if (!fw || !fh) return { x: 0, y: 0, w: pl.w, h: pl.h };
    const fit = Math.min(pl.w / fw, pl.h / fh), fill = Math.max(pl.w / fw, pl.h / fh);
    const k = mode === 'fill' ? fill : mode === 'zoom' ? Math.sqrt(fit * fill) : fit;
    const w = Math.round(fw * k), h = Math.round(fh * k);
    return { x: Math.round((pl.w - w) / 2), y: Math.round((pl.h - h) / 2), w, h };
}

module.exports = { createControls, videoRect, BUTTONS, hms };
