'use strict';
/**
 * The Emby cast service off the car: a fake Emby server (HTTP API + /embywebsocket), the service with its
 * client as a real child process, the sign-in page, a Play / Playstate from the "phone", sign-out. Playback:
 * PlaybackInfo with our profile, the stream through the service to a player (tests/fixtures/fake_player.js; and
 * native/emby-player itself when it is built), pause, seek, volume, stop and the reports. Also the WebSocket
 * frames and TLS against our own CA list. Runs on Node 8.9.4 too.
 *
 *   node tests/emby_service.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const qs = require('querystring');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'native', 'aurelm-emby');
const ws = require(path.join(DIR, 'ws'));
const emby = require(path.join(DIR, 'emby'));
const nft = require(path.join(DIR, 'nft'));
const { createNet } = require(path.join(DIR, 'netx'));
const playback = require(path.join(DIR, 'playback'));
const FIXTURES = path.join(__dirname, 'fixtures');
const PLAYER = path.join(__dirname, '..', 'native', 'emby-player', 'build', 'emby-player');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
    const end = Date.now() + (ms || 5000);
    for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out: ' + (what || 'condition')); await wait(30); }
}

/** a fake Emby server: the calls the service makes, and a way to send it WebSocket messages */
function fakeEmby(opts) {
    const o = opts || {};
    const seen = { calls: [], caps: null, sockets: [], logout: 0, auth: [], pbinfo: [], streams: [], reports: [], encStops: [] };
    let sessions = 0;
    const TOKEN = 'tok-' + crypto.randomBytes(4).toString('hex');
    const handler = (req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            const p = req.url.split('?')[0];
            seen.calls.push(req.method + ' ' + p);
            const json = (code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(v === undefined ? '' : JSON.stringify(v)); };
            if (p === '/System/Info/Public') return json(200, { Id: 'srv1', ServerName: 'Home Emby', Version: '4.9.1.80' });
            if (p === '/Users/AuthenticateByName') {
                const b = JSON.parse(body || '{}');
                seen.auth.push({ header: req.headers.authorization, user: b.Username });
                if (b.Username !== 'aurel' || b.Pw !== 'secret') return json(401);
                return json(200, { AccessToken: TOKEN, User: { Id: 'u1', Name: 'aurel' }, SessionInfo: { Id: 's1' } });
            }
            if (req.headers['x-emby-token'] !== TOKEN || o.revoked) return json(401);
            if (p === '/System/Info') return json(200, { ServerName: 'Home Emby', Version: '4.9.1.80' });
            if (p === '/Sessions/Capabilities/Full') { seen.caps = JSON.parse(body); seen.capsCount = (seen.capsCount || 0) + 1; return json(204); }
            if (p === '/Sessions' && qs.parse(req.url.split('?')[1] || '').ActiveWithinSeconds) return json(200, [{ Id: 'sess-car', DeviceName: 'BMW iDrive', UserId: 'u1' }].concat(o.phonePlaying ? [
                { Id: 'phone1', DeviceId: 'iphone-1', DeviceName: 'iPhone', Client: 'Emby for iOS', UserId: 'u1', LastActivityDate: new Date().toISOString(),
                    NowPlayingItem: { Id: 'film2', Name: 'Sample', MediaType: 'Video' },
                    PlayState: { PositionTicks: 3389270000, MediaSourceId: 'ms2', AudioStreamIndex: 1, SubtitleStreamIndex: 2 } }] : []));
            if (p === '/Sessions/phone1/Playing/Stop') { seen.phoneStopped = (seen.phoneStopped || 0) + 1; return json(204); }
            if (p === '/Sessions') return json(200, [{ Id: 'sess-car', DeviceName: 'BMW iDrive' }]);
            if (p === '/Sessions/Logout') { seen.logout++; return json(204); }
            const query = qs.parse(req.url.split('?')[1] || '');
            if (p === '/Users/u1/Items' && /DatePlayed/.test(query.SortBy || '')) return json(200, { Items: o.lastPlayedAgo == null ? [] : [{ Id: 'film2', Name: 'Sample', Type: 'Movie',
                UserData: { LastPlayedDate: new Date(Date.now() - o.lastPlayedAgo).toISOString(), PlaybackPositionTicks: o.resumeTicks || 0 } }] });
            if (p === '/Users/u1/Items/film2') return json(200, { Id: 'film2', Name: 'Sample', Type: 'Movie', MediaType: 'Video', RunTimeTicks: (o.seconds || 3) * 10000000,
                MediaSources: [{ Id: 'ms2', Container: 'mkv', MediaStreams: [{ Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160 }, { Type: 'Audio', Codec: 'eac3', Channels: 6, IsDefault: true }] }] });
            if (p === '/Items/film2/PlaybackInfo' && req.method === 'POST') {
                seen.pbinfo.push({ query, body: JSON.parse(body || '{}') });
                const ps = 'ps-' + (++sessions);
                return json(200, { PlaySessionId: ps, MediaSources: [{ Id: 'ms2', SupportsTranscoding: true, TranscodeReasons: ['VideoCodecNotSupported'],
                    DefaultSubtitleStreamIndex: -1, MediaStreams: [
                        { Type: 'Subtitle', Index: 2, Codec: 'subrip', Language: 'rum', DisplayTitle: 'Romanian (SUBRIP)', DeliveryMethod: 'External',
                            DeliveryUrl: '/Videos/film2/ms2/Subtitles/2/0/Stream.subrip?api_key=' + TOKEN },
                        { Type: 'Subtitle', Index: 3, Codec: 'PGSSUB', Language: 'eng', DeliveryMethod: 'Encode' }],
                    TranscodingUrl: '/videos/film2/stream.ts?MediaSourceId=ms2&PlaySessionId=' + ps + '&api_key=' + TOKEN + '&StartTimeTicks=0&VideoCodec=h264' }] });
            }
            if (p === '/videos/film2/stream.ts') {
                seen.streams.push({ query, token: req.headers['x-emby-token'] });
                if (o.streamFails) { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('Error'); }
                // a heavy transcode: the head of the answer comes late
                return setTimeout(() => {
                    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
                    res.end(o.media || Buffer.alloc(188 * 200, 0x47));
                }, o.streamDelay || 0);
            }
            // the server's logs (an administrator's): the newest transcode log says why the stream does not come
            if (p === '/System/Logs') return json(200, [{ Name: 'embyserver.txt', DateModified: '2026-11-09T12:00:00Z' }, { Name: 'embyserver-63904.txt', DateModified: '2026-11-01T12:00:00Z' },
                { Name: 'ffmpeg-transcode-old.txt', DateModified: '2026-11-09T11:00:00Z' }, { Name: 'ffmpeg-transcode-new.txt', DateModified: '2026-11-09T12:37:41Z' }]);
            if (p === '/System/Logs/embyserver.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('2026-11-10 07:11:37.1 Info Server: http/1.1 POST /Sessions/sess-car/Command. UserAgent: Emby/2.2.59\n2026-11-10 07:11:37.2 Info SessionManager: something else\n'); }
            if (p === '/System/Logs/ffmpeg-transcode-new.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ffmpeg version 6\nStream #0:0: Video: hevc (Main 10), dovi\n[hevc] Error parsing NAL\nConversion failed!\n'); }
            if (p === '/Videos/film2/ms2/Subtitles/2/0/Stream.srt') {
                seen.subs = (seen.subs || 0) + 1;
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                return res.end('1\r\n00:00:01,000 --> 00:00:03,000\r\n<i>Vreau să-ți spun</i>\r\n\r\n2\r\n00:00:12,000 --> 00:00:14,500\r\nAdio.\r\n');
            }
            if (p.indexOf('/Sessions/Playing') === 0) { seen.reports.push({ path: p, body: JSON.parse(body || '{}') }); return json(204); }
            if (p === '/Videos/ActiveEncodings' && req.method === 'DELETE') { seen.encStops.push(query); return json(204); }
            if (p === '/Users/u1/Items/film1') return json(200, { Id: 'film1', Name: 'Interstellar', ProductionYear: 2014, Type: 'Movie', RunTimeTicks: 101690000000,
                MediaSources: [{ Container: 'mkv', Bitrate: 12000000, MediaStreams: [
                    { Type: 'Video', Codec: 'hevc', Width: 1920, Height: 1080, Profile: 'Main 10', VideoRange: 'SDR' },
                    { Type: 'Audio', Codec: 'eac3', Channels: 6, Language: 'eng', IsDefault: true }] }] });
            json(404);
        });
    };
    const server = o.tls ? https.createServer({ key: o.tls.key, cert: o.tls.cert }, handler) : http.createServer(handler);
    server.on('upgrade', (req, sock) => {
        const q = qs.parse(req.url.split('?')[1] || '');
        if (req.url.split('?')[0] !== '/embywebsocket' || q.api_key !== TOKEN) { sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
        const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        const peer = { sock, got: [], deviceId: q.deviceId };
        let buf = Buffer.alloc(0);
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            const r = ws.parseFrames(buf); buf = r.rest;
            r.frames.forEach((f) => {
                if (f.opcode === 1) peer.got.push(JSON.parse(f.payload.toString()));
                if (f.opcode === 9) peer.got.push({ ping: true });
            });
        });
        sock.on('error', () => {});
        seen.sockets.push(peer);
        // the server's keepalive request, as Emby sends it
        sendTo(peer, { MessageType: 'ForceKeepAlive', Data: 60 });
    });
    function sendTo(peer, msg) {
        const data = Buffer.from(JSON.stringify(msg));
        const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
        peer.sock.write(Buffer.concat([head, data]));
    }
    return new Promise((res) => server.listen(0, '127.0.0.1', () => res({
        server, seen, TOKEN, port: server.address().port, url: (o.tls ? 'https' : 'http') + '://127.0.0.1:' + server.address().port,
        send: (msg) => seen.sockets.forEach((p) => { if (!p.sock.destroyed) sendTo(p, msg); }),
        close: () => { seen.sockets.forEach((p) => p.sock.destroy()); server.close(); },
        set: (k, v) => { o[k] = v; },
    })));
}

