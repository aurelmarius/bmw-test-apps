'use strict';
/**
 * The film's controls over the picture (apps/aurelm_emby/controls.js): node tests/emby_controls.test.js
 * Touch and the iDrive controller (the kit's codes), the buttons, a seek on the progress bar, hiding after 5 s (not
 * while paused), the aspect's rectangles; drawn with the kit's Recorder.
 */
const assert = require('assert');
const path = require('path');
const { createControls, videoRect } = require(path.join(__dirname, '..', 'apps', 'aurelm_emby', 'controls'));
const record = require(path.join(__dirname, '..', 'kit', 'runtime', 'record'));

const PL = { w: 1920, h: 720 };
const info = { title: 'Armageddon (1998)', pos: 600, dur: 9050, paused: false, aspect: 'fit' };
let clock = 0;
function make() {
    const acts = [];
    const c = createControls({ now: () => clock, act: (a) => acts.push(a) });
    return { c, acts };
}
const centre = (b) => [b.x + b.w / 2, b.y + b.h / 2];
const tests = [];
const test = (n, f) => tests.push({ n, f });

test('touch: the first shows the bar; a button runs; the progress bar seeks; above the bar hides it', () => {
    const { c, acts } = make();
    assert.strictEqual(c.visible(), false);
    c.touch('down', 900, 300, PL, info);
    assert.strictEqual(c.visible(), true);
    assert.deepStrictEqual(acts, [], 'the first touch only shows the bar');
    const L = c.layout(PL);
    const pp = L.buttons.find((b) => b.id === 'playpause');
    c.touch('down', ...centre(pp), PL, info);
    c.touch('up', ...centre(pp), PL, info);
    assert.deepStrictEqual(acts, ['playpause'], 'on the way down only');
    // a finger on the progress bar, dragged: nothing sent until it lifts, then one seek where it lifted
    c.touch('down', L.bar.x + L.bar.w * 0.1, L.bar.y + 2, PL, info);
    c.touch('move', L.bar.x + L.bar.w * 0.3, L.bar.y + 40, PL, info);
    assert.strictEqual(acts.length, 1, 'nothing while dragging');
    assert.ok(/\|true$/.test(c.key(info)), 'the bar shows the target');
    c.touch('move', L.bar.x + L.bar.w / 2, L.bar.y + 80, PL, info);
    c.touch('up', L.bar.x + L.bar.w / 2, L.bar.y + 80, PL, info);
    assert.ok(Math.abs(acts[1].seek - 4525) < 1, JSON.stringify(acts[1]));
    assert.strictEqual(acts.length, 2);
    ['back10', 'fwd30', 'aspect', 'stop'].forEach((id) => c.touch('down', ...centre(L.buttons.find((b) => b.id === id)), PL, info));
    assert.deepStrictEqual(acts.slice(2), ['back10', 'fwd30', 'aspect', 'stop']);
    assert.strictEqual(c.visible(), false, 'stop hides the bar');
    c.show();
    c.touch('down', 900, 100, PL, info);
    assert.strictEqual(c.visible(), false, 'a touch above the bar hides it');
    c.show();
    c.touch('down', ...centre(L.buttons.find((b) => b.id === 'exit')), PL, info);
    assert.strictEqual(acts[acts.length - 1], 'exit');
    assert.strictEqual(c.visible(), false, 'exit hides the bar too');
});

test('the controller: the first move shows the bar; the knob moves the focus, a press runs it; push down hides', () => {
    const { c, acts } = make();
    c.ccu({ knob: 100, press: 0, tilt: 0 });   // the first state: nothing moved
    assert.strictEqual(c.visible(), false);
    c.ccu({ knob: 101, press: 0, tilt: 0 });
    assert.strictEqual(c.visible(), true);
    assert.strictEqual(c.focus(), 'playpause', 'the first move only shows the bar, on play / pause');
    c.ccu({ knob: 103, press: 0, tilt: 0 });
    assert.strictEqual(c.focus(), 'fwd30');
    c.ccu({ knob: 103, press: 1, tilt: 0 });
    c.ccu({ knob: 103, press: 1, tilt: 0 });   // held: one press
    c.ccu({ knob: 103, press: 0, tilt: 0 });
    assert.deepStrictEqual(acts, ['fwd30']);
    c.ccu({ knob: 103, press: 0, tilt: 10 });  // pushed left
    assert.strictEqual(c.focus(), 'stop');
    c.ccu({ knob: 103, press: 0, tilt: 0 });
    c.ccu({ knob: 65535, press: 0, tilt: 0 });  // a counter reset (a jump): ignored
    assert.strictEqual(c.focus(), 'stop');
    c.ccu({ knob: 1, press: 0, tilt: 0 });      // across the wrap: +2
    assert.strictEqual(c.focus(), 'audio');
    c.ccu({ knob: 1, press: 0, tilt: 7 });      // pushed down
    assert.strictEqual(c.visible(), false);
    c.ccu({ knob: 1, press: 15, tilt: 15 });    // no controller behind it
    assert.strictEqual(c.visible(), false);
});

