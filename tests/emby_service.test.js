'use strict';
/**
 * The Emby cast service off the car: a fake Emby server (HTTP API + /embywebsocket), the service with its
 * client as a real child process, the sign-in page, a Play / Playstate from the "phone", sign-out. Also
 * the WebSocket frames and TLS against our own CA list. Runs on Node 8.9.4 too.
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
    const seen = { calls: [], caps: null, sockets: [], logout: 0, auth: [] };
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
            if (p === '/Sessions/Capabilities/Full') { seen.caps = JSON.parse(body); return json(204); }
            if (p === '/Sessions') return json(200, [{ Id: 'sess-car', DeviceName: 'BMW iDrive' }]);
            if (p === '/Sessions/Logout') { seen.logout++; return json(204); }
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
function makeService(tmp, port) {
    const { createService } = require(path.join(DIR, 'service'));
    const lease = path.join(tmp, 'lease.json');
    fs.writeFileSync(lease, JSON.stringify({ interface: 'vethuplink', ip: '10.0.0.2', dns: ['127.0.0.1'] }));
    const svc = createService({ stateDir: path.join(tmp, 'state'), nft: null, uid: null, pagePort: port, pageIfaces: ['lo'], leasePath: lease, exit: false,
        childEnv: { EMBY_SYSTEM_DNS: '1' } });
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
        assert.strictEqual(s.version, '0.1.0');
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