function ask(sock, cmd, extra) {
    return new Promise((res, rej) => {
        const c = require('net').connect(sock);
        let buf = '';
        c.setEncoding('utf8');
        c.on('connect', () => c.write(JSON.stringify(Object.assign({ cmd }, extra || {})) + '\n'));
        c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { c.destroy(); res(JSON.parse(buf.slice(0, i))); } });
        c.on('error', rej);
    });
}
function post(url, form) {
    return new Promise((res, rej) => {
        const body = qs.stringify(form);
        const u = require('url').parse(url);
        const r = http.request({ method: 'POST', host: u.hostname, port: u.port, path: u.path, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
            (x) => { let t = ''; x.on('data', (d) => { t += d; }); x.on('end', () => res({ status: x.statusCode, text: t })); });
        r.on('error', rej); r.end(body);
    });
}
function get(url) {
    return new Promise((res, rej) => http.get(url, (x) => { let t = ''; x.on('data', (d) => { t += d; }); x.on('end', () => res({ status: x.statusCode, text: t })); }).on('error', rej));
}

/** the service in a scratch folder, its client a real child process (no uid change, no nft, system DNS) */
function makeService(tmp, port, extra) {
    const { createService } = require(path.join(DIR, 'service'));
    const lease = path.join(tmp, 'lease.json');
    fs.writeFileSync(lease, JSON.stringify({ interface: 'vethuplink', ip: '10.0.0.2', dns: ['127.0.0.1'] }));
    const x = extra || {};
    // the fake player is a node script: node's folder on PATH (the service gives the player /usr/bin:/bin)
    const playerEnv = Object.assign({ PATH: path.dirname(process.execPath) + ':/usr/bin:/bin' }, x.playerEnv || {});
    const svc = createService(Object.assign({ stateDir: path.join(tmp, 'state'), nft: null, uid: null, pagePort: port, pageIfaces: ['lo'], leasePath: lease, exit: false,
        childEnv: { EMBY_SYSTEM_DNS: '1' }, playerBin: path.join(FIXTURES, 'fake_player.js'), videoPath: path.join(tmp, 'mgu-video-test') }, x, { playerEnv }));
    const sock = path.join(tmp, 'ctl.sock');
    const server = require('net').createServer();
    svc.serve(server);
    return new Promise((res) => server.listen(sock, () => { svc.start(); res({ svc, sock, server, lease }); }));
}
// os.networkInterfaces() marks lo internal: the page's interface list in the tests is the loopback
const realIfaces = os.networkInterfaces;
os.networkInterfaces = () => { const all = realIfaces(); (all.lo || []).forEach((a) => { a.internal = false; }); return all; };
const freePort = () => new Promise((res) => { const s = require('net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

/* ---------------- tests ---------------- */

test('websocket frames: masked out, unmasked in, split across reads', () => {
    const f = ws.frame(1, 'hello');
    assert.strictEqual(f[0], 0x81);
    assert.strictEqual(f[1] & 0x80, 0x80);
    const r = ws.parseFrames(f);
    assert.strictEqual(r.frames[0].payload.toString(), 'hello');
    const big = ws.frame(1, 'x'.repeat(70000));
    const a = ws.parseFrames(big.slice(0, 100));
    assert.strictEqual(a.frames.length, 0);
    const b = ws.parseFrames(big);
    assert.strictEqual(b.frames[0].payload.length, 70000);
    assert.throws(() => ws.parseFrames(Buffer.from([0x81, 127, 0, 0, 0, 1, 0, 0, 0, 0])), /too large/);
});

test('server address: as typed, else https then http', () => {
    assert.deepStrictEqual(emby.candidates('emby.example.com:8920/'), ['https://emby.example.com:8920', 'http://emby.example.com:8920']);
    assert.deepStrictEqual(emby.candidates(' HTTP://1.2.3.4:8096 '), ['http://1.2.3.4:8096']);
    assert.deepStrictEqual(emby.candidates(''), []);
    assert.ok(/^Emby Client="BMW iDrive", Device="BMW iDrive", DeviceId="d1", Version="0.1.0"$/.test(emby.authHeader({ id: 'd1', name: 'BMW iDrive' }, '0.1.0')));
});

test('item description: title, codecs, length', () => {
    const d = emby.describe({ Id: 'e1', Type: 'Episode', SeriesName: 'Dark', ParentIndexNumber: 1, IndexNumber: 2, Name: 'Lies', RunTimeTicks: 30000000000,
        MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 1280, Height: 720 }, { Type: 'Audio', Codec: 'aac', Channels: 2 }] });
    assert.strictEqual(d.title, 'Dark S1E2 - Lies');
    assert.strictEqual(d.seconds, 3000);
    assert.strictEqual(d.video.codec, 'h264');
    assert.strictEqual(d.audio.channels, 2);
});

test('firewall rules: the page port on the car Wi-Fi only, removed by comment', () => {
    assert.deepStrictEqual(nft.rulesFor('input', 'wlan_bridge', 8490), ['iifname "wlan_bridge" tcp dport 8490 accept']);
    assert.deepStrictEqual(nft.rulesFor('output', 'wlan_bridge', 8490), ['oifname "wlan_bridge" tcp sport 8490 accept']);
    assert.deepStrictEqual(nft.rulesFor('forward', 'wlan_bridge', 8490), []);
    const chains = nft.parse('table ip filter {\n chain input {\n type filter hook input priority 0; policy drop;\n iifname "wlan_bridge" tcp dport 8490 accept comment "aurelm-emby" # handle 7\n }\n}\ntable inet mgu_uplink {\n chain output {\n type filter hook output priority 0;\n }\n}\n');
    assert.strictEqual(chains.length, 2);
    assert.deepStrictEqual(chains[0].ours, ['7']);
    assert.strictEqual(nft.targets(chains).length, 2);
});

test('no internet: a clear error, no request', async () => {
    const nx = createNet({ leasePath: '/nonexistent/lease.json' });
    let err = null;
    try { await nx.request({ url: 'https://emby.example.com/System/Info/Public' }); } catch (e) { err = e; }
    assert.ok(err && err.code === 'EOFFLINE', String(err && err.message));
});

test('TLS: checked against our CA list (a server it does not sign is refused)', async function () {
    let ok = true;
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch (e) { ok = false; }
    if (!ok) return 'skipped (no openssl)';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emby-tls-'));
    const k = path.join(tmp, 'k.pem'), c = path.join(tmp, 'c.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', k, '-out', c, '-days', '2', '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    const srv = await fakeEmby({ tls: { key: fs.readFileSync(k), cert: fs.readFileSync(c) } });
    try {
        const lease = path.join(tmp, 'lease.json');
        fs.writeFileSync(lease, JSON.stringify({ ip: '10.0.0.2', dns: [] }));
        const trusted = createNet({ leasePath: lease, caPath: c });
        const r = await trusted.request({ url: srv.url + '/System/Info/Public' });
        assert.strictEqual(JSON.parse(r.body).ServerName, 'Home Emby');
        let err = null;
        try { await createNet({ leasePath: lease }).request({ url: srv.url + '/System/Info/Public' }); } catch (e) { err = e; }
        assert.ok(err, 'a self-signed server must be refused with the Mozilla list');
        // wss through the same socket maker
        const cl = emby.createClient({ nx: trusted, device: { id: 'd1', name: 'BMW iDrive' }, version: '0.1.0' });
        const acc = await cl.signIn(srv.url, 'aurel', 'secret');
        const statuses = [];
        cl.on('status', (s) => statuses.push(s.state));
        cl.run(acc);
        await until(() => statuses.indexOf('connected') >= 0, 5000, 'wss connected');
        cl.stop();
    } finally { srv.close(); }
});

test('the Mozilla CA list parses on this Node and has the Let\'s Encrypt roots', () => {
    const pem = fs.readFileSync(path.join(DIR, 'cacert.pem'), 'utf8');
    assert.ok(pem.indexOf('ISRG Root X1') >= 0);
    const certs = pem.split(/(?=-----BEGIN CERTIFICATE-----)/).filter((x) => x.indexOf('BEGIN') >= 0);
    assert.ok(certs.length > 100);
    require('tls').createSecureContext({ ca: certs });   // throws on a certificate this OpenSSL can't read
});

test('end to end: sign in from the page, cast target, Play, Playstate, sign out', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emby-svc-'));
    const srv = await fakeEmby();
    const port = await freePort();
    const { svc, sock, server } = await makeService(tmp, port);
    try {
        let s = await ask(sock, 'status');
        assert.strictEqual(s.version, '0.3.8');
        assert.strictEqual(s.account, null);
        assert.strictEqual(s.uplink.online, true);
        s = await ask(sock, 'signin-open');
        assert.ok(s.page.open, JSON.stringify(s.page));
        assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{12}$/.test(s.page.url), s.page.url);
        // a wrong token: nothing
        assert.strictEqual((await get('http://127.0.0.1:' + port + '/nope')).status, 404);
        const form = await get(s.page.url);
        assert.ok(/Server address/.test(form.text));
        // wrong password: the form again, with the error
        let r = await post(s.page.url, { server: srv.url, user: 'aurel', password: 'bad' });
        assert.ok(/wrong user name or password/.test(r.text), r.text);
        r = await post(s.page.url, { server: srv.url, user: 'aurel', password: 'secret' });
        assert.ok(/Signed in to Home Emby as aurel/.test(r.text), r.text);
        // the account is kept without the password, 0600
        const accFile = path.join(tmp, 'state', 'account.json');
        const acc = JSON.parse(fs.readFileSync(accFile, 'utf8'));
        assert.strictEqual(acc.token, srv.TOKEN);
        assert.ok(JSON.stringify(acc).indexOf('secret') < 0);
        assert.strictEqual(fs.statSync(accFile).mode & 0o777, 0o600);
        // connected: capabilities posted, our session found, keepalive answered
        await until(() => srv.seen.caps && srv.seen.sockets.length, 5000, 'websocket + capabilities');
        assert.strictEqual(srv.seen.caps.SupportsRemoteControl, true);
        assert.ok(srv.seen.caps.SupportedCommands.indexOf('Play') >= 0);
        assert.deepStrictEqual(srv.seen.caps.PlayableMediaTypes, ['Video', 'Audio']);
        for (let i = 0; i < 100; i++) { s = await ask(sock, 'status'); if (s.client.state === 'connected') break; await wait(50); }
        assert.strictEqual(s.client.state, 'connected');
        assert.strictEqual(s.client.sessionId, 'sess-car');
        assert.strictEqual(s.account.userName, 'aurel');
        assert.ok(/Client="BMW iDrive"/.test(srv.seen.auth[0].header));
        assert.strictEqual(srv.seen.sockets[0].deviceId, JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'device.json'))).id);
        // the page closes by itself after the sign-in
        await wait(2300);
        s = await ask(sock, 'status');
        assert.strictEqual(s.page.open, false);
        // the phone casts a film
        srv.send({ MessageType: 'Play', Data: { ItemIds: ['film1'], StartPositionTicks: 6000000000, PlayCommand: 'PlayNow', ControllingUserId: 'u1' } });
        for (let i = 0; i < 100; i++) { s = await ask(sock, 'status'); if (s.play) break; await wait(50); }
        assert.ok(s.play, 'Play arrived');
        assert.strictEqual(s.play.item.title, 'Interstellar (2014)');
        assert.strictEqual(s.play.start, 600);
        assert.strictEqual(s.play.item.video.codec, 'hevc');
        assert.strictEqual(s.play.item.audio.codec, 'eac3');
        srv.send({ MessageType: 'Playstate', Data: { Command: 'Seek', SeekPositionTicks: 12000000000 } });
        for (let i = 0; i < 100; i++) { s = await ask(sock, 'status'); if (s.playstate) break; await wait(50); }
        assert.strictEqual(s.playstate.command, 'Seek');
        assert.strictEqual(s.playstate.seek, 1200);
        // a restart keeps the sign-in: the service connects again by itself
        svc.stop();
        server.close();
        await wait(300);
        const again = await makeService(tmp, await freePort());
        for (let i = 0; i < 100; i++) { s = await ask(again.sock, 'status'); if (s.client.state === 'connected') break; await wait(50); }
        assert.strictEqual(s.client.state, 'connected');
        // sign out: the server is told, the account file goes
        s = await ask(again.sock, 'signout');
        assert.strictEqual(s.account, null);
        await until(() => srv.seen.logout === 1, 3000, 'logout');
        assert.ok(!fs.existsSync(accFile));
        again.svc.stop(); again.server.close();
    } finally { srv.close(); try { svc.stop(); server.close(); } catch (e) { /* stopped */ } }
});