const tinfo = Object.assign({}, info, { audioIndex: 1, subtitleIndex: -1, tracks: {
    audio: [{ i: 1, t: 'English AC3 5.1 (Default)' }, { i: 2, t: 'Romanian AAC stereo' }, { i: 3, t: 'Director commentary' }],
    subs: [{ i: 4, t: 'Romanian (SUBRIP)' }, { i: 5, t: 'English (PGSSUB) (burned in)' }] } });

test('tracks: AUDIO opens the list on the current one; a touch on another chooses it; outside closes it', () => {
    clock = 0;
    const { c, acts } = make();
    c.show();
    c.key(tinfo);
    const L = c.layout(PL);
    c.touch('down', ...centre(L.buttons.find((b) => b.id === 'audio')), PL, tinfo);
    assert.deepStrictEqual(acts, [], 'the list only');
    const m = c.menu();
    assert.strictEqual(m.kind, 'audio');
    assert.strictEqual(m.focus, 0, 'on the current one');
    const M = c.menuLayout(PL);
    assert.ok(M.y + M.h <= L.y0 && M.y >= 0, 'above the bar');
    c.touch('down', M.row(0).x + 50, M.row(0).y + M.ih / 2, PL, tinfo);
    assert.strictEqual(c.menu(), null, 'the current one: closed, nothing sent');
    assert.deepStrictEqual(acts, []);
    c.touch('down', ...centre(L.buttons.find((b) => b.id === 'audio')), PL, tinfo);
    const M2 = c.menuLayout(PL);
    c.touch('down', M2.row(1).x + 50, M2.row(1).y + M2.ih / 2, PL, tinfo);
    assert.deepStrictEqual(acts, [{ track: 'audio', index: 2 }]);
    assert.strictEqual(c.visible(), true, 'the bar stays');
    // SUBS: "Off" first and current; a touch above the list closes it, the bar stays
    c.touch('down', ...centre(L.buttons.find((b) => b.id === 'subs')), PL, tinfo);
    assert.deepStrictEqual(c.menu().items.map((x) => x.i), [-1, 4, 5]);
    assert.strictEqual(c.menu().focus, 0);
    c.touch('down', 5, 5, PL, tinfo);
    assert.strictEqual(c.menu(), null);
    assert.strictEqual(c.visible(), true);
    // closes by itself after 10 s idle
    c.touch('down', ...centre(L.buttons.find((b) => b.id === 'subs')), PL, tinfo);
    c.keepOpen(true);
    clock += 10500;
    assert.strictEqual(c.menu(), null);
    c.keepOpen(false);
});

