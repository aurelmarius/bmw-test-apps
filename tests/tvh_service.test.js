'use strict';
/**
 * The TVH service off the car: a fake Tvheadend (HTTP Digest SHA-256 and MD5 as 4.3 offers them, nonces that
 * expire; serverinfo, the playlist, channel/grid, profile/list, epg now, /stream/channel as a live stream that never
 * ends), the service with its client as a real child process, the sign-in page, the channels, a channel playing
 * through the service to a player (tests/fixtures/fake_player.js; and native/tvh-player itself when it is built),
 * another channel, the profile setting and its ladder down when the stream runs dry, a broken stream opened again,
 * the app's watch, sign-out. Runs on Node 8.9.4 too.
 *
 *   node tests/tvh_service.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const qs = require('querystring');

const DIR = path.join(__dirname, '..', 'native', 'aurelm-tvh');
const tvhm = require(path.join(DIR, 'tvh'));
const playback = require(path.join(DIR, 'playback'));
const nft = require(path.join(DIR, 'nft'));
const FIXTURES = path.join(__dirname, 'fixtures');
const PLAYER = path.join(__dirname, '..', 'native', 'tvh-player', 'build', 'tvh-player');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
    const end = Date.now() + (ms || 5000);
    for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out: ' + (what || 'condition')); await wait(30); }
}

const CH = [
    { uuid: 'a'.repeat(32), name: 'PRO TV HD', number: 1, enabled: true, icon_public_url: 'imagecache/1' },
    { uuid: 'b'.repeat(32), name: 'Știrile Pro TV', number: 2, enabled: true },
    { uuid: 'c'.repeat(32), name: 'Hidden', number: 3, enabled: false },
    { uuid: 'd'.repeat(32), name: 'Radio ZU', number: 0, enabled: true },
];

/** a fake Tvheadend 4.3: Digest (SHA-256 and MD5 offered; nonces expire after `nonceMs`), anonymous API paths */
function fakeTvh(opts) {
    const o = opts || {};
    const seen = { calls: [], streams: [], authOk: 0, authBad: 0, schemes: [], open: [] };
    const nonces = {};
    const REALM = 'tvheadend';
    const H = (alg, s) => crypto.createHash(alg === 'SHA-256' ? 'sha256' : 'md5').update(s).digest('hex');
    function newNonce() { const n = crypto.randomBytes(12).toString('hex'); nonces[n] = Date.now(); return n; }
    function challenge(res) {
        const n = newNonce(), op = 'op-' + crypto.randomBytes(4).toString('hex');
        const hs = o.basic ? ['Basic realm="' + REALM + '"']
            : ['Digest realm="' + REALM + '", qop="auth", algorithm=SHA-256, nonce="' + n + '", opaque="' + op + '"',
                'Digest realm="' + REALM + '", qop="auth", algorithm=MD5, nonce="' + n + '", opaque="' + op + '"'];
        res.writeHead(401, { 'WWW-Authenticate': hs, 'Content-Type': 'text/html' });
        res.end('<h1>401 Unauthorized</h1>');
    }
    /** the user this request proves, or null */
    function who(req) {
        const a = req.headers.authorization;
        if (!a) return null;
        if (/^Basic /.test(a)) {
            const [u, p] = Buffer.from(a.slice(6), 'base64').toString().split(':');
            seen.schemes.push('basic');
            return u === 'car' && p === 'pw' ? u : (seen.authBad++, null);
        }
        const f = {};
        a.replace(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g, (m, k, q, v) => { f[k] = q !== undefined ? q : v; });
        const alg = f.algorithm || 'MD5';
        seen.schemes.push('digest-' + alg);
        if (!nonces[f.nonce] || Date.now() - nonces[f.nonce] > (o.nonceMs || 60000)) { seen.authBad++; return null; }
        if (f.uri !== req.url) { seen.authBad++; return null; }
        const ha1 = H(alg, f.username + ':' + REALM + ':' + (f.username === 'car' ? 'pw' : 'nope'));
        const ha2 = H(alg, req.method + ':' + f.uri);
        const want = H(alg, ha1 + ':' + f.nonce + ':' + f.nc + ':' + f.cnonce + ':' + f.qop + ':' + ha2);
        if (f.response !== want || f.username !== 'car') { seen.authBad++; return null; }
        seen.authOk++;
        return f.username;
    }
    const server = http.createServer((req, res) => {
        const p = req.url.split('?')[0], q = qs.parse(req.url.split('?')[1] || '');
        seen.calls.push(p);
        const json = (v) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
        const user = who(req);
        if (p === '/api/serverinfo') return json({ sw_version: '4.3-2735~gfcd987f0b', api_version: 19, name: 'Tvheadend' });
        // anonymous paths: an anonymous request sees nothing
        if (p === '/api/channel/grid') return json({ entries: user ? CH : [], total: user ? CH.length : 0 });
        if (p === '/api/epg/events/grid') return json({ entries: user && q.mode === 'now' ? [
            { channelUuid: CH[0].uuid, title: 'Știrile Pro TV', subtitle: 'Ediția de seară', start: Math.floor(Date.now() / 1000) - 600, stop: Math.floor(Date.now() / 1000) + 1200 },
            { channelUuid: CH[1].uuid, title: 'Vremea', start: 1, stop: Math.floor(Date.now() / 1000) + 3600 }] : [] });
        if (p === '/api/profile/list') return json({ entries: (o.profiles || ['htsp', 'pass', 'matroska', 'mgu-hd', 'mgu-sd', 'mgu-low']).map((n, i) => ({ key: 'k' + i, val: n })) });
        if (!user) return challenge(res);
        if (p === '/playlist/channels') {
            res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
            return res.end('#EXTM3U\n' + CH.filter((c) => c.enabled).map((c) => '#EXTINF:-1 logo="x" tvg-id="' + c.uuid + '" tvg-chno="' + c.number + '",' + c.name +
                '\nhttp://127.0.0.1/stream/channelid/' + c.number + '?ticket=x&profile=pass').join('\n') + '\n');
        }
        const m = /^\/stream\/channel\/([0-9a-f]{32})$/.exec(p);
        if (m) {
            const s = { uuid: m[1], profile: q.profile, at: Date.now(), bytes: 0, closed: false };
            seen.streams.push(s);
            if (o.missing && o.missing.indexOf(q.profile) >= 0) { res.writeHead(404); return res.end(); }
            if (o.busy) { res.writeHead(503); return res.end(); }
            res.writeHead(200, { 'Content-Type': 'video/mp2t' });
            // live: the fixture's bytes at the stream's pace (or o.media), then on and on, until the client leaves
            const media = o.media || fs.readFileSync(path.join(FIXTURES, 'tvh_sample.ts'));
            let i = 0;
            const chunk = o.chunk || 188 * 40;
            const t = setInterval(() => {
                if (o.breakAfter && s.bytes >= o.breakAfter && !s.broke) { s.broke = true; clearInterval(t); res.socket.destroy(); return; }
                const part = media.slice(i % media.length, (i % media.length) + chunk);
                i += part.length;
                s.bytes += part.length;
                res.write(part);
            }, o.everyMs || 20);
            seen.open.push(s);
            const gone = () => { clearInterval(t); s.closed = true; };
            req.on('close', gone); res.on('close', gone);
            return undefined;
        }
        res.writeHead(404); res.end();
    });
    return new Promise((res) => server.listen(0, '127.0.0.1', () => res({
        server, seen, port: server.address().port, url: 'http://127.0.0.1:' + server.address().port,
        set: (k, v) => { o[k] = v; }, close: () => server.close(),
    })));
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
function ask(sock, m) {
    return new Promise((res) => {
        const c = require('net').connect(sock);
        let b = '';
        c.on('connect', () => c.write(JSON.stringify(m) + '\n'));
        c.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) { c.destroy(); res(JSON.parse(b.slice(0, i))); } });
    });
}