test('device profile: H.264 up to 1080p, AAC / AC-3, MPEG-TS over HTTP, text subtitles apart', () => {
    const p = playback.deviceProfile(8000000);
    assert.deepStrictEqual(p.DirectPlayProfiles, []);
    const v = p.TranscodingProfiles.filter((t) => t.Type === 'Video')[0];
    assert.strictEqual(v.Container, 'ts'); assert.strictEqual(v.VideoCodec, 'h264'); assert.strictEqual(v.AudioCodec, 'aac,ac3'); assert.strictEqual(v.Protocol, 'http');
    const h = p.CodecProfiles.filter((c) => c.Codec === 'h264')[0].Conditions;
    const cond = (prop) => h.filter((c) => c.Property === prop)[0].Value;
    assert.strictEqual(cond('Width'), '1920'); assert.strictEqual(cond('Height'), '1080'); assert.strictEqual(cond('VideoBitDepth'), '8');
    // text subtitles apart (the app draws them), picture ones burned in
    assert.ok(p.SubtitleProfiles.filter((x) => ['srt', 'subrip', 'ass', 'vtt'].indexOf(x.Format) >= 0).every((x) => x.Method === 'External'));
    assert.ok(p.SubtitleProfiles.filter((x) => ['pgssub', 'dvdsub'].indexOf(x.Format) >= 0).every((x) => x.Method === 'Encode'));
    assert.strictEqual(playback.setParam('/v/s.ts?a=1&StartTimeTicks=0&b=2', 'StartTimeTicks', 50), '/v/s.ts?a=1&b=2&StartTimeTicks=50');
    assert.strictEqual(playback.setParam('/v/s.ts', 'x', 'a b'), '/v/s.ts?x=a%20b');
    // the log's view of a stream address: what is asked, never the token
    const d = playback.describeUrl('https://media.example.com/videos/9/stream.ts?MediaSourceId=m&api_key=SECRET&VideoCodec=h264&AudioCodec=aac,ac3&TranscodeReasons=VideoCodecNotSupported');
    assert.strictEqual(d, '/videos/9/stream.ts VideoCodec=h264 AudioCodec=aac,ac3 TranscodeReasons=VideoCodecNotSupported');
});

