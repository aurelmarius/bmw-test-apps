'use strict';
/**
 * The Music Assistant app's logic off the car: the Status tab's steps from a service status, where a track is now
 * (Sendspin's progress moved on while it plays), the cluster card's time, a media item's version in its name.
 *
 *   node tests/music_app.test.js
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

// main.js loads the kit (copied in by the build); for its pure functions, a stub kit that runs nothing
const APP = path.join(__dirname, '..', 'apps', 'aurelm_music');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent) {
    if (/^\.\/kit\//.test(req) && parent && parent.filename.indexOf(APP) === 0) return path.join(__dirname, '..', 'kit', 'runtime', req.slice(6) + (/\.js$/.test(req) ? '' : '.js'));
    return realResolve.apply(this, arguments);
};
const mguPath = path.join(__dirname, '..', 'kit', 'runtime', 'mgu.js');
require.cache[mguPath] = { id: mguPath, filename: mguPath, loaded: true, exports: { run() {} } };
const { steps, position } = require(path.join(APP, 'main'));
const { hm, ascii } = require(path.join(APP, 'cluster_card'));
const { slim } = require(path.join(__dirname, '..', 'native', 'aurelm-music', 'ma'));

const x = { carAudio: { connected: true }, cluster: { state: 'shown', detail: 'on the cluster' }, wheel: { on: true, seen: true, last: 'next' } };
let rows = steps(null, x);
assert.strictEqual(rows[0].state, 'bad');
rows = steps({ version: '0.1.0', uplink: { online: true, iface: 'usb0', ip: '10.0.0.2' }, account: null, client: {}, page: { open: true } }, x);
assert.deepStrictEqual(rows.map((r) => r.label + ':' + r.state), ['Service:ok', 'Internet:ok', 'Account:wait']);
rows = steps({ version: '0.1.0', device: 'BMW iDrive', uplink: { online: true, iface: 'usb0', ip: '10.0.0.2' }, account: { userName: 'Aurel', server: 'https://m' },
    client: { conn: 'connected', playerId: 'up1', format: { codec: 'opus', rate: 48000 }, ahead: 29000 }, player: { running: true, open: { device: 'plug:smartx:CarLifeMedia_CF_48_STEREO' }, played: 480000 } }, x);
assert.deepStrictEqual(rows.map((r) => r.label + ':' + r.state), ['Service:ok', 'Internet:ok', 'Account:ok', 'Sendspin:ok', 'Player:ok', 'Speakers:ok', 'Cluster:ok', 'Wheel:ok']);
assert.ok(/10 s played, 29 s buffered/.test(rows[4].detail), rows[4].detail);
console.log('ok   the steps');

const now = Date.now();
assert.strictEqual(position({ playback: 'paused', meta: { progressMs: 5000, durationMs: 60000, speed: 1000, progressAt: now - 3000 } }), 5000);
const p = position({ playback: 'playing', meta: { progressMs: 5000, durationMs: 60000, speed: 1000, progressAt: now - 3000 } });
assert.ok(p >= 7900 && p <= 8200, p);
assert.strictEqual(position({ playback: 'playing', meta: { progressMs: 59000, durationMs: 60000, speed: 1000, progressAt: now - 3000 } }), 60000);
assert.strictEqual(position({ meta: { title: 'x' } }), null);
console.log('ok   the position');

assert.strictEqual(hm(65), '1:05');
assert.strictEqual(ascii('Ștefan Bănică – Și ce?'), 'Stefan Banica - Si ce?');
assert.strictEqual(slim({ uri: 'u', media_type: 'track', name: 'Careless Whisper', version: 'Extended Mix' }).name, 'Careless Whisper (Extended Mix)');
assert.strictEqual(slim({ uri: 'u', media_type: 'album', name: 'EP', version: 'Deluxe' }).name, 'EP');
console.log('ok   the cluster card\'s time, transliteration, versions');
console.log('all 3 passed');
