'use strict';
/**
 * The receiver's sound to the speakers (apps/aurelm_airplay_probe/car_audio.js): node tests/airplay_car_audio.test.js
 * Against a fake audio manager: the order of the calls (as Moonride's), the leftover cleared, refusals reported.
 */
const assert = require('assert');
const path = require('path');
const { createCarAudio } = require(path.join(__dirname, '..', 'apps', 'aurelm_airplay_probe', 'car_audio'));

function fakeSignals(opts) {
    const o = opts || {};
    const calls = [];
    return {
        calls,
        proxy: (iface) => Promise.resolve({ iface }),
        onAvailable: (p, fn) => setImmediate(() => fn(true)),
        call: (p, method, args) => {
            calls.push(method + (args && args.sourceID != null ? ' ' + args.sourceID : '') + (args && args.sinkID != null ? '->' + args.sinkID : '') +
                (args && args.availability ? ' ' + args.availability.availability : '') + (args && args.mainConnectionID != null ? ' #' + args.mainConnectionID : ''));
            if (method === 'getListMainConnections') return Promise.resolve({ listConnections: o.leftover ? [{ mainConnectionID: 7, sourceID: 287 }, { mainConnectionID: 8, sourceID: 1 }] : [] });
            if (method === 'connect') return Promise.resolve(o.refuse ? { amError: 'E_NOT_POSSIBLE' } : { amError: 'E_OK', mainConnectionID: 42 });
            return Promise.resolve({ amError: 'E_OK' });
        },
    };
}
const log = { info() {}, warn() {} };
const settle = () => new Promise((r) => setTimeout(r, 50));
const tests = [];
const test = (n, f) => tests.push({ n, f });

test('at start: a 287 leftover disconnected, the source marked unavailable', async () => {
    const s = fakeSignals({ leftover: true });
    createCarAudio(s, log);
    await settle();
    assert.deepStrictEqual(s.calls, ['getListMainConnections', 'disconnect #7', 'hookSourceAvailablityStatusChange 287 A_UNAVAILABLE']);
});

test('on: available, then connect 287 -> 1024; off: disconnect it, unavailable again', async () => {
    const s = fakeSignals();
    const a = createCarAudio(s, log);
    await settle(); s.calls.length = 0;
    a.want(true); a.want(true);
    await settle();
    assert.deepStrictEqual(s.calls, ['hookSourceAvailablityStatusChange 287 A_AVAILABLE', 'connect 287->1024']);
    assert.deepStrictEqual(a.state(), { on: true, connected: true, error: null });
    s.calls.length = 0;
    a.want(false);
    await settle();
    assert.deepStrictEqual(s.calls, ['disconnect #42', 'hookSourceAvailablityStatusChange 287 A_UNAVAILABLE']);
    assert.strictEqual(a.state().connected, false);
});

test('a refused connect is reported', async () => {
    const s = fakeSignals({ refuse: true });
    const a = createCarAudio(s, log);
    a.want(true);
    await settle();
    assert.strictEqual(a.state().connected, false);
    assert.ok(/connect refused/.test(a.state().error));
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.f(); console.log('ok   ' + t.n); } catch (e) { failed++; console.log('FAIL ' + t.n + '\n     ' + String(e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
    }
    console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