/** a service already signed in to srv (account.json written before it starts) */
async function signedIn(srv, extra) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emby-pb-'));
    fs.mkdirSync(path.join(tmp, 'state'));
    fs.writeFileSync(path.join(tmp, 'state', 'account.json'), JSON.stringify({ server: srv.url, userId: 'u1', token: srv.TOKEN, userName: 'aurel', serverName: 'Home Emby' }));
    const svc = await makeService(tmp, await freePort(), typeof extra === 'function' ? extra(tmp) : extra);
    let s;
    for (let i = 0; i < 100; i++) { s = await ask(svc.sock, 'status'); if (s.client.state === 'connected') break; await wait(50); }
    assert.strictEqual(s.client.state, 'connected');
    return Object.assign(svc, { tmp });
}
async function statusUntil(sock, fn, ms, what) {
    let s = null;
    await until(() => { ask(sock, 'status').then((x) => { s = x; }).catch(() => {}); return s && fn(s) ? s : null; }, ms || 5000, what);
    return s;
}

test('playback: cast, pause, seek, volume, stop; reported to the server', async () => {
    const srv = await fakeEmby({ seconds: 60 });
    const plog = path.join(os.tmpdir(), 'emby-fake-player-' + process.pid + '.log');
    try { fs.unlinkSync(plog); } catch (e) { /* none */ }
    const svc = await signedIn(srv, { playerEnv: { FAKE_PLAYER_LOG: plog, FAKE_PLAYER_SECONDS: '100' } });
    const reports = (p) => srv.seen.reports.filter((r) => r.path === p);
    try {
        srv.send({ MessageType: 'Play', Data: { ItemIds: ['film2'], StartPositionTicks: 100000000, PlayCommand: 'PlayNow' } });
        await until(() => reports('/Sessions/Playing').length, 5000, 'Sessions/Playing');
        // PlaybackInfo: our profile, from 10 s
        const pi = srv.seen.pbinfo[0];
        assert.strictEqual(pi.query.StartTimeTicks, '100000000');
        assert.strictEqual(pi.query.UserId, 'u1');
        assert.strictEqual(pi.body.DeviceProfile.Name, 'BMW iDrive');
        // the stream from 10 s, with our token
        assert.strictEqual(srv.seen.streams[0].query.StartTimeTicks, '100000000');
        assert.strictEqual(srv.seen.streams[0].token, srv.TOKEN);
        const started = reports('/Sessions/Playing')[0].body;
        assert.strictEqual(started.ItemId, 'film2');
        assert.strictEqual(started.PlaySessionId, 'ps-1');
        assert.strictEqual(started.MediaSourceId, 'ms2');
        assert.strictEqual(started.PlayMethod, 'Transcode');
        assert.strictEqual(started.CanSeek, true);
        let s = await statusUntil(svc.sock, (x) => x.playback && x.playback.state === 'playing' && x.player.running, 5000, 'playing');
        assert.strictEqual(s.playback.phase, null);
        assert.strictEqual(s.playback.item.title, 'Sample');
        assert.ok(s.playback.pos >= 10, 'position from the start: ' + s.playback.pos);
        assert.strictEqual(s.playback.playMethod, 'Transcode');
        // the stream's bytes reached the player
        await until(() => fs.existsSync(plog) && /"bytes":37600/.test(fs.readFileSync(plog, 'utf8')), 5000, 'the player got the stream');
        // pause from the phone: the player stops, the server is told
        srv.send({ MessageType: 'Playstate', Data: { Command: 'Pause' } });
        await until(() => reports('/Sessions/Playing/Progress').some((r) => r.body.EventName === 'pause' && r.body.IsPaused), 5000, 'pause reported');
        await until(() => /"ctl":"pause"/.test(fs.readFileSync(plog, 'utf8')), 3000, 'pause to the player');
        s = await statusUntil(svc.sock, (x) => x.playback.paused && x.playback.state === 'paused', 3000, 'paused');
        srv.send({ MessageType: 'Playstate', Data: { Command: 'Unpause' } });
        await until(() => reports('/Sessions/Playing/Progress').some((r) => r.body.EventName === 'unpause'), 5000, 'unpause reported');
        // volume
        srv.send({ MessageType: 'GeneralCommand', Data: { Name: 'SetVolume', Arguments: { Volume: '40' } } });
        await until(() => /"ctl":"volume 0.4"/.test(fs.readFileSync(plog, 'utf8')), 3000, 'volume to the player');
        await until(() => reports('/Sessions/Playing/Progress').some((r) => r.body.EventName === 'volumechange' && r.body.VolumeLevel === 40), 3000, 'volume reported');
        // seek to 30 s: the old transcode stopped, a new stream from 30 s, a new player
        const firstPid = (await ask(svc.sock, 'status')).player.pid;
        srv.send({ MessageType: 'Playstate', Data: { Command: 'Seek', SeekPositionTicks: 300000000 } });
        await until(() => srv.seen.streams.length === 2, 5000, 'the stream again');
        assert.strictEqual(srv.seen.streams[1].query.StartTimeTicks, '300000000');
        assert.strictEqual(srv.seen.encStops[0].PlaySessionId, 'ps-1');
        s = await statusUntil(svc.sock, (x) => x.player.running && x.player.pid !== firstPid && x.playback.pos >= 30, 5000, 'the new player');
        // stop from the phone: reported, the transcode stopped, the player and its frame file gone
        srv.send({ MessageType: 'Playstate', Data: { Command: 'Stop' } });
        await until(() => reports('/Sessions/Playing/Stopped').length, 5000, 'Stopped reported');
        const stopped = reports('/Sessions/Playing/Stopped')[0].body;
        assert.strictEqual(stopped.PlaySessionId, 'ps-2');
        assert.ok(stopped.PositionTicks >= 300000000, String(stopped.PositionTicks));
        await until(() => srv.seen.encStops.some((q) => q.PlaySessionId === 'ps-2'), 3000, 'encoding stopped');
        s = await statusUntil(svc.sock, (x) => x.playback.state === 'idle' && !x.player.running, 5000, 'idle');
        assert.ok(!fs.existsSync(path.join(svc.tmp, 'mgu-video-test')));
    } finally { srv.close(); svc.svc.stop(); svc.server.close(); }
});