test('tracks with the controller: press on SUBS, the knob down, a press chooses; a push left closes', () => {
    clock = 0;
    const { c, acts } = make();
    c.key(tinfo);
    c.ccu({ knob: 0, press: 0, tilt: 0 });
    c.ccu({ knob: 1, press: 0, tilt: 0 });       // the bar, on play / pause
    c.ccu({ knob: 5, press: 0, tilt: 0 });       // +4: subs
    assert.strictEqual(c.focus(), 'subs');
    c.ccu({ knob: 5, press: 1, tilt: 0 });
    c.ccu({ knob: 5, press: 0, tilt: 0 });
    assert.strictEqual(c.menu().kind, 'subs');
    c.ccu({ knob: 6, press: 0, tilt: 0 });       // Off -> Romanian
    c.ccu({ knob: 6, press: 0, tilt: 7 });       // pushed down: the next (English), not hidden
    c.ccu({ knob: 6, press: 0, tilt: 0 });
    c.ccu({ knob: 6, press: 0, tilt: 1 });       // up again: Romanian
    c.ccu({ knob: 6, press: 0, tilt: 0 });
    assert.strictEqual(c.visible(), true);
    c.ccu({ knob: 6, press: 2, tilt: 0 });
    c.ccu({ knob: 6, press: 0, tilt: 0 });
    assert.deepStrictEqual(acts, [{ track: 'subs', index: 4 }]);
    assert.strictEqual(c.menu(), null);
    c.ccu({ knob: 6, press: 1, tilt: 0 });       // SUBS again
    c.ccu({ knob: 6, press: 0, tilt: 0 });
    assert.ok(c.menu());
    c.ccu({ knob: 6, press: 0, tilt: 10 });      // pushed left: closed, the bar stays on SUBS
    assert.strictEqual(c.menu(), null);
    assert.strictEqual(c.focus(), 'subs');
    // drawn, list and all; the key changes as the focus moves in it
    c.ccu({ knob: 6, press: 0, tilt: 0 });
    c.ccu({ knob: 6, press: 1, tilt: 0 });
    c.ccu({ knob: 6, press: 0, tilt: 0 });
    const k1 = c.key(tinfo);
    c.ccu({ knob: 7, press: 0, tilt: 0 });
    assert.notStrictEqual(c.key(tinfo), k1);
    const rec = new record.Recorder(PL.w, PL.h).clear(0x000000ff);
    c.draw(rec, PL, tinfo);
    assert.ok(rec.n > 200);
});

test('hidden 5 s after the last touch, not while paused', () => {
    const { c } = make();
    clock = 1000;
    c.show();
    clock = 5900; assert.strictEqual(c.visible(), true);
    clock = 6100; assert.strictEqual(c.visible(), false);
    c.keepOpen(true);
    clock = 60000; assert.strictEqual(c.visible(), true);
    c.keepOpen(false);
    assert.strictEqual(c.visible(), false);
});

test('the bar drawn with the kit\'s Recorder; its key changes with what it shows', () => {
    const { c } = make();
    clock = 0;
    c.show();
    const k1 = c.key(info);
    assert.ok(k1);
    assert.notStrictEqual(c.key(Object.assign({}, info, { paused: true })), k1);
    assert.notStrictEqual(c.key(Object.assign({}, info, { pos: 601 })), k1);
    assert.strictEqual(c.key(Object.assign({}, info, { pos: 600.4 })), k1, 'the same second: no new frame');
    const rec = new record.Recorder(PL.w, PL.h).clear(0x000000ff);
    c.draw(rec, PL, info);
    c.draw(rec, PL, Object.assign({}, info, { paused: true, seeking: 700, aspect: 'fill' }));
    assert.ok(rec.n > 200);
    c.hide();
    assert.strictEqual(c.key(info), null);
});

test('aspect: fit keeps the whole film, fill covers the screen, zoom is between', () => {
    // a 2.40:1 film (1920x800) on the 1920x720 screen
    assert.deepStrictEqual(videoRect('fit', 1920, 800, PL), { x: 96, y: 0, w: 1728, h: 720 });
    assert.deepStrictEqual(videoRect('fill', 1920, 800, PL), { x: 0, y: -40, w: 1920, h: 800 });
    const z = videoRect('zoom', 1920, 800, PL);
    assert.ok(z.w > 1728 && z.w < 1920 && z.h > 720 && z.h < 800, JSON.stringify(z));
    // a 16:9 one (1920x1080)
    assert.deepStrictEqual(videoRect('fit', 1920, 1080, PL), { x: 320, y: 0, w: 1280, h: 720 });
    assert.deepStrictEqual(videoRect('fill', 1920, 1080, PL), { x: 0, y: -180, w: 1920, h: 1080 });
    // no size known yet: the whole screen
    assert.deepStrictEqual(videoRect('fill', 0, 0, PL), { x: 0, y: 0, w: 1920, h: 720 });
});

