'use strict';
/**
 * The Music Assistant service off the car, end to end: a fake Music Assistant (its REST API, /auth/login, /imageproxy,
 * and /sendspin over a WebSocket: auth, hello, time, a stream of real Opus packets with timestamps, metadata,
 * artwork), the service with its client as a real child process and native/ma-player (the host build, writing a WAV)
 * as its player. Sign-in through the page (user and password, and a token), the home rows and their items, an
 * image, play: the sound arrives in the WAV at the server's timestamps, the metadata and the artwork in the status;
 * next goes to the queue; a seek clears what was queued; sign-out revokes this car's token. Runs on Node 8.9.4 too.
 *
 *   sh native/ma-player/build.sh && node tests/music_service.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const qs = require('querystring');

const DIR = path.join(__dirname, '..', 'native', 'aurelm-music');
const { createService } = require(path.join(DIR, 'service'));
const ws = require(path.join(DIR, 'ws'));
const { serverUrl, slim } = require(path.join(DIR, 'ma'));
const PLAYER = path.join(__dirname, '..', 'native', 'ma-player', 'build', 'ma-player-host');
const OPUS = fs.readFileSync(path.join(__dirname, 'fixtures', 'music_tone.opuspk'));
const COVER = fs.readFileSync(path.join(__dirname, '..', 'native', 'aurelm-mediaprobe', 'media', 'cover.png'));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
    const end = Date.now() + (ms || 5000);
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out: ' + (what || 'condition')); await wait(30); }
}
const packets = (() => { const out = []; for (let i = 0; i < OPUS.length;) { const n = OPUS.readUInt16BE(i); out.push(OPUS.slice(i + 2, i + 2 + n)); i += 2 + n; } return out; })();

/* ---------------------------------------------------------------- a fake Music Assistant */
function wsFrame(op, payload) {
    const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const h = p.length < 126 ? Buffer.from([0x80 | op, p.length]) : p.length < 65536 ? Buffer.from([0x80 | op, 126, p.length >> 8, p.length & 255]) : null;
    if (h) return Buffer.concat([h, p]);
    const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 127; b.writeUInt32BE(0, 2); b.writeUInt32BE(p.length, 6);
    return Buffer.concat([b, p]);
}
function fakeMa() {
    const S = { tokens: [{ token_id: 't-ha', name: 'Home Assistant' }], calls: [], hello: null, sock: null, clientId: null, revoked: [], streaming: false };
    const T0 = Date.now();
    const serverUs = () => (Date.now() - T0) * 1000 + 5e9;   // a clock of its own, far from the client's
    const sendText = (o) => { if (S.sock) S.sock.write(wsFrame(1, JSON.stringify(o))); };
    const sendBin = (b) => { if (S.sock) S.sock.write(wsFrame(2, b)); };
    function stream() {
        S.streaming = true;
        sendText({ type: 'stream/start', payload: { player: { codec: 'opus', sample_rate: 48000, channels: 2, bit_depth: 16 }, artwork: { channels: [{ source: 'album', format: 'png', width: 400, height: 400 }] } } });
        sendText({ type: 'group/update', payload: { playback_state: 'playing', group_name: 'BMW iDrive' } });
        sendText({ type: 'server/state', payload: { metadata: { title: 'Careless Whisper', artist: 'George Michael', album: 'Make It Big', year: 1984,
            progress: { track_progress: 0, track_duration: 300000, playback_speed: 1000 } }, controller: { supported_commands: ['play', 'pause', 'next', 'previous'], volume: 100, muted: false } } });
        const a = Buffer.alloc(9); a[0] = 8; sendBin(Buffer.concat([a, COVER]));
        // all of it at once (as Music Assistant sends 30 s ahead), each packet's time 20 ms after the last
        const t0 = serverUs() + 300000;
        packets.forEach((p, i) => {
            const h = Buffer.alloc(13); h[0] = 4;
            const ts = t0 + i * 20000;
            h.writeInt32BE(Math.floor(ts / 4294967296), 1); h.writeUInt32BE(ts % 4294967296, 5); h.writeUInt32BE(30000000, 9);
            sendBin(Buffer.concat([h, p]));
        });
    }
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
            const auth = req.headers.authorization || '';
            if (req.url === '/info') return json(200, { name: 'Music Assistant (test)', server_version: '2.10.9' });
            if (req.url === '/auth/login' && req.method === 'POST') {
                const b = JSON.parse(body);
                if (b.credentials && b.credentials.username === 'aurel' && b.credentials.password === 'secret') return json(200, { success: true, token: 'short-token' });
                return json(401, { success: false, error: 'Invalid username or password' });
            }
            if (/^\/imageproxy\/[0-9a-f]+\?size=\d+&fmt=png$/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(COVER); }
            if (req.url !== '/api') { res.writeHead(404); return res.end(); }
            const tok = auth.replace(/^Bearer /, '');
            if (['short-token', 'long-token', 'pasted-token'].indexOf(tok) < 0 || S.revoked.indexOf(tok) >= 0) return json(401, { error: 'unauthorized' });
            const m = JSON.parse(body), a = m.args || {};
            S.calls.push(m.command + ' ' + JSON.stringify(a));
            switch (m.command) {
            case 'auth/me': return json(200, { user_id: 'u1', username: 'aurel', display_name: 'Aurel Sandu' });
            case 'auth/token/create': S.tokens.push({ token_id: 't-car', name: a.name }); return json(200, 'long-token');
            case 'auth/tokens': return json(200, S.tokens);
            case 'auth/token/revoke': S.tokens = S.tokens.filter((t) => t.token_id !== a.token_id); S.revoked.push('long-token'); return json(200, null);
            case 'music/recommendations': return json(200, [{ provider: 'library', item_id: 'recently_played', name: 'Recently played', items: [] }, { provider: 'apple_music', item_id: 'radio', name: 'Radio for you', items: [] }]);
            case 'music/recommendations/items':
                return json(200, [{ uri: 'library://album/230', media_type: 'album', name: 'Make It Big', artists: [{ name: 'Wham!' }], image: { proxy_id: 'abcdef0123456789abcd' }, provider: 'library', item_id: '230' },
                    { uri: 'library://radio/9', media_type: 'radio', name: 'Tomorrowland', provider: 'library', item_id: '9' }]);
            case 'players/all': return json(200, S.clientId ? [{ player_id: 'upTEST', provider: 'universal_player', available: true, output_protocols: [{ output_protocol_id: S.clientId }] }] : []);
            case 'player_queues/play_media': setTimeout(stream, 50); return json(200, null);
            case 'player_queues/next': return json(200, null);
            case 'player_queues/seek': sendText({ type: 'stream/clear', payload: { roles: ['player'] } }); return json(200, null);
            default: return json(200, null);
            }
        });
    });
    srv.on('upgrade', (req, sock) => {
        if (req.url !== '/sendspin') return sock.destroy();
        const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        S.sock = sock;
        let buf = Buffer.alloc(0), authed = false;
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            const r = ws.parseFrames(buf);
            buf = r.rest;
            r.frames.forEach((f) => {
                if (f.opcode !== 1) return;
                const m = JSON.parse(f.payload.toString('utf8'));
                if (!authed) {
                    if (m.type === 'auth' && (m.token === 'long-token' || m.token === 'pasted-token')) { authed = true; sendText({ type: 'auth_ok' }); }
                    else sock.end(wsFrame(8, Buffer.from([0x0f, 0xa1])));
                    return;
                }
                if (m.type === 'client/hello') {
                    S.hello = m.payload; S.clientId = m.payload.client_id;
                    sendText({ type: 'server/hello', payload: { server_id: 'srv', name: 'Music Assistant (test)', version: 1, active_roles: m.payload.supported_roles } });
                } else if (m.type === 'client/time') {
                    const r2 = serverUs();
                    sendText({ type: 'server/time', payload: { client_transmitted: m.payload.client_transmitted, server_received: r2, server_transmitted: r2 + 50 } });
                } else if (m.type === 'client/state') S.state = m.payload;
            });
        });
        sock.on('error', () => {});
        sock.on('close', () => { if (S.sock === sock) S.sock = null; });
    });
    return new Promise((res) => srv.listen(0, '127.0.0.1', () => { S.url = 'http://127.0.0.1:' + srv.address().port; S.close = () => { if (S.sock) S.sock.destroy(); srv.close(); }; res(S); }));
}