test('subtitles: text ones apart (drawn by the app), picture ones burned in; a changed text track needs no new stream', async () => {
    const srv = await fakeEmby({ seconds: 60 });
    const svc = await signedIn(srv, { playerEnv: { FAKE_PLAYER_SECONDS: '100' } });
    try {
        srv.send({ MessageType: 'Play', Data: { ItemIds: ['film2'], PlayCommand: 'PlayNow', SubtitleStreamIndex: 2 } });
        let s = await statusUntil(svc.sock, (x) => x.playback && x.playback.subs && x.playback.subs.count === 2, 5000, 'subtitles loaded');
        assert.strictEqual(s.playback.subs.lang, 'Romanian (SUBRIP)');
        // the profile: text subtitles External, picture ones Encode
        const prof = srv.seen.pbinfo[0].body.DeviceProfile.SubtitleProfiles;
        assert.strictEqual(prof.filter((x) => x.Format === 'subrip')[0].Method, 'External');
        assert.strictEqual(prof.filter((x) => x.Format === 'pgssub')[0].Method, 'Encode');
        assert.strictEqual(srv.seen.pbinfo[0].query.SubtitleStreamIndex, '2');
        // the app's copy: the cues, in ASCII (the kit's fonts)
        const sub = await ask(svc.sock, 'subs');
        assert.strictEqual(sub.key, s.playback.subs.key);
        assert.deepStrictEqual(sub.cues, [{ s: 1, e: 3, t: 'Vreau sa-ti spun' }, { s: 12, e: 14.5, t: 'Adio.' }]);
        s = await statusUntil(svc.sock, (x) => x.playback.posAt > 0, 3000, 'a position with its time');
        // off from the phone: no new stream, no subtitles
        srv.send({ MessageType: 'GeneralCommand', Data: { Name: 'SetSubtitleStreamIndex', Arguments: { Index: '-1' } } });
        s = await statusUntil(svc.sock, (x) => x.playback && !x.playback.subs, 3000, 'subtitles off');
        assert.strictEqual((await ask(svc.sock, 'subs')).key, null);
        assert.strictEqual(srv.seen.streams.length, 1);
        // a picture subtitle: burned in by the server, so a new stream from the position
        srv.send({ MessageType: 'GeneralCommand', Data: { Name: 'SetSubtitleStreamIndex', Arguments: { Index: '3' } } });
        await until(() => srv.seen.streams.length === 2, 5000, 'a new stream for a burned-in subtitle');
        assert.strictEqual(srv.seen.pbinfo[1].query.SubtitleStreamIndex, '3');
    } finally { srv.close(); svc.svc.stop(); svc.server.close(); }
});

test('playback: the server\'s transcoder failing (HTTP 500) says why', async () => {
    const srv = await fakeEmby({ seconds: 60, streamFails: true });
    const svc = await signedIn(srv);
    try {
        srv.send({ MessageType: 'Play', Data: { ItemIds: ['film2'], PlayCommand: 'PlayNow' } });
        const s = await statusUntil(svc.sock, (x) => x.playback && x.playback.state === 'error', 5000, 'the error');
        assert.ok(/HTTP 500 \(Conversion failed!\)/.test(s.playback.error), s.playback.error);
    } finally { srv.close(); svc.svc.stop(); svc.server.close(); }
});

