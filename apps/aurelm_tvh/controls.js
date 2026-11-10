'use strict';
/**
 * controls.js - the channel's controls over the picture: a bar at the bottom with the channel, what is on now and
 * how far it is (from the EPG), and the buttons  CH-, CH+, LIST, stop, aspect (fit, zoom, fill), exit. LIST opens the
 * channels above the bar (the one playing marked, each with what is on now): a touch on one, or the knob (or a push up
 * / down) and a press, plays it; a push left / right, a touch outside or 10 s idle closes it.
 *
 * Emby's controls (apps/aurelm_emby/controls.js, 0.3.9) for live TV: no seek, no pause (a live stream does not
 * wait), the track list became the channel list.
 *
 * Shown by a touch on the picture or the iDrive controller (turn, press or push), hidden 5 s after the last one,
 * by a touch outside the bar or a push down. The controller's codes are the kit's (kit/runtime/display.js): the knob
 * a 16-bit counter, the press 1 or 2, a push 1/2 north, 4/5 east, 7/8 south, 10/11 west; 15 and 15: no controller.
 *
 *   const ctl = createControls({ now, act });   // act('chdown' | 'chup' | 'stop' | 'aspect' | 'exit' | { channel: uuid })
 *   ctl.touch(phase, x, y, placement, info)     // true: taken
 *   ctl.ccu({ knob, press, tilt })               // true: taken (the picture stays)
 *   ctl.visible()  ctl.show()  ctl.hide()  ctl.openList()
 *   ctl.key(info)                                // changes when the bar must be drawn again
 *   ctl.draw(rec, placement, info)               // info: { title, now: { title, start, stop }, aspect, profile, note,
 *                                                //         channels: [{ uuid, t }], current: uuid }
 *   ctl.height(placement)
 */
const BUTTONS = ['chdown', 'chup', 'list', 'stop', 'aspect', 'exit'];
const SHOW_MS = 5000, MENU_MS = 10000;
const TILT = { 1: 'N', 2: 'N', 4: 'E', 5: 'E', 7: 'S', 8: 'S', 10: 'W', 11: 'W' };
const ASPECT_NAME = { fit: 'FIT', zoom: 'ZOOM', fill: 'FILL' };
const ACCENT = 0x2f8fd8ff;