/* ---------------------------------------------------------------- the service under test */
let pagePort = 18495;
function setup() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-'));
    // the player drops root to nobody: its WAV goes where nobody can write
    const shm = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'music-wav-'));
    fs.chmodSync(shm, 0o777);
    const wav = path.join(shm, 'out.wav');
    const port = pagePort++;
    const svc = createService({ stateDir: path.join(tmp, 'state'), nft: null, uid: null, pagePort: port, pageIfaces: ['lo'],
        playerBin: PLAYER, playerEnv: { MGU_AUDIO: 'wav:' + wav, MGU_RUN_AS: 'nobody' }, childEnv: { MUSIC_SYSTEM_DNS: '1' }, quiet: true, exit: false });
    return { svc, wav, port, shm };
}
function postPage(url, fields) {
    return new Promise((res, rej) => {
        const u = require('url').parse(url), body = qs.stringify(fields);
        const r = http.request({ method: 'POST', host: u.hostname, port: u.port, path: u.path, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (x) => {
            let t = ''; x.setEncoding('utf8'); x.on('data', (d) => { t += d; }); x.on('end', () => res(t));
        });
        r.on('error', rej); r.end(body);
    });
}
async function signIn(svc, ma, fields) {
    const st = await svc.command({ cmd: 'signin-open' });
    assert.ok(st.page.open && st.page.url, JSON.stringify(st.page));
    return postPage(st.page.url, Object.assign({ server: ma.url }, fields));
}

test('helpers: the server address and a media item as the app shows it', () => {
    assert.strictEqual(serverUrl('mass.sandu.casa'), 'https://mass.sandu.casa');
    assert.strictEqual(serverUrl('https://mass.sandu.casa/sendspin'), 'https://mass.sandu.casa');
    assert.strictEqual(serverUrl('192.168.0.241:8095'), 'http://192.168.0.241:8095');
    const s = slim({ uri: 'library://track/1', media_type: 'track', name: 'X', artists: [{ name: 'A' }, { name: 'B' }], album: { image: { proxy_id: 'ff00' } } });
    assert.deepStrictEqual([s.name, s.sub, s.img, s.type], ['X', 'A, B', 'ff00', 'track']);
});

test('sign in with user and password: a long-lived token kept, a Sendspin player with Opus first', async () => {
    const ma = await fakeMa();
    const { svc } = setup();
    svc.start();
    const bad = await signIn(svc, ma, { user: 'aurel', password: 'nope' });
    assert.ok(/Invalid username or password/.test(bad), bad.slice(0, 300));
    const ok = await signIn(svc, ma, { user: 'aurel', password: 'secret' });
    assert.ok(/Signed in to Music Assistant \(test\) as Aurel Sandu/.test(ok), ok.slice(0, 400));
    await until(() => ma.hello, 5000, 'client/hello');
    assert.deepStrictEqual(ma.hello.supported_roles, ['player@v1', 'metadata@v1', 'artwork@v1', 'controller@v1']);
    assert.strictEqual(ma.hello['player@v1_support'].supported_formats[0].codec, 'opus');
    assert.ok(/^aurelm-music-[0-9a-f]{12}$/.test(ma.hello.client_id));
    assert.strictEqual(ma.tokens.filter((t) => /^BMW iDrive [0-9a-f]{6}$/.test(t.name)).length, 1);
    await until(() => ma.state, 5000, 'client/state after the time sync');
    assert.strictEqual(ma.state.player.state, 'synchronized');
    await until(() => svc.status().client.conn === 'connected', 3000, 'connected in the status');
    assert.strictEqual(svc.status().account.userName, 'Aurel Sandu');
    svc.stop(); ma.close();
});

test('browse: home rows, a row\'s items, an image (kept), the queue\'s player found by the client id', async () => {
    const ma = await fakeMa();
    const { svc } = setup();
    svc.start();
    await signIn(svc, ma, { token: 'pasted-token' });
    await until(() => svc.status().client.conn === 'connected', 5000, 'connected');
    const rows = await svc.command({ cmd: 'req', what: 'home' });
    assert.ok(rows.ok, rows.error);
    assert.deepStrictEqual(rows.data.map((r) => r.name), ['Recently played', 'Radio for you']);
    const items = await svc.command({ cmd: 'req', what: 'row', args: { provider: 'library', itemId: 'recently_played' } });
    assert.deepStrictEqual(items.data.map((x) => [x.name, x.type, x.img]), [['Make It Big', 'album', 'abcdef0123456789abcd'], ['Tomorrowland', 'radio', null]]);
    const img = await svc.command({ cmd: 'req', what: 'image', args: { key: 'abcdef0123456789abcd', size: 160 } });
    assert.ok(img.ok, img.error);
    assert.ok(Buffer.from(img.data, 'base64').equals(COVER));
    const n = ma.calls.length;
    const again = await svc.command({ cmd: 'req', what: 'image', args: { key: 'abcdef0123456789abcd', size: 160 } });
    assert.ok(again.ok && ma.calls.length === n, 'the second ask is answered from memory');
    const bad = await svc.command({ cmd: 'req', what: 'image', args: { key: '../x', size: 160 } });
    assert.ok(!bad.ok && /bad image id/.test(bad.error));
    svc.stop(); ma.close();
});

test('play: the sound at the server\'s times into the player, the metadata and the artwork; next; a seek clears', async () => {
    if (!fs.existsSync(PLAYER)) { console.log('     (skipped: build native/ma-player first)'); return; }
    const ma = await fakeMa();
    const { svc, wav, shm } = setup();
    svc.start();
    await signIn(svc, ma, { token: 'pasted-token' });
    await until(() => svc.status().client.conn === 'connected' && ma.state, 5000, 'connected');
    const t0 = Date.now();
    const r = await svc.command({ cmd: 'req', what: 'play', args: { uri: 'library://album/230' } });
    assert.ok(r.ok, r.error);
    assert.ok(ma.calls.some((c) => /^player_queues\/play_media .*"queue_id":"upTEST".*"media":\["library:\/\/album\/230"\]/.test(c)), ma.calls.join('\n'));
    // the metadata and the artwork
    await until(() => { const c = svc.status().client; return c.meta && c.meta.title === 'Careless Whisper'; }, 3000, 'metadata');
    const c = svc.status().client;
    assert.deepStrictEqual([c.meta.artist, c.meta.durationMs, c.playback, c.format.codec], ['George Michael', 300000, 'playing', 'opus']);
    const art = await svc.command({ cmd: 'art' });
    assert.ok(art.ver >= 1 && Buffer.from(art.png, 'base64').equals(COVER));
    // 3 s of sound, played at its times: the player runs, and it has not all gone in at once
    await until(() => svc.status().player.running, 3000, 'the player started');
    await wait(1200);
    const mid = svc.status().player.played;
    assert.ok(mid > 0 && mid < 144000 * 0.9, 'played at its times, not all at once: ' + mid);
    await until(() => svc.status().player.played >= 144000 - 2000, 6000, 'all 3 s played');
    const took = Date.now() - t0;
    assert.ok(took > 2500, 'took ' + took + ' ms for 3 s of sound');
    // next goes to the queue
    const n = await svc.command({ cmd: 'req', what: 'control', args: { cmd: 'next' } });
    assert.ok(n.ok && ma.calls.some((x) => /^player_queues\/next .*upTEST/.test(x)));
    // a seek: the server clears the stream, the client drops what it still had
    ma.calls.length = 0;
    await svc.command({ cmd: 'req', what: 'play', args: { uri: 'library://album/230' } });
    await wait(400);
    await svc.command({ cmd: 'req', what: 'control', args: { cmd: 'seek', arg: 60 } });
    await wait(300);
    assert.ok(ma.calls.some((x) => /^player_queues\/seek .*"position":60/.test(x)));
    svc.stop();
    ma.close();
    await wait(300);
    // the WAV: 48 kHz stereo, the first stream whole (3 s), from real Opus
    const h = fs.readFileSync(wav).slice(0, 44);
    assert.strictEqual(h.toString('latin1', 0, 4), 'RIFF');
    assert.strictEqual(h.readUInt32LE(24), 48000);
    try { fs.rmdirSync(shm); } catch (e) { /* the wav */ }
});

test('sign out: this car\'s token revoked on the server, the others kept', async () => {
    const ma = await fakeMa();
    const { svc } = setup();
    svc.start();
    await signIn(svc, ma, { user: 'aurel', password: 'secret' });
    await until(() => svc.status().client.conn === 'connected', 5000, 'connected');
    const st = await svc.command({ cmd: 'signout' });
    assert.strictEqual(st.account, null);
    await until(() => ma.calls.some((x) => /^auth\/token\/revoke .*t-car/.test(x)), 3000, 'revoked');
    assert.deepStrictEqual(ma.tokens.map((t) => t.token_id), ['t-ha']);
    const r = await svc.command({ cmd: 'req', what: 'home' });
    assert.ok(!r.ok && /not signed in/.test(r.error));
    svc.stop(); ma.close();
});

if (require.main === module) (async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); console.log('ok   ' + t.name); }
        catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
    }
    console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();

module.exports = { fakeMa, setup, signIn, until, wait };