test('cast during a film on the phone: PlayMediaSource plays it, from where it was', async () => {
    const srv = await fakeEmby({ seconds: 600 });
    const svc = await signedIn(srv, { playerEnv: { FAKE_PLAYER_SECONDS: '100' } });
    try {
        // the phone hands over what it plays: a GeneralCommand, its numbers as text (then its volume)
        srv.send({ MessageType: 'GeneralCommand', Data: { Name: 'PlayMediaSource', Arguments: { ItemId: 'film2', MediaSourceId: 'ms2',
            StartPositionTicks: '1234500000', AudioStreamIndex: '1', SubtitleStreamIndex: '2' } } });
        srv.send({ MessageType: 'GeneralCommand', Data: { Name: 'SetVolume', Arguments: { Volume: '60' } } });
        await until(() => srv.seen.reports.some((r) => r.path === '/Sessions/Playing'), 5000, 'Sessions/Playing');
        const pi = srv.seen.pbinfo[0];
        assert.strictEqual(pi.query.StartTimeTicks, '1234500000');
        assert.strictEqual(pi.query.MediaSourceId, 'ms2');
        assert.strictEqual(pi.query.AudioStreamIndex, '1');
        assert.strictEqual(pi.query.SubtitleStreamIndex, '2');
        const s = await statusUntil(svc.sock, (x) => x.playback && x.playback.state === 'playing', 5000, 'playing');
        assert.ok(s.playback.pos >= 123, String(s.playback.pos));
        assert.strictEqual(s.play.item.title, 'Sample');
    } finally { srv.close(); svc.svc.stop(); svc.server.close(); }
});

test('the app\'s controls: play / pause, a seek to a position, stop', async () => {
    const srv = await fakeEmby({ seconds: 600 });
    const svc = await signedIn(srv, { playerEnv: { FAKE_PLAYER_SECONDS: '100' } });
    const reports = (p) => srv.seen.reports.filter((r) => r.path === p);
    try {
        srv.send({ MessageType: 'Play', Data: { ItemIds: ['film2'], PlayCommand: 'PlayNow' } });
        await statusUntil(svc.sock, (x) => x.playback && x.playback.state === 'playing', 5000, 'playing');
        await ask(svc.sock, 'playstate', { command: 'PlayPause' });
        await until(() => reports('/Sessions/Playing/Progress').some((r) => r.body.EventName === 'pause'), 3000, 'paused from the app');
        await ask(svc.sock, 'playstate', { command: 'PlayPause' });
        await until(() => reports('/Sessions/Playing/Progress').some((r) => r.body.EventName === 'unpause'), 3000, 'playing again');
        await ask(svc.sock, 'playstate', { command: 'Seek', seek: 312.5 });
        await until(() => srv.seen.streams.length === 2, 5000, 'a new stream from the position');
        assert.strictEqual(srv.seen.streams[1].query.StartTimeTicks, '3125000000');
        // Stop on the iDrive: parked (paused for the phone, which has no Stop), the player closed, no Stopped
        await statusUntil(svc.sock, (x) => x.playback.state === 'playing' && x.player.running, 5000, 'playing again');
        const pauses = reports('/Sessions/Playing/Progress').filter((r) => r.body.EventName === 'pause').length;
        const encStops = srv.seen.encStops.length;
        await ask(svc.sock, 'playstate', { command: 'Stop' });
        let s = await statusUntil(svc.sock, (x) => x.playback.parked && !x.player.running, 5000, 'parked');
        assert.strictEqual(s.playback.state, 'paused');
        assert.ok(reports('/Sessions/Playing/Progress').filter((r) => r.body.EventName === 'pause' && r.body.IsPaused).length > pauses, 'reported paused');
        assert.strictEqual(reports('/Sessions/Playing/Stopped').length, 0);
        await until(() => srv.seen.encStops.length > encStops, 3000, 'its transcode stopped');
        await wait(1500);
        assert.strictEqual(srv.seen.streams.length, 2, 'the parked player\'s end opened no stream');
        // play on the phone: on from where it was, a new stream
        const at = s.playback.pos;
        srv.send({ MessageType: 'Playstate', Data: { Command: 'PlayPause' } });
        await until(() => srv.seen.streams.length === 3, 5000, 'on again');
        assert.ok(Math.abs(Number(srv.seen.streams[2].query.StartTimeTicks) / 1e7 - at) < 2, srv.seen.streams[2].query.StartTimeTicks + ' vs ' + at);
        s = await statusUntil(svc.sock, (x) => !x.playback.parked && x.playback.state === 'playing', 5000, 'playing after the stop');
        // a Stop from the phone ends it
        srv.send({ MessageType: 'Playstate', Data: { Command: 'Stop' } });
        await until(() => reports('/Sessions/Playing/Stopped').length, 3000, 'stopped from the phone');
    } finally { srv.close(); svc.svc.stop(); svc.server.close(); }
});

test('quality: the setting caps what is asked; the stream running dry goes one step lower, unless that is off', async () => {
    const srv = await fakeEmby({ seconds: 600 });
    const svc = await signedIn(srv, { playerEnv: { FAKE_PLAYER_SECONDS: '100', FAKE_PLAYER_BUFFERING: '0.6-0.9,1.3-1.6' } });
    const rate = (i) => [srv.seen.pbinfo[i].query.MaxStreamingBitrate, String(srv.seen.pbinfo[i].body.MaxStreamingBitrate), String(srv.seen.pbinfo[i].body.DeviceProfile.MaxStreamingBitrate)];
    try {
        // the default: 8 Mbit/s, adaptive; twice dry within a minute: 4 Mbit/s, on from where it was
        srv.send({ MessageType: 'Play', Data: { ItemIds: ['film2'], StartPositionTicks: 100000000, PlayCommand: 'PlayNow' } });
        await until(() => srv.seen.pbinfo.length === 2, 8000, 'a stream at a lower quality');
        assert.deepStrictEqual(rate(0), ['8000000', '8000000', '8000000']);
        assert.deepStrictEqual(rate(1), ['4000000', '4000000', '4000000']);
        assert.ok(Number(srv.seen.pbinfo[1].query.StartTimeTicks) >= 100000000, 'on from where it was');
        let s = await statusUntil(svc.sock, (x) => x.playback.bitrate === 4000000, 3000, 'at 4 Mbit/s');
        assert.strictEqual(s.playback.maxBitrate, 8000000);
        // 30 s at least between two steps: still at 4 though the new stream runs dry too
        await wait(2500);
        assert.strictEqual(srv.seen.pbinfo.length, 2);
        // the setting: at most 2 Mbit/s, fixed: the film goes on at 2 now
        s = await ask(svc.sock, 'prefs', { maxBitrate: 2000000, adaptive: false });
        assert.deepStrictEqual(s.prefs, { maxBitrate: 2000000, adaptive: false });
        await until(() => srv.seen.pbinfo.length === 3, 5000, 'the setting applied');
        assert.deepStrictEqual(rate(2), ['2000000', '2000000', '2000000']);
        // fixed: running dry changes nothing
        await wait(2500);
        assert.strictEqual(srv.seen.pbinfo.length, 3);
        // kept for the next film and the next start of the service
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(svc.tmp, 'state', 'prefs.json'), 'utf8')), { maxBitrate: 2000000, adaptive: false });
        srv.send({ MessageType: 'Play', Data: { ItemIds: ['film2'], PlayCommand: 'PlayNow' } });
        await until(() => srv.seen.pbinfo.length === 4, 5000, 'the next film');
        assert.deepStrictEqual(rate(3), ['2000000', '2000000', '2000000']);
    } finally { srv.close(); svc.svc.stop(); svc.server.close(); }
});

