'use strict';
/**
 * The film's sound to the speakers (apps/aurelm_emby/car_audio.js, AirPlay Test's module with two more checks):
 * node tests/emby_car_audio.test.js. Against a fake audio manager: only our own connection ever disconnected (287 is
 * shared with AirPlay Test), an id from before a restart forgotten, the source left available while the other app
 * plays, another app's connection never taken over.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs'), os = require('os');
const { createCarAudio } = require(path.join(__dirname, '..', 'apps', 'aurelm_emby', 'car_audio'));

function fakeSignals(opts) {
    const o = opts || {};
    const calls = [];
    return {
        calls, o,
        proxy: (iface) => Promise.resolve({ iface }),
        onAvailable: (p, fn) => setImmediate(() => fn(true)),
        call: (p, method, args) => {
            calls.push(method + (args && args.sourceID != null ? ' ' + args.sourceID : '') + (args && args.sinkID != null ? '->' + args.sinkID : '') +
                (args && args.availability ? ' ' + args.availability.availability : '') + (args && args.mainConnectionID != null ? ' #' + args.mainConnectionID : ''));
            if (method === 'getListMainConnections') return Promise.resolve({ listConnections: (o.list || []).slice() });
            if (method === 'disconnect') {
                o.list = (o.list || []).filter((c) => c.mainConnectionID !== args.mainConnectionID);
                // the other app connects in the moment after our disconnect
                if (o.otherAfterDisconnect) o.list.push({ mainConnectionID: 77, sourceID: 287 });
            }
            if (method === 'connect') {
                if (o.refuse) return Promise.resolve({ amError: 'E_NOT_POSSIBLE' });
                (o.list = o.list || []).push({ mainConnectionID: 42, sourceID: 287 });
                return Promise.resolve({ amError: 'E_OK', mainConnectionID: 42 });
            }
            return Promise.resolve({ amError: 'E_OK' });
        },
    };
}
const log = { info() {}, warn() {} };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eca-')), 'car-audio.json');
const settle = () => new Promise((r) => setTimeout(r, 50));
const tests = [];
const test = (n, f) => tests.push({ n, f });
const boot = (id) => () => id;

test('on, then off: connect 287 -> 1024 with the id saved with the boot; off: our disconnect, unavailable', async () => {
    const file = tmpFile();
    const s = fakeSignals();
    const a = createCarAudio(s, log, { file, bootId: boot('b1') });
    await settle(); s.calls.length = 0;
    a.want(true);
    await settle();
    assert.deepStrictEqual(s.calls, ['getListMainConnections', 'hookSourceAvailablityStatusChange 287 A_AVAILABLE', 'connect 287->1024']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mainConnectionID: 42, boot: 'b1' });
    s.calls.length = 0;
    a.want(false);
    await settle();
    assert.deepStrictEqual(s.calls, ['disconnect #42', 'getListMainConnections', 'hookSourceAvailablityStatusChange 287 A_UNAVAILABLE']);
    assert.ok(!fs.existsSync(file));
});

test('a leftover of ours from this boot: disconnected at start', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ mainConnectionID: 7, boot: 'b1' }));
    const s = fakeSignals({ list: [{ mainConnectionID: 7, sourceID: 287 }] });
    createCarAudio(s, log, { file, bootId: boot('b1') });
    await settle();
    assert.deepStrictEqual(s.calls, ['getListMainConnections', 'disconnect #7', 'getListMainConnections', 'hookSourceAvailablityStatusChange 287 A_UNAVAILABLE']);
    assert.ok(!fs.existsSync(file));
});

test('an id from before a restart: forgotten, the connection with that number (AirPlay\'s now) left alone', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ mainConnectionID: 7, boot: 'old' }));
    const s = fakeSignals({ list: [{ mainConnectionID: 7, sourceID: 287 }] });
    createCarAudio(s, log, { file, bootId: boot('new') });
    await settle();
    assert.deepStrictEqual(s.calls, []);
    assert.ok(!fs.existsSync(file));
    // AirPlay Test 0.8.3's file (no boot): forgotten too
    fs.writeFileSync(file, JSON.stringify({ mainConnectionID: 7 }));
    const s2 = fakeSignals({ list: [{ mainConnectionID: 7, sourceID: 287 }] });
    createCarAudio(s2, log, { file, bootId: boot('new') });
    await settle();
    assert.deepStrictEqual(s2.calls, []);
});

test('the other app connected right after our disconnect: the source stays available', async () => {
    const s = fakeSignals();
    const a = createCarAudio(s, log, { file: tmpFile(), bootId: boot('b1') });
    a.want(true);
    await settle();
    s.o.otherAfterDisconnect = true;
    s.calls.length = 0;
    a.want(false);
    await settle();
    assert.deepStrictEqual(s.calls, ['disconnect #42', 'getListMainConnections']);
});

test('287 in use by AirPlay Test: not connected, reported taken; connected once it is free', async () => {
    const s = fakeSignals({ list: [{ mainConnectionID: 9, sourceID: 287 }] });
    const a = createCarAudio(s, log, { file: tmpFile(), bootId: boot('b1') });
    a.want(true);
    await settle();
    assert.deepStrictEqual(s.calls, ['getListMainConnections']);
    assert.strictEqual(a.state().taken, true);
    a.want(false);
    await settle();
    assert.deepStrictEqual(s.calls, ['getListMainConnections']);
    s.o.list = [];
    a.want(true);
    await settle();
    assert.strictEqual(a.state().connected, true);
});

test('a refused connect: reported; the source unavailable again only when 287 is empty', async () => {
    const s = fakeSignals({ refuse: true });
    const a = createCarAudio(s, log, { file: tmpFile(), bootId: boot('b1') });
    a.want(true);
    await settle();
    assert.ok(/connect refused/.test(a.state().error));
    assert.deepStrictEqual(s.calls.slice(-2), ['getListMainConnections', 'hookSourceAvailablityStatusChange 287 A_UNAVAILABLE']);
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.f(); console.log('ok   ' + t.n); } catch (e) { failed++; console.log('FAIL ' + t.n + '\n     ' + (e && e.stack || e)); }
    }
    console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