// os.networkInterfaces() marks lo internal: the page's interface list in the tests is the loopback
const realIfaces = os.networkInterfaces;
os.networkInterfaces = () => { const all = realIfaces(); (all.lo || []).forEach((a) => { a.internal = false; }); return all; };
const freePort = () => new Promise((res) => { const s = require('net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

/** the service in a scratch folder, its client a real child process (no uid change, no nft, system DNS) */
async function makeService(extra) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvh-svc-'));
    const port = await freePort();
    const { createService } = require(path.join(DIR, 'service'));
    const lease = path.join(tmp, 'lease.json');
    fs.writeFileSync(lease, JSON.stringify({ interface: 'vethuplink', ip: '10.0.0.2', dns: ['127.0.0.1'] }));
    const x = extra || {};
    const playerEnv = Object.assign({ PATH: path.dirname(process.execPath) + ':/usr/bin:/bin' }, x.playerEnv || {});
    const svc = createService(Object.assign({ stateDir: path.join(tmp, 'state'), nft: null, uid: null, pagePort: port, pageIfaces: ['lo'], leasePath: lease, exit: false,
        playerBin: path.join(FIXTURES, 'fake_player.js'), videoPath: path.join(tmp, 'mgu-video-test') }, x,
    { childEnv: Object.assign({ TVH_SYSTEM_DNS: '1', TVH_STREAM_RETRY_MS: '200' }, x.childEnv || {}), playerEnv }));
    const sock = path.join(tmp, 'ctl.sock');
    const server = require('net').createServer();
    svc.serve(server);
    await new Promise((res) => server.listen(sock, res));
    svc.start();
    return { svc, sock, server, tmp, close: () => { svc.stop(0); server.close(); } };
}
async function signedIn(srv, extra) {
    const s = await makeService(extra);
    let st = await ask(s.sock, { cmd: 'signin-open' });
    assert.ok(st.page.open && st.page.url, 'page open');
    const r = await post(st.page.url, { server: srv.url, user: 'car', password: 'pw' });
    assert.ok(/Signed in/.test(r.text), r.text);
    await until(() => s.svc.status().client.state === 'connected' && s.svc.status().channels.count > 0, 8000, 'connected with channels');
    return s;
}

/* ---------------- tests ---------------- */

test('Digest: the RFC 2617 example, and the challenges of an answer', () => {
    const ch = { scheme: 'digest', realm: 'testrealm@host.com', qop: 'auth,auth-int', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', opaque: '5ccc069c403ebaf9f0171e9517f40e41' };
    const h = tvhm.authorization(ch, 'Mufasa', 'Circle Of Life', 'GET', '/dir/index.html', { nc: 0 }, '0a4f113b');
    assert.ok(/response="6629fae49393a05397450978507c4ef1"/.test(h), h);
    assert.ok(/nc=00000001/.test(h) && /qop=auth,/.test(h) && /opaque="5ccc069c403ebaf9f0171e9517f40e41"/.test(h));
    const list = tvhm.challenges(['Server', 'x', 'WWW-Authenticate', 'Digest realm="tvheadend", qop="auth", algorithm=MD5, nonce="n1"',
        'WWW-Authenticate', 'Digest realm="tvheadend", qop="auth", algorithm=SHA-256, nonce="n1", opaque="o"']);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(tvhm.pick(list).algorithm, 'SHA-256');
    assert.strictEqual(tvhm.pick(tvhm.challenges(['WWW-Authenticate', 'Basic realm="tvheadend"'])).scheme, 'basic');
    assert.ok(/^Basic /.test(tvhm.authorization({ scheme: 'basic' }, 'a', 'b', 'GET', '/', {})));
});

test('server address: as typed, else https then http, port 9981 when none', () => {
    assert.deepStrictEqual(tvhm.candidates('tv.example.com'), ['https://tv.example.com:9981', 'http://tv.example.com:9981']);
    assert.deepStrictEqual(tvhm.candidates('tv.example.com:19981/'), ['https://tv.example.com:19981', 'http://tv.example.com:19981']);
    assert.deepStrictEqual(tvhm.candidates(' HTTP://1.2.3.4:9981 '), ['http://1.2.3.4:9981']);
    assert.deepStrictEqual(tvhm.candidates(''), []);
});

test('the playlist: channels when the API lists none', () => {
    const l = tvhm.parsePlaylist('#EXTM3U\n#EXTINF:-1 logo="x" tvg-id="' + 'a'.repeat(32) + '" tvg-chno="7",PRO TV\nhttp://h/stream/channelid/1?profile=pass\n' +
        '#EXTINF:-1,No id\nhttp://h/stream/channel/' + 'b'.repeat(32) + '\n');
    assert.deepStrictEqual(l.map((c) => [c.uuid[0], c.number, c.name]), [['a', 7, 'PRO TV'], ['b', null, 'No id']]);
});

test('the profile ladder: from the setting down, only what the server has', () => {
    assert.deepStrictEqual(playback.ladderFor('mgu-hd', ['pass', 'mgu-hd', 'mgu-low']), ['mgu-hd', 'mgu-low']);
    assert.deepStrictEqual(playback.ladderFor('mgu-sd', ['mgu-hd', 'mgu-sd', 'mgu-low']), ['mgu-sd', 'mgu-low']);
    assert.deepStrictEqual(playback.ladderFor('mgu-hd', null), ['mgu-hd']);
    assert.deepStrictEqual(playback.ladderFor('pass', ['pass']), ['pass']);
    assert.strictEqual(playback.ascii('Știrile Pro TV – Ediția'), 'Stirile Pro TV - Editia');
});

test('firewall rules: the page port on the car Wi-Fi only, with our own comment', () => {
    assert.deepStrictEqual(nft.rulesFor('input', 'wlan_bridge', 8491), ['iifname "wlan_bridge" tcp dport 8491 accept']);
    const chains = nft.parse('table ip filter {\n chain input {\n type filter hook input priority 0;\n iifname "x" tcp dport 8490 accept comment "aurelm-emby" # handle 6\n iifname "x" tcp dport 8491 accept comment "aurelm-tvh" # handle 7\n }\n}\n');
    assert.deepStrictEqual(chains[0].ours, ['7'], 'Emby\'s rule is not ours');
});

test('client: signs in with Digest (SHA-256), the user\'s channels, profiles, what is on now; a wrong password is refused', async () => {
    const srv = await fakeTvh();
    const { createNet } = require(path.join(DIR, 'netx'));
    const nx = createNet({ systemDns: true, leasePath: (() => { const l = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tvh-')), 'l.json'); fs.writeFileSync(l, '{"ip":"1.2.3.4"}'); return l; })() });
    try {
        const t = tvhm.createTvh({ nx });
        let err = null;
        try { await t.signIn(srv.url, 'car', 'wrong'); } catch (e) { err = e; }
        assert.ok(err && /wrong user name or password/.test(err.message), String(err));
        const acc = await t.signIn(srv.url.replace('http://', ''), 'car', 'pw');
        assert.strictEqual(acc.server, srv.url, 'https failed, http taken');
        assert.strictEqual(acc.serverVersion, '4.3-2735~gfcd987f0b');
        // a client starting with a saved account: the challenge first, so the anonymous API paths see the user
        const t2 = tvhm.createTvh({ nx });
        t2.use(acc);
        const ch = await t2.channels();
        assert.deepStrictEqual(ch.map((c) => c.number), [1, 2, null], 'enabled ones, by number, 0 as none');
        assert.ok(srv.seen.schemes.indexOf('digest-SHA-256') >= 0 && srv.seen.schemes.indexOf('digest-MD5') < 0, srv.seen.schemes.join());
        assert.deepStrictEqual((await t2.profiles()).filter((p) => /^mgu-/.test(p)), ['mgu-hd', 'mgu-sd', 'mgu-low']);
        const now = await t2.epgNow();
        assert.strictEqual(now[CH[0].uuid].title, 'Știrile Pro TV');
    } finally { srv.close(); }
});

test('client: an expired nonce is answered with the new challenge; Basic when that is all the server offers', async () => {
    const srv = await fakeTvh({ nonceMs: 150 });
    const { createNet } = require(path.join(DIR, 'netx'));
    const nx = createNet({ systemDns: true });
    try {
        const t = tvhm.createTvh({ nx });
        t.use({ server: srv.url, user: 'car', password: 'pw' });
        assert.strictEqual((await t.channels()).length, 3);
        await wait(250);
        assert.strictEqual((await t.channels()).length, 3, 'again after the nonce expired');
        srv.set('basic', true);
        const b = tvhm.createTvh({ nx });
        b.use({ server: srv.url, user: 'car', password: 'pw' });
        assert.strictEqual((await b.channels()).length, 3);
        assert.ok(srv.seen.schemes.indexOf('basic') >= 0);
    } finally { srv.close(); }
});

test('service: sign-in page, channels with what is on now, a channel playing, another one, stop', async () => {
    const srv = await fakeTvh();
    const s = await signedIn(srv);
    try {
        const st0 = s.svc.status();
        assert.strictEqual(st0.account.user, 'car');
        assert.ok(!('password' in st0.account), 'no password in the status');
        const acc = JSON.parse(fs.readFileSync(path.join(s.tmp, 'state', 'account.json'), 'utf8'));
        assert.strictEqual(acc.password, 'pw');
        assert.strictEqual(fs.statSync(path.join(s.tmp, 'state', 'account.json')).mode & 0o777, 0o600);
        const list = await ask(s.sock, { cmd: 'channels' });
        assert.deepStrictEqual(list.channels.map((c) => c.name), ['PRO TV HD', 'Stirile Pro TV', 'Radio ZU'], 'ASCII names');
        assert.strictEqual(list.epg[CH[0].uuid].title, 'Stirile Pro TV');
        await ask(s.sock, { cmd: 'play', uuid: CH[0].uuid });
        await until(() => { const p = s.svc.status().playback; return p && p.state === 'playing'; }, 8000, 'playing');
        let st = s.svc.status();
        assert.strictEqual(st.playback.channel.name, 'PRO TV HD');
        assert.strictEqual(st.playback.profile, 'mgu-hd');
        assert.strictEqual(srv.seen.streams[0].profile, 'mgu-hd');
        assert.ok(st.player.running);
        await ask(s.sock, { cmd: 'play', uuid: CH[1].uuid });
        await until(() => { const p = s.svc.status().playback; return p && p.state === 'playing' && p.channel.uuid === CH[1].uuid; }, 8000, 'the other channel');
        await until(() => srv.seen.open[0].closed, 3000, 'the first stream closed at the server');
        await ask(s.sock, { cmd: 'stop' });
        await until(() => s.svc.status().playback.state === 'idle' && !s.svc.status().player.running, 5000, 'stopped');
        await until(() => srv.seen.open.every((x) => x.closed), 3000, 'every stream closed');
    } finally { s.close(); srv.close(); }
});

test('service: the profile setting; the ladder down when the stream runs dry, a missing profile passed over', async () => {
    const srv = await fakeTvh({ profiles: ['pass', 'mgu-hd', 'mgu-low'] });
    const s = await signedIn(srv, { playerEnv: { FAKE_PLAYER_BUFFERING: '0.5-1,1.2-1.6' } });
    try {
        await ask(s.sock, { cmd: 'prefs', profile: 'mgu-hd', adaptive: true });
        await ask(s.sock, { cmd: 'play', uuid: CH[0].uuid });
        await until(() => srv.seen.streams.some((x) => x.profile === 'mgu-low'), 8000, 'lowered to mgu-low (mgu-sd is not on the server)');
        await until(() => { const p = s.svc.status().playback; return p && p.profile === 'mgu-low' && p.lowered; }, 5000, 'status lowered');
        assert.ok(srv.seen.streams.every((x) => x.profile !== 'mgu-sd'));
        // fixed at mgu-low by the setting
        await ask(s.sock, { cmd: 'prefs', profile: 'mgu-low', adaptive: false });
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(s.tmp, 'state', 'prefs.json'), 'utf8')).profile, 'mgu-low');
        await until(() => { const p = s.svc.status().playback; return p && p.setting === 'mgu-low' && !p.lowered; }, 5000);
    } finally { s.close(); srv.close(); }
});

test('service: a broken stream is opened again; a missing channel or profile is an error; the app\'s watch stops it', async () => {
    const srv = await fakeTvh({ breakAfter: 188 * 400 });
    const s = await signedIn(srv, { watchMs: 1500 });
    try {
        await ask(s.sock, { cmd: 'play', uuid: CH[0].uuid });
        await until(() => srv.seen.streams.length >= 2, 8000, 'opened again');
        srv.set('breakAfter', 0);
        await until(() => { const p = s.svc.status().playback; return p && p.state === 'playing' && p.reconnects >= 1; }, 8000, 'playing after the break');
        // nobody asks for 1.5 s: stopped
        await until(() => { const p = s.svc.status().playback; return p && p.state === 'idle'; }, 8000, 'stopped by the watch');
        srv.set('missing', ['mgu-hd']);
        await ask(s.sock, { cmd: 'play', uuid: CH[0].uuid });
        const p = await until(() => { const x = s.svc.status().playback; return x && x.state === 'error' && x; }, 5000, 'error');
        assert.ok(/no profile "mgu-hd"/.test(p.error), p.error);
    } finally { s.close(); srv.close(); }
});

test('service: no free tuner (503): tried 3 times, then said', async () => {
    const srv = await fakeTvh({ busy: true });
    const s = await signedIn(srv);
    try {
        await ask(s.sock, { cmd: 'play', uuid: CH[0].uuid });
        const p = await until(() => { const x = s.svc.status().playback; return x && x.state === 'error' && x; }, 8000, 'error');
        assert.ok(/no free tuner/.test(p.error), p.error);
        assert.strictEqual(srv.seen.streams.length, 4);
    } finally { s.close(); srv.close(); }
});

test('service: sign-out forgets the password', async () => {
    const srv = await fakeTvh();
    const s = await signedIn(srv);
    try {
        await ask(s.sock, { cmd: 'signout' });
        assert.ok(!fs.existsSync(path.join(s.tmp, 'state', 'account.json')));
        await until(() => s.svc.status().client.state === 'signed-out', 3000);
        assert.strictEqual((await ask(s.sock, { cmd: 'channels' })).channels.length, 0);
    } finally { s.close(); srv.close(); }
});

test('tvh-player itself: the server\'s kind of stream through the service, picture timed, AAC into a WAV', async () => {
    if (!fs.existsSync(PLAYER)) return 'skipped (native/tvh-player not built: sh native/tvh-player/build.sh)';
    if (!fs.existsSync('/lib/ld-linux-x86-64.so.2')) return 'skipped (no /lib/ld-linux-x86-64.so.2, the unit\'s loader path, on this PC)';
    const srv = await fakeTvh({ everyMs: 40, chunk: 188 * 40 });
    const wav = path.join(os.tmpdir(), 'tvh-' + process.pid + '.wav');
    const s = await signedIn(srv, { playerBin: PLAYER, playerEnv: { MGU_VIDEO_OFF: '1', MGU_AUDIO: 'wav:' + wav, MGU_PROBE_KB: '64', LD_LIBRARY_PATH: path.join(path.dirname(PLAYER), 'stub') } });
    try {
        await ask(s.sock, { cmd: 'play', uuid: CH[0].uuid });
        await until(() => { const p = s.svc.status().player; return p.tick && p.tick.shown > 20 && p.tick.aplayed > 20; }, 15000, 'pictures and sound');
        const st = s.svc.status();
        assert.strictEqual(st.player.open.video.interlaced, false);
        assert.strictEqual(st.playback.interlaced, false);
        assert.strictEqual(st.player.audio.codec, 'aac');
        await ask(s.sock, { cmd: 'stop' });
        await until(() => !s.svc.status().player.running, 5000, 'player ended');
        assert.ok(fs.statSync(wav).size > 44 + 48000, 'sound written');
    } finally { s.close(); srv.close(); try { fs.unlinkSync(wav); } catch (e) { /* none */ } }
});

test('tvh-player itself: an interlaced "pass" stream with MP2 is told', async () => {
    if (!fs.existsSync(PLAYER) || !fs.existsSync('/lib/ld-linux-x86-64.so.2')) return 'skipped (native/tvh-player not built, or no unit loader path)';
    const srv = await fakeTvh({ media: fs.readFileSync(path.join(FIXTURES, 'tvh_interlaced_mp2.ts')), everyMs: 40 });
    const s = await signedIn(srv, { playerBin: PLAYER, playerEnv: { MGU_VIDEO_OFF: '1', MGU_AUDIO: 'null', MGU_PROBE_KB: '64', LD_LIBRARY_PATH: path.join(path.dirname(PLAYER), 'stub') } });
    try {
        await ask(s.sock, { cmd: 'prefs', profile: 'pass', adaptive: true });
        await ask(s.sock, { cmd: 'play', uuid: CH[0].uuid });
        const p = await until(() => { const x = s.svc.status().playback; return x && x.interlaced && x.audioError && x; }, 15000, 'interlaced and sound refused');
        assert.strictEqual(p.profile, 'pass');
        assert.ok(/mp2: only AAC/.test(p.audioError), p.audioError);
    } finally { s.close(); srv.close(); }
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