test('cast during a film on the phone (it sends only SetVolume): the film it just stopped is taken over, from its position', async () => {
    const srv = await fakeEmby({ seconds: 600, lastPlayedAgo: 2000, resumeTicks: 1234500000 });
    const svc = await signedIn(srv, { playerEnv: { FAKE_PLAYER_SECONDS: '100' } });
    try {
        srv.send({ MessageType: 'GeneralCommand', Data: { Name: 'SetVolume', Arguments: { Volume: '50' } } });
        await until(() => srv.seen.reports.some((r) => r.path === '/Sessions/Playing'), 6000, 'taken over');
        assert.strictEqual(srv.seen.pbinfo[0].query.StartTimeTicks, '1234500000');
        const s = await statusUntil(svc.sock, (x) => x.playback && x.playback.state === 'playing', 5000, 'playing');
        assert.ok((s.log || []).some((l) => /take over \(SetVolume\): Sample from 123 s/.test(l)), JSON.stringify(s.log));
    } finally { srv.close(); svc.svc.stop(); svc.server.close(); }
});

test('cast while the phone goes on playing: its film taken over where it is, with its tracks, and the phone told to stop', async () => {
    const srv = await fakeEmby({ seconds: 600, phonePlaying: true, lastPlayedAgo: 10 * 60000 });
    const svc = await signedIn(srv, { playerEnv: { FAKE_PLAYER_SECONDS: '100' } });
    try {
        srv.send({ MessageType: 'Playstate', Data: { Command: 'PlayPause' } });
        await until(() => srv.seen.reports.some((r) => r.path === '/Sessions/Playing'), 6000, 'taken over');
        const q = srv.seen.pbinfo[0].query;
        assert.strictEqual(q.StartTimeTicks, '3389270000');
        assert.strictEqual(q.MediaSourceId, 'ms2');
        assert.strictEqual(q.AudioStreamIndex, '1');
        assert.strictEqual(q.SubtitleStreamIndex, '2');
        await until(() => srv.seen.phoneStopped === 1, 3000, 'the phone told to stop');
        // the phone, told to stop, sends the Stop on to the car: an echo, ignored
        srv.send({ MessageType: 'Playstate', Data: { Command: 'Stop' } });
        await wait(500);
        assert.strictEqual(srv.seen.reports.filter((r) => r.path === '/Sessions/Playing/Stopped').length, 0, 'the echo did not stop the car');
        await statusUntil(svc.sock, (x) => (x.log || []).some((l) => /Stop ignored/.test(l)), 3000, 'the echo logged');
        const s = await statusUntil(svc.sock, (x) => (x.log || []).some((l) => /take over \(PlayPause\): Sample from 339 s, from iPhone/.test(l)), 3000, 'logged');
        assert.ok(s);
    } finally { srv.close(); svc.svc.stop(); svc.server.close(); }
});

test('no take over: a film stopped long ago, or a Play that came meanwhile', async () => {
    const srv = await fakeEmby({ seconds: 600, lastPlayedAgo: 10 * 60000 });
    const svc = await signedIn(srv);
    try {
        srv.send({ MessageType: 'GeneralCommand', Data: { Name: 'SetVolume', Arguments: { Volume: '50' } } });
        const s = await statusUntil(svc.sock, (x) => (x.log || []).some((l) => /no film stopped in the last 90 s \(last: Sample, 600 s ago\)/.test(l)), 6000, 'nothing taken');
        assert.strictEqual(srv.seen.pbinfo.length, 0);
        assert.strictEqual(s.playback.state, 'idle');
    } finally { srv.close(); svc.svc.stop(); svc.server.close(); }
    const srv2 = await fakeEmby({ seconds: 600, lastPlayedAgo: 1000 });
    const svc2 = await signedIn(srv2, { playerEnv: { FAKE_PLAYER_SECONDS: '100' } });
    try {
        srv2.send({ MessageType: 'GeneralCommand', Data: { Name: 'SetVolume', Arguments: { Volume: '50' } } });
        srv2.send({ MessageType: 'Play', Data: { ItemIds: ['film2'], PlayCommand: 'PlayNow', StartPositionTicks: 300000000 } });
        await until(() => srv2.seen.pbinfo.length === 1, 5000, 'the Play');
        await wait(2500);
        assert.strictEqual(srv2.seen.pbinfo.length, 1, 'only the Play\'s stream');
        assert.strictEqual(srv2.seen.pbinfo[0].query.StartTimeTicks, '300000000');
    } finally { srv2.close(); svc2.svc.stop(); svc2.server.close(); }
});

test('playback: the end of a film plays the next in the queue, then stops', async () => {
    const srv = await fakeEmby({ seconds: 3 });
    const svc = await signedIn(srv);
    const reports = (p) => srv.seen.reports.filter((r) => r.path === p);
    try {
        srv.send({ MessageType: 'Play', Data: { ItemIds: ['film2', 'film2'], PlayCommand: 'PlayNow' } });
        await until(() => reports('/Sessions/Playing').length === 2, 8000, 'the second item started');
        await until(() => reports('/Sessions/Playing/Stopped').length === 2, 8000, 'both stopped');
        assert.strictEqual(reports('/Sessions/Playing')[1].body.PlaylistIndex, 1);
        const s = await statusUntil(svc.sock, (x) => x.playback && x.playback.state === 'idle', 5000, 'idle');
        assert.strictEqual(s.player.running, false);
    } finally { srv.close(); svc.svc.stop(); svc.server.close(); }
});

test('playback: a slow server\'s stream shows as waiting for it, then plays', async () => {
    const srv = await fakeEmby({ seconds: 60, streamDelay: 2500 });
    const svc = await signedIn(srv, { playerEnv: { FAKE_PLAYER_SECONDS: '100' }, childEnv: { EMBY_SYSTEM_DNS: '1', EMBY_SERVER_LOG_AFTER_MS: '500' } });
    try {
        srv.send({ MessageType: 'Play', Data: { ItemIds: ['film2'], PlayCommand: 'PlayNow' } });
        let s = await statusUntil(svc.sock, (x) => x.playback && x.playback.phase === 'stream', 5000, 'waiting for the stream');
        assert.strictEqual(s.playback.state, 'loading');
        assert.ok(s.playback.phaseAt > 0);
        // still waiting: the newest transcode log's error lines
        s = await statusUntil(svc.sock, (x) => x.playback && x.playback.serverSays, 3000, 'the server\'s transcoder');
        assert.strictEqual(s.playback.serverSays, '[hevc] Error parsing NAL\nConversion failed!');
        s = await statusUntil(svc.sock, (x) => x.playback && x.playback.state === 'playing', 8000, 'then playing');
        assert.strictEqual(s.playback.phase, null);
    } finally { srv.close(); svc.svc.stop(); svc.server.close(); }
});

