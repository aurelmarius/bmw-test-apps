'use strict';
/**
 * The car's volume for the Music Assistant app's popup (apps/aurelm_music/car_volume.js), with a fake audio manager:
 * the volume where it starts (no popup), a change (the popup for 2 s), mute (the popup while muted), other sinks
 * ignored, the payloads read loosely. Runs on Node 8.9.4 too.
 *
 *   node tests/music_volume.test.js
 */
const assert = require('assert');
const path = require('path');
const { createCarVolume, parseVolume, parseMute } = require(path.join(__dirname, '..', 'apps', 'aurelm_music', 'car_volume'));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = { info() {}, warn() {} };

function fakeSignals(sinks) {
    const subs = {}, calls = [];
    let proxies = 0;
    return {
        subs, calls, proxies: () => proxies,
        proxy: async () => { proxies++; return { id: proxies }; },
        onAvailable: (p, fn) => fn(true),
        on: async (p, name, fn) => { subs[name] = fn; },
        call: async (p, m) => { calls.push(m); if (m === 'getListMainSinks') return sinks; throw new Error('no ' + m); },
        emit: (name, v) => subs[name](v),
    };
}

test('payloads read loosely', () => {
    assert.deepStrictEqual(parseVolume({ sinkID: 1024, volume: 18 }), { sink: 1024, volume: 18 });
    assert.deepStrictEqual(parseVolume({ sinkID: '1024', mainVolume: { value: 7 } }), { sink: 1024, volume: 7 });
    assert.deepStrictEqual(parseVolume(12), { sink: null, volume: 12 });
    assert.strictEqual(parseMute({ sinkID: 1024, muteState: 'MS_MUTED' }), true);
    assert.strictEqual(parseMute({ sinkID: 1024, muteState: 'MS_UNMUTED' }), false);
    assert.strictEqual(parseMute({ muteState: 1 }), true);
    assert.strictEqual(parseMute({ muteState: 2 }), false);
    assert.strictEqual(parseMute('MS_UNKNOWN'), null);
    assert.strictEqual(parseMute(true), true);
});

test('where it starts: no popup; a change: 2 s; mute: while muted; other sinks ignored', async () => {
    let t = 1000;
    const sig = fakeSignals({ listMainSinks: [{ sinkID: 1024, volume: 0, muteState: 'MS_UNMUTED' }, { sinkID: 1, name: 'main', volume: 14, muteState: 'MS_UNMUTED' }], error: 'E_OK' });
    let changes = 0;
    const vol = createCarVolume(sig, log, { now: () => t, onChange: () => changes++ });
    await wait(30);
    assert.ok(sig.calls.indexOf('getListMainSinks') >= 0);
    let s = vol.state();
    assert.strictEqual(s.volume, 14);
    assert.strictEqual(s.muted, false);
    assert.strictEqual(s.ready, true);
    assert.strictEqual(vol.popup(), null, 'no popup for where it starts');
    // the knob
    sig.emit('volumeChanged', { sinkID: 1, volume: 18 });
    assert.deepStrictEqual(vol.popup(), { volume: 18, muted: false, max: 40 });
    t += 1900; assert.ok(vol.popup(), 'still shown at 1.9 s');
    t += 200; assert.strictEqual(vol.popup(), null, 'gone after 2 s');
    // the same value again: nothing
    sig.emit('volumeChanged', { sinkID: 1, volume: 18 });
    assert.strictEqual(vol.popup(), null);
    // another sink (1024, where 287 is routed): ignored, but kept for the Status page
    sig.emit('volumeChanged', { sinkID: 1024, volume: 30 });
    assert.strictEqual(vol.popup(), null);
    assert.ok(/sink 1024/.test(vol.state().other));
    // mute: shown as long as it lasts
    sig.emit('sinkMuteStateChanged', { sinkID: 1, muteState: 'MS_MUTED' });
    t += 60000;
    assert.deepStrictEqual(vol.popup(), { volume: 18, muted: true, max: 40 });
    // unmuted: the volume for 2 s
    sig.emit('sinkMuteStateChanged', { sinkID: 1, muteState: 'MS_UNMUTED' });
    assert.deepStrictEqual(vol.popup(), { volume: 18, muted: false, max: 40 });
    t += 2100; assert.strictEqual(vol.popup(), null);
    // a scale past 40: the bar ends at 100
    sig.emit('volumeChanged', { sinkID: 1, volume: 55 });
    assert.strictEqual(vol.popup().max, 100);
    s = vol.state();
    assert.ok(s.changes >= 4 && changes >= 4, JSON.stringify(s));
    assert.ok(/volume/.test(s.last));
});

test('muted where it starts: the popup shows', async () => {
    const sig = fakeSignals([{ sinkID: 1, volume: 9, muteState: 'MS_MUTED' }]);
    const vol = createCarVolume(sig, log, {});
    await wait(30);
    assert.deepStrictEqual(vol.popup(), { volume: 9, muted: true, max: 40 });
});

test('no SOME/IP (the PC): no popup, the reason kept', async () => {
    const vol = createCarVolume(null, log, {});
    await wait(10);
    assert.strictEqual(vol.popup(), null);
    assert.ok(vol.state().error);
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); console.log('ok   ' + t.name); }
        catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
    }
    console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