/** seconds since 1970 -> "21:05" (the head unit's local time) */
const hm = (t) => { const d = new Date(t * 1000); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

function createControls(o) {
    const now = o.now || Date.now;
    const act = o.act || (() => {});
    let until = 0, focus = 1, last = null;
    let menu = null;       // { items: [{ i: uuid, t }], focus, first, cur, until } while the channel list is open
    let lastInfo = {};

    function menuOpen() { if (menu && now() > menu.until) menu = null; return !!menu; }
    const visible = () => menuOpen() || now() < until;
    function show() { until = now() + SHOW_MS; if (menu) menu.until = now() + MENU_MS; }
    function hide() { until = 0; menu = null; }

    function openList() {
        const items = (lastInfo.channels || []).map((c) => ({ i: c.uuid, t: c.t }));
        if (!items.length) items.push({ i: null, t: 'No channels yet' });
        const at = Math.max(0, items.findIndex((x) => x.i === lastInfo.current));
        menu = { items, focus: at, first: Math.max(0, at - 2), cur: lastInfo.current, until: now() + MENU_MS };
        show();
    }
    function choose(n) {
        const it = menu && menu.items[n];
        menu = null;
        show();
        if (it && it.i != null && it.i !== lastInfo.current) act({ channel: it.i });
    }
    function menuLayout(pl) {
        const L = layout(pl), ih = Math.max(36, Math.round(L.H * 0.21)), pad = Math.round(ih * 0.25);
        const room = Math.max(1, Math.floor((L.y0 - 2 * pad - ih - 20) / ih));
        const rows = Math.min(menu.items.length, room);
        if (menu.focus < menu.first) menu.first = menu.focus;
        if (menu.focus >= menu.first + rows) menu.first = menu.focus - rows + 1;
        if (menu.first > Math.max(0, menu.items.length - rows)) menu.first = Math.max(0, menu.items.length - rows);
        const w = Math.min(Math.round(pl.w * 0.6), 1100), h = (rows + 1) * ih + 2 * pad;
        const b = L.buttons.find((q) => q.id === 'list');
        const x = Math.max(L.pad, Math.min(pl.w - L.pad - w, Math.round(b.x + b.w / 2 - w / 2)));
        const y = L.y0 - 10 - h;
        return { x, y, w, h, ih, pad, rows, row: (k) => ({ x: x + pad, y: y + pad + (k + 1) * ih, w: w - 2 * pad, h: ih }) };
    }

    function layout(pl) {
        const H = height(pl), y0 = pl.h - H, pad = Math.round(pl.w * 0.03);
        const bw = Math.round(pl.w * 0.085), bh = Math.round(H * 0.36), gap = Math.round(bw * 0.25);
        const total = BUTTONS.length * bw + (BUTTONS.length - 1) * gap, bx = Math.round((pl.w - total) / 2), by = pl.h - bh - Math.round(H * 0.1);
        return {
            y0, pad, H,
            title: { x: pad, y: y0 + Math.round(H * 0.24) },
            bar: { x: pad, y: y0 + Math.round(H * 0.38), w: pl.w - 2 * pad, h: Math.max(6, Math.round(H * 0.035)) },
            buttons: BUTTONS.map((id, i) => ({ id, x: bx + i * (bw + gap), y: by, w: bw, h: bh })),
        };
    }
    function height(pl) { return Math.round(pl.h * 0.3); }

    function touch(phase, x, y, pl) {
        if (phase !== 'down') return true;   // the picture keeps its touches; a tap acts on its way down
        if (!visible()) { show(); return true; }
        if (menuOpen()) {
            const M = menuLayout(pl);
            if (x >= M.x && x <= M.x + M.w && y >= M.y && y <= M.y + M.h) {
                for (let k = 0; k < M.rows; k++) {
                    const r = M.row(k);
                    if (y >= r.y && y < r.y + r.h) { choose(menu.first + k); return true; }
                }
                // the list's title row: a page up; below the last row: a page down
                const step = Math.max(1, M.rows - 1);
                menu.focus = Math.max(0, Math.min(menu.items.length - 1, menu.focus + (y < M.y + M.pad + M.ih ? -step : step)));
                show();
                return true;
            }
            menu = null;
            if (y < layout(pl).y0) { show(); return true; }
        }
        const L = layout(pl);
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
        if (tilt === 'N') { focus = BUTTONS.indexOf('list'); run('list'); return true; }
        if (tilt === 'E' || tilt === 'W') d = tilt === 'E' ? 1 : -1;
        if (d) focus = Math.max(0, Math.min(BUTTONS.length - 1, focus + d));
        if (press && (BUTTONS[focus] === 'exit' || BUTTONS[focus] === 'stop')) { run(BUTTONS[focus]); return true; }
        if (press) run(BUTTONS[focus]);
        show();
        return true;
    }

    function run(id) {
        if (id === 'list') { openList(); return; }
        if (id === 'exit' || id === 'stop') hide();
        act(id);
    }

    function key(info0) {
        if (info0) lastInfo = info0;
        if (!visible()) return null;
        const i = info0 || {};
        const m = menu ? [menu.focus, menu.first, menu.items.length].join(',') : '';
        const n = i.now || {};
        return [focus, i.title, n.title, n.start, Math.floor(now() / 30000), i.aspect, i.profile, i.note, m].join('|');
    }
    function fit(rec, t, w, size) {
        if (!rec.textWidth || rec.textWidth(t, size, { font: 'bold', literal: true }) <= w) return t;
        while (t.length > 1 && rec.textWidth(t + '...', size, { font: 'bold', literal: true }) > w) t = t.slice(0, -1);
        return t + '...';
    }
    function drawMenu(rec, pl) {
        const M = menuLayout(pl), fs = Math.round(M.ih * 0.48);
        rec.roundRect(M.x, M.y, M.w, M.h, M.pad, 0x101418f0);
        rec.strokeRoundRect(M.x, M.y, M.w, M.h, M.pad, 2, 0xffffff30);
        rec.text('CHANNELS', M.x + M.pad * 2, M.y + M.pad + M.ih * 0.68, Math.round(fs * 0.85), 0xffffff90, { font: 'bold', literal: true });
        if (menu.items.length > M.rows) {
            rec.text((menu.first + 1) + '-' + (menu.first + M.rows) + ' / ' + menu.items.length, M.x + M.w - M.pad * 2, M.y + M.pad + M.ih * 0.68,
                Math.round(fs * 0.8), 0xffffff70, { align: 'right', font: 'bold', literal: true });
        }
        for (let k = 0; k < M.rows; k++) {
            const n = menu.first + k, it = menu.items[n], r = M.row(k);
            if (n === menu.focus) {
                rec.roundRect(r.x, r.y + 2, r.w, r.h - 4, (r.h - 4) / 2, 0xffffff26);
                rec.strokeRoundRect(r.x, r.y + 2, r.w, r.h - 4, (r.h - 4) / 2, 3, ACCENT);
            }
            const on = it.i != null && it.i === menu.cur;
            if (on) rec.circle(r.x + r.h * 0.5, r.y + r.h / 2, r.h * 0.13, ACCENT);
            rec.text(fit(rec, it.t, r.w - r.h * 1.3, fs), r.x + r.h, r.y + r.h / 2 + fs * 0.36, fs, on ? 0xffffffff : 0xffffffc8, { font: 'bold', literal: true });
        }
    }

    function draw(rec, pl, info) {
        if (info) lastInfo = info;
        const i = info || {};
        const L = layout(pl);
        rec.gradientRect(0, L.y0 - 40, pl.w, L.H + 40, [[0, 0x00000000], [0.3, 0x000000a8], [1, 0x000000e0]]);
        const fs = Math.round(L.H * 0.12);
        const n = i.now || null;
        const right = (n && n.start && n.stop ? hm(n.start) + ' - ' + hm(n.stop) : '') + (i.profile ? '   ' + i.profile : '');
        const rw = right && rec.textWidth ? rec.textWidth(right, fs, { font: 'bold', literal: true }) : 0;
        const left = (i.title || '') + (n && n.title ? '  -  ' + n.title : '') + (i.note ? '  (' + i.note + ')' : '');
        rec.text(fit(rec, left, pl.w - 2 * L.pad - rw - 30, fs), L.title.x, L.title.y, fs, 0xffffffff, { font: 'bold', literal: true });
        if (right) rec.text(right, pl.w - L.pad, L.title.y, fs, 0xffffffc0, { align: 'right', font: 'bold', literal: true });
        // the programme's progress (not a seek bar: live)
        const b = L.bar, t = now() / 1000;
        const f = n && n.start && n.stop && n.stop > n.start ? Math.max(0, Math.min(1, (t - n.start) / (n.stop - n.start))) : 0;
        rec.roundRect(b.x, b.y, b.w, b.h, b.h / 2, 0xffffff30);
        if (f > 0) rec.roundRect(b.x, b.y, Math.max(b.h, b.w * f), b.h, b.h / 2, ACCENT);
        L.buttons.forEach((q, k) => {
            const cx = q.x + q.w / 2, cy = q.y + q.h / 2, s = q.h * 0.28, white = 0xffffffff;
            rec.roundRect(q.x, q.y, q.w, q.h, q.h / 2, k === focus ? 0xffffff38 : 0xffffff14);
            if (k === focus) rec.strokeRoundRect(q.x, q.y, q.w, q.h, q.h / 2, 3, ACCENT);
            const label = (txt) => {
                let z = Math.round(fs * 1.0);
                while (rec.textWidth && z > 10 && rec.textWidth(txt, z, { font: 'bold', literal: true }) > q.w * 0.84) z--;
                rec.text(txt, cx, cy + z * 0.36, z, white, { align: 'center', font: 'bold', literal: true });
            };
            if (q.id === 'chdown') label('CH -');
            else if (q.id === 'chup') label('CH +');
            else if (q.id === 'list') label('LIST');
            else if (q.id === 'aspect') label(ASPECT_NAME[i.aspect] || 'FIT');
            else if (q.id === 'stop') rec.fillRect(cx - s, cy - s, 2 * s, 2 * s, white);
            else if (q.id === 'exit') { rec.line(cx - s, cy - s, cx + s, cy + s, 5, white); rec.line(cx - s, cy + s, cx + s, cy - s, 5, white); }
        });
        if (menuOpen()) drawMenu(rec, pl);
    }

    return { touch, ccu, visible, show, hide, openList, key, draw, height, layout,
        focus: () => BUTTONS[focus], menu: () => (menuOpen() ? menu : null), menuLayout };
}

/** where the picture goes for an aspect: fit (whole, bars), fill (the screen full, the edges cut), zoom (between) */
function videoRect(mode, fw, fh, pl) {
    if (!fw || !fh) return { x: 0, y: 0, w: pl.w, h: pl.h };
    const fit = Math.min(pl.w / fw, pl.h / fh), fill = Math.max(pl.w / fw, pl.h / fh);
    const k = mode === 'fill' ? fill : mode === 'zoom' ? Math.sqrt(fit * fill) : fit;
    const w = Math.round(fw * k), h = Math.round(fh * k);
    return { x: Math.round((pl.w - w) / 2), y: Math.round((pl.h - h) / 2), w, h };
}

module.exports = { createControls, videoRect, BUTTONS, hm };