test('playback with emby-player itself (MPEG-TS -> H.264 timed, AAC -> WAV)', async () => {
    if (!fs.existsSync(PLAYER)) return 'skipped (native/emby-player not built: sh native/emby-player/build.sh)';
    if (!fs.existsSync('/lib/ld-linux-x86-64.so.2')) return 'skipped (no /lib/ld-linux-x86-64.so.2, the unit\'s loader path, on this PC)';
    const srv = await fakeEmby({ seconds: 3, media: fs.readFileSync(path.join(FIXTURES, 'emby_sample.ts')) });
    let wav;
    const svc = await signedIn(srv, (tmp) => {
        wav = path.join(tmp, 'out.wav');
        return { playerBin: PLAYER, playerEnv: { MGU_VIDEO_OFF: '1', MGU_AUDIO: 'wav:' + wav, LD_LIBRARY_PATH: path.join(path.dirname(PLAYER), 'stub') } };
    });
    const reports = (p) => srv.seen.reports.filter((r) => r.path === p);
    try {
        srv.send({ MessageType: 'Play', Data: { ItemIds: ['film2'], PlayCommand: 'PlayNow' } });
        let s = await statusUntil(svc.sock, (x) => x.player && x.player.open && x.player.audio, 5000, 'the player opened the stream');
        assert.deepStrictEqual(s.player.open.video, { codec: 'h264', w: 192, h: 108 });
        assert.strictEqual(s.player.open.audio.codec, 'aac');
        assert.strictEqual(s.player.audio.ok, true);
        await until(() => reports('/Sessions/Playing/Stopped').length, 10000, 'played to the end');
        const stopped = reports('/Sessions/Playing/Stopped')[0].body;
        assert.ok(stopped.PositionTicks >= 25000000, 'played about 3 s: ' + stopped.PositionTicks);
        s = await statusUntil(svc.sock, (x) => x.playback.state === 'idle' && !x.player.running, 5000, 'idle');
        assert.ok(s.player.end && s.player.end.shown >= 40, 'pictures timed: ' + JSON.stringify(s.player.end));
        const head = fs.readFileSync(wav);
        assert.strictEqual(head.toString('ascii', 0, 4), 'RIFF');
        const seconds = head.readUInt32LE(40) / (48000 * 4);
        assert.ok(seconds > 2.5 && seconds < 3.3, 'sound played: ' + seconds + ' s');
    } finally { srv.close(); svc.svc.stop(); svc.server.close(); }
});

test('emby-player: a sound that shows up after the opening is still played', () => {
    if (!fs.existsSync(PLAYER)) return 'skipped (native/emby-player not built)';
    if (!fs.existsSync('/lib/ld-linux-x86-64.so.2')) return 'skipped (no /lib/ld-linux-x86-64.so.2 on this PC)';
    // the sample without its sound's packets in the first 24 KiB (PID 0x101): read with a 16 KiB probe, the sound
    // stream is there with no parameters yet, as Emby's DTS -> AAC transcode was in the car (0.2.2: "audio": null)
    const ts = fs.readFileSync(path.join(FIXTURES, 'emby_sample.ts'));
    const out = [];
    for (let i = 0; i + 188 <= ts.length; i += 188) {
        const pid = ((ts[i + 1] & 0x1f) << 8) | ts[i + 2];
        if (i < 24 * 1024 && pid === 0x101) continue;
        out.push(ts.slice(i, i + 188));
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emby-late-'));
    const r = require('child_process').spawnSync(PLAYER, [], { input: Buffer.concat(out), encoding: 'utf8', timeout: 20000,
        env: { MGU_VIDEO_OFF: '1', MGU_AUDIO: 'wav:' + path.join(tmp, 'a.wav'), MGU_PROBE_KB: '16', LD_LIBRARY_PATH: path.join(path.dirname(PLAYER), 'stub') } });
    const evs = r.stdout.split('\n').filter((l) => l.indexOf('MGU ') === 0).map((l) => JSON.parse(l.slice(4)));
    assert.strictEqual(evs.filter((e) => e.ev === 'open')[0].audio, null, 'no sound at the opening');
    assert.ok(/the sound came later/.test(r.stderr), r.stderr);
    const audio = evs.filter((e) => e.ev === 'audio')[0];
    assert.ok(audio && audio.ok, JSON.stringify(evs));
    const end = evs.filter((e) => e.ev === 'end')[0];
    assert.ok(end && end.aplayed > 50, 'sound played: ' + JSON.stringify(end));
});

test('the cast settings again every few minutes: the session stays in the cast menu', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emby-ref-'));
    const srv = await fakeEmby();
    const nx = createNet({ systemDns: true, leasePath: (() => { const l = path.join(tmp, 'l.json'); fs.writeFileSync(l, '{"ip":"1.2.3.4"}'); return l; })() });
    const cl = emby.createClient({ nx, device: { id: 'd1', name: 'BMW iDrive' }, version: '0.2.4', refreshMs: 300 });
    try {
        const acc = await cl.signIn(srv.url, 'aurel', 'secret');
        cl.run(acc);
        await until(() => (srv.seen.capsCount || 0) >= 3, 5000, 'capabilities posted again');
        assert.strictEqual(cl.status().state, 'connected');
        assert.ok(cl.status().announcedAt > 0);
        cl.stop();
        const n = srv.seen.capsCount;
        await wait(700);
        assert.strictEqual(srv.seen.capsCount, n, 'none after stop');
    } finally { srv.close(); }
});

test('a revoked token: signed out, with the reason', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emby-rev-'));
    const srv = await fakeEmby();
    const nx = createNet({ systemDns: true, leasePath: (() => { const l = path.join(tmp, 'l.json'); fs.writeFileSync(l, '{"ip":"1.2.3.4"}'); return l; })() });
    const cl = emby.createClient({ nx, device: { id: 'd1', name: 'BMW iDrive' }, version: '0.1.0' });
    try {
        const acc = await cl.signIn(srv.url, 'aurel', 'secret');
        srv.set('revoked', true);
        let why = null;
        cl.on('signed-out', (w) => { why = w; });
        cl.run(acc);
        await until(() => why, 5000, 'signed-out');
        assert.ok(/sign in again/.test(why));
        assert.strictEqual(cl.status().state, 'signed-out');
    } finally { srv.close(); }
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try { const r = await t.fn(); console.log('ok   ' + t.name + (typeof r === 'string' ? ' (' + r + ')' : '')); }
        catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
    }
    console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
