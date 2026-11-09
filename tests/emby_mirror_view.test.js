'use strict';
/**
 * Emby's copy of the picture view (apps/aurelm_emby/mirror_view.js): node tests/emby_mirror_view.test.js
 * Against a fake mgu-render client: the overlay (the subtitles) drawn over the picture with the kit's Recorder, a new
 * frame when its line changes and only then; the player's words for the reasons.
 */
const assert = require('assert');
const path = require('path');
const EventEmitter = require('events');
const { createMirrorView } = require(path.join(__dirname, '..', 'apps', 'aurelm_emby', 'mirror_view'));
const record = require(path.join(__dirname, '..', 'kit', 'runtime', 'record'));

class FakeGpu extends EventEmitter {
    constructor() { super(); this.frames = 0; this.placement = null; }
    connect() {} mode() {} claim() {} video() {} grab() {} show() {} close() {}
    place(p) { this.placement = p; }
    frame(r) { this.frames++; this.lastRec = r; }
}
let clock = 1000;
const tests = [];
const test = (n, f) => tests.push({ n, f });

test('the overlay: drawn over the picture, a new frame when its line changes, none otherwise', () => {
    let gpu = null, line = null, drawn = 0;
    class RC extends FakeGpu { constructor() { super(); gpu = this; } }
    const v = createMirrorView({ RenderClient: RC, Recorder: record.Recorder, kit: record, appId: 'aurelm_emby', statIno: () => 7, now: () => clock,
        idleText: 'the player is not running', hiddenText: 'hidden: press "Show picture" to show it again',
        overlay: () => (line ? { key: line, draw: (rec, pl) => { drawn++; rec.text(line, pl.w / 2, pl.h - 40, 42, 0xffffffff, { align: 'center', font: 'bold', literal: true }); } } : null) });
    gpu.emit('ready', { w: 1920, h: 720 }, { video: true });
    v.update({ rx: null, pageVisible: true, driving: false });
    assert.strictEqual(v.state().why, 'the player is not running');
    const rx = { running: true, videoRunning: true, decoder: { ok: true, path: '/dev/shm/mgu-video-aurelm-emby' }, stream: { shown: 5 } };
    v.update({ rx, pageVisible: true, driving: false });
    assert.strictEqual(v.state().shown, true);
    const f0 = gpu.frames, n0 = gpu.lastRec.n;
    v.tick();
    assert.strictEqual(gpu.frames, f0, 'no line, no change: no frame');
    line = 'Vreau sa-ti spun';
    v.tick();
    assert.strictEqual(gpu.frames, f0 + 1);
    assert.strictEqual(drawn, 1);
    assert.ok(gpu.lastRec.n > n0, 'the line is in the frame');
    v.tick();
    assert.strictEqual(gpu.frames, f0 + 1, 'the same line: no new frame');
    line = null;
    v.tick();
    assert.strictEqual(gpu.frames, f0 + 2, 'the line went: a frame without it');
});

test('the picture placed by the overlay (aspect); touch and the controller to the controls while it is up', () => {
    let gpu = null;
    const touches = [], ccus = [];
    class RC extends FakeGpu { constructor() { super(); gpu = this; } }
    let rect = { x: 0, y: -40, w: 1920, h: 800 };
    const v = createMirrorView({ RenderClient: RC, Recorder: record.Recorder, kit: record, appId: 'aurelm_emby', statIno: () => 7, now: () => clock,
        overlay: () => ({ key: JSON.stringify(rect), rect: () => rect }),
        onTouch: (ph, x, y, pl) => touches.push([ph, x, y, pl.w]), onCcu: (c) => { ccus.push(c); return true; } });
    gpu.emit('ready', { w: 1920, h: 720 }, { video: true });
    gpu.emit('touch', 'down', 10, 10);
    assert.strictEqual(touches.length, 0, 'not shown: no touch to the controls');
    v.update({ rx: { running: true, videoRunning: true, decoder: { ok: true, path: '/dev/shm/x' }, stream: { shown: 5 } }, pageVisible: true, driving: false });
    const words = Array.from(gpu.lastRec.words());
    const f = new Float32Array(new Uint32Array(words).buffer);
    // the VIDEO op after CLEAR (2 words): op, x, y, w, h
    assert.deepStrictEqual([f[3], f[4], f[5], f[6]], [0, -40, 1920, 800]);
    gpu.emit('touch', 'down', 900, 650);
    assert.deepStrictEqual(touches, [['down', 900, 650, 1920]]);
    gpu.emit('ccu', { knob: 5, press: 1, tilt: 0 });
    assert.strictEqual(ccus.length, 1);
    assert.strictEqual(v.state().shown, true, 'the controls took the press: the picture stays');
    rect = { x: 96, y: 0, w: 1728, h: 720 };
    v.tick();
    const f2 = new Float32Array(new Uint32Array(Array.from(gpu.lastRec.words())).buffer);
    assert.deepStrictEqual([f2[3], f2[4], f2[5], f2[6]], [96, 0, 1728, 720], 'another aspect: drawn again');
    v.hide('the controls');
    assert.strictEqual(v.state().shown, false);
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.f(); console.log('ok   ' + t.n); } catch (e) { failed++; console.log('FAIL ' + t.n + '\n     ' + (e && e.stack || e)); }
    }
    console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