test('the cluster card: drawn on cluster-render\'s panel while a film plays, its poster asked for, hidden when it stops', async () => {
    const fs = require('fs'), os = require('os');
    const { createClusterCard, CARD, PLACE, LOGO } = require(path.join(__dirname, '..', 'apps', 'aurelm_emby', 'cluster_card'));
    const { Canvas } = require(path.join(__dirname, '..', 'kit', 'runtime', 'canvas'));
    const png = require(path.join(__dirname, '..', 'kit', 'runtime', 'png'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emby-cluster-'));
    const calls = [];
    const fake = path.join(dir, 'client.js');
    fs.writeFileSync(fake, "const E = require('events'); let calls = null;\n" +
        "class ClusterRender extends E { constructor(app) { super(); calls = global.__clusterCalls; calls.push(['new', app]); }\n" +
        "  connect() { calls.push(['connect']); } image(o) { calls.push(['image', o]); return 7; } set(r, o) { calls.push(['set', r, o]); }\n" +
        "  pixels(r, rects, px) { calls.push(['pixels', r, px.length]); return true; } close() { calls.push(['close']); } }\n" +
        'module.exports = { ClusterRender };\n');
    global.__clusterCalls = calls;
    // a poster as the server gives it (PNG, 2:3)
    const poster = new Canvas(200, 300).clear([200, 40, 40, 255]).png();
    const asked = [];
    let playing = null, on = true;
    const card = createClusterCard({ Canvas, png, clientPath: fake, socketPath: path.join(dir, 'none.sock'),
        ask: (cmd, x) => { asked.push([cmd, x.id]); return Promise.resolve({ id: x.id, png: poster.toString('base64') }); },
        enabled: () => on, offset: () => ({ dx: 0, dy: -40 }), info: () => (playing ? Object.assign({}, playing) : null) });
    card.update();
    assert.strictEqual(calls.length, 0, 'nothing playing: cluster-render not asked');
    playing = { id: 'film2', name: 'Armageddon', sub: '1998', pos: 600, dur: 9050, paused: false, loading: false };
    card.update();
    const img = calls.filter((c) => c[0] === 'image')[0];
    assert.strictEqual(calls[0][1], 'aurelm_emby');
    assert.strictEqual(img[1].target, 'panel');
    assert.deepStrictEqual([img[1].x, img[1].y], [PLACE.x, PLACE.y - 40], 'moved by the setting');
    assert.ok(calls.some((c) => c[0] === 'pixels' && c[2] === CARD.w * CARD.h * 4), 'the card\'s pixels');
    assert.ok(calls.some((c) => c[0] === 'set' && c[2].visible === 1), 'shown');
    assert.deepStrictEqual(asked, [['image', 'film2']], 'the poster asked for');
    await new Promise((r) => setTimeout(r, 300));   // decoded
    const n = calls.length;
    card.update();
    assert.strictEqual(calls.length, n, 'within 5 s: not drawn again');
    assert.strictEqual(asked.length, 1, 'asked once');
    playing = null;
    card.update();
    assert.deepStrictEqual(calls[calls.length - 1], ['set', 7, { visible: 0 }], 'hidden when the film stops');
    on = false; card.update();
    assert.strictEqual(card.state().state, 'off');
    // the card itself: the poster in the cover's place, opaque inside, transparent at the corners
    const p = png.decode(poster), k = Math.min(LOGO.w / p.w, LOGO.h / p.h), f = png.fit(p, Math.round(Math.max(p.w, p.h) * k));
    const cv = card.render({ id: 'film2', name: 'Știrile — ăîâ', sub: 'S1E3 Pilot', pos: 3700, dur: 7200, paused: true, cover: { w: f.w, h: f.h, d: f.data } });
    assert.strictEqual(cv.d[3], 0, 'a corner: transparent');
    const mid = ((40 + 75) * CARD.w + (CARD.w >> 1)) * 4;
    assert.deepStrictEqual([cv.d[mid], cv.d[mid + 3]], [200, 255], 'the poster in the middle, on top');
    assert.ok(cv.d[((CARD.h >> 1) * CARD.w + 8) * 4 + 3] < 128, 'the edge: fading out');
    card.render({ id: 'x', name: 'No poster', sub: null, pos: 0, dur: 0, loading: true, cover: null });
    card.close();
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.f(); console.log('ok   ' + t.n); } catch (e) { failed++; console.log('FAIL ' + t.n + '\n     ' + (e && e.stack || e)); }
    }
    console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
