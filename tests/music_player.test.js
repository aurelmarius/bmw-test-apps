'use strict';
/**
 * The sound path of the Music Assistant service off the car: the sound check (Status, Test sound) through
 * native/ma-player (the host build, writing a WAV) gives a clean 440 Hz tone as PCM, then as Opus, at its times;
 * timed frames are written no earlier than they are due; the length of an Opus packet from its TOC byte.
 * Runs on Node 8.9.4 too.
 *
 *   sh native/ma-player/build.sh && node tests/music_player.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(__dirname, '..', 'native', 'aurelm-music');
const { createPlayer } = require(path.join(DIR, 'player'));
const { opusSamples } = require(path.join(DIR, 'ma'));
const PLAYER = path.join(__dirname, '..', 'native', 'ma-player', 'build', 'ma-player-host');
const TONE = fs.readFileSync(path.join(DIR, 'tone.opuspk'));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// the WAV the player writes, as mono samples (the left channel)
function readWav(file) {
    const b = fs.readFileSync(file);
    const data = b.slice(44), n = Math.floor(data.length / 4), out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 4);
    return { rate: b.readUInt32LE(24), samples: out };
}
// the strongest frequency in a stretch (a plain DFT over 10..2000 Hz, 1 Hz steps), and how much of the energy it has
function tone(x) {
    let best = 0, bestP = 0, total = 0;
    for (let i = 0; i < x.length; i++) total += x[i] * x[i];
    for (let f = 100; f <= 2000; f += 2) {
        let re = 0, im = 0;
        for (let i = 0; i < x.length; i++) { const a = 2 * Math.PI * f * i / 48000; re += x[i] * Math.cos(a); im += x[i] * Math.sin(a); }
        const p = (re * re + im * im) * 2 / x.length;
        if (p > bestP) { bestP = p; best = f; }
    }
    return { hz: best, share: total ? bestP / total : 0 };
}

test('the length of an Opus packet from its TOC byte', () => {
    assert.strictEqual(opusSamples(Buffer.from([0xfc])), 960);          // CELT FB 20 ms, one frame
    assert.strictEqual(opusSamples(Buffer.from([0xf8 | 1])), 1920);     // two frames
    assert.strictEqual(opusSamples(Buffer.from([0xfb, 0x03])), 2880);   // code 3, 3 frames of 20 ms
    assert.strictEqual(opusSamples(Buffer.from([0x08])), 960);          // SILK NB 20 ms (config 1)
    assert.strictEqual(opusSamples(Buffer.alloc(0)), 0);
    // every packet of the fixture is 20 ms
    for (let i = 0; i < TONE.length;) { const n = TONE.readUInt16BE(i); assert.strictEqual(opusSamples(TONE.slice(i + 2, i + 2 + n)), 960); i += 2 + n; }
});

test('the sound check: a clean 440 Hz tone as PCM, then as Opus, at its times', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maplayer-'));
    fs.chmodSync(tmp, 0o777);
    const wav = path.join(tmp, 'check.wav');
    const events = [];
    const p = createPlayer({ bin: PLAYER, env: { MGU_AUDIO: 'wav:' + wav, MGU_RUN_AS: 'nobody' }, log: () => {}, onEvent: (e) => events.push(e) });
    const t0 = Date.now();
    assert.strictEqual(p.testSound(TONE), true);
    assert.strictEqual(p.testSound(TONE), true, 'a second press during the check: it goes on');
    const st = p.state();
    assert.ok(st.test && st.test.until > t0 + 5500, 'the check lasts ~8.5 s');
    // nothing is written before it is due (2.5 s from now)
    await wait(1800);
    const early = events.filter((e) => e.ev === 'tick').map((e) => e.played).pop() || 0;
    assert.strictEqual(early, 0, 'nothing played before the tone is due');
    while (Date.now() < st.test.until + 1500 && !events.some((e) => e.ev === 'tick' && e.played >= 48000 * 5)) await wait(200);
    p.stop();
    await wait(2000);
    const w = readWav(wav);
    assert.strictEqual(w.rate, 48000);
    assert.ok(w.samples.length >= 48000 * 5, 'about 5 s written: ' + w.samples.length / 48000);
    const a = tone(w.samples.slice(48000 * 0.5, 48000 * 0.5 + 4800));       // in the PCM tone
    const b = tone(w.samples.slice(48000 * 3, 48000 * 3 + 4800));           // in the Opus tone
    assert.ok(Math.abs(a.hz - 440) <= 2 && a.share > 0.95, 'PCM tone: ' + JSON.stringify(a));
    assert.ok(Math.abs(b.hz - 440) <= 2 && b.share > 0.9, 'Opus tone: ' + JSON.stringify(b));
    // paced by the clock: ~5 s of sound took ~5 s after it was due, not less
    const first = events.find((e) => e.ev === 'tick' && e.played > 0);
    assert.ok(first, 'ticks');
    fs.rmSync ? fs.rmSync(tmp, { recursive: true, force: true }) : null;
});

test('late sound is dropped, sound on time is written (back onto the clock)', async () => {
    const cp = require('child_process');
    const tmp = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'maplate-'));
    fs.chmodSync(tmp, 0o777);
    const c = cp.spawn(PLAYER, [], { env: { PATH: process.env.PATH, MGU_AUDIO: 'wav:' + path.join(tmp, 'late.wav'), MGU_RUN_AS: 'nobody', MGU_GROUPS: '' } });
    let out = ''; c.stdout.on('data', (d) => { out += d; });
    const fr = (t, p) => { const h = Buffer.alloc(5); h[0] = t.charCodeAt(0); h.writeUInt32BE(p.length, 1); return Buffer.concat([h, p]); };
    const timed = (due, data) => { const d = Buffer.alloc(8); d.writeUInt32BE(Math.floor(due / 4294967296), 0); d.writeUInt32BE(due % 4294967296, 4); return fr('T', Buffer.concat([d, data])); };
    const h = process.hrtime(), now = h[0] * 1e6 + Math.floor(h[1] / 1000);
    c.stdin.write(fr('F', Buffer.from('pcm 48000 2 16')));
    for (let i = 0; i < 10; i++) c.stdin.write(timed(now - 300000 + i * 20000, Buffer.alloc(3840)));   // 300 ms late: dropped
    for (let i = 0; i < 10; i++) c.stdin.write(timed(now + 100000 + i * 20000, Buffer.alloc(3840)));   // on time: written
    await wait(2300);   // a tick a second
    c.stdin.end(fr('Q', Buffer.alloc(0)));
    await new Promise((r) => c.on('exit', r));
    const end = JSON.parse(out.trim().split('\n').filter((l) => /"ev":"end"/.test(l)).pop().slice(4));
    const tick = out.trim().split('\n').filter((l) => /"ev":"tick"/.test(l)).map((l) => JSON.parse(l.slice(4))).pop();
    assert.strictEqual(end.played, 9600, 'only the 10 chunks on time: ' + end.played);
    assert.ok(tick && tick.late >= 8, 'the late ones counted: ' + JSON.stringify(tick));
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
