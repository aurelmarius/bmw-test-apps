'use strict';
/**
 * service.js - the Emby cast target for the app "Emby" (apps/aurelm_emby). Root, the unit's /usr/bin/node.
 *
 * Started by the app's first connection to /run/aurelm-emby.sock (socket activation), never at boot. Once
 * signed in it stays, so the head unit is in the Emby app's cast menu until the unit sleeps; signed out it
 * ends 10 minutes after the last request.
 *
 *   client.js     the Emby client, a child running as the tool's internet uid (mgu-uplink routes it, never
 *                 root): the server's WebSocket, the cast commands, what plays (playback.js) and its stream
 *   emby-player   the film (player.js): started here as root for its frame file, it runs as the tool's uid with
 *                 the groups video and mgu_alsa; the stream comes from the client through this process
 *   sign-in page  while the app asks for it (10 minutes): an HTTP page on the car Wi-Fi (the phone, which is
 *                 on it for wireless CarPlay, opens it from the QR code), and one accept rule per chain for
 *                 its port on the car Wi-Fi's interfaces (nft.js); both go when it closes
 *   state         /var/opt/aurelm-emby/state: device.json (the id Emby knows us by), account.json (server,
 *                 user, access token; 0600; no password)
 *
 * Control: one JSON object per line: {"cmd":"status"}, {"cmd":"signin-open"}, {"cmd":"signin-close"},
 * {"cmd":"signout"}, {"cmd":"playstate","command":"PlayPause"|"Stop"}, {"cmd":"exit"}; the reply is the status.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const qs = require('querystring');
const { fork } = require('child_process');
const nftm = require('./nft');
const pagem = require('./page');
const { createPlayer } = require('./player');

const VERSION = '0.2.2';
const PAGE_PORT = 8490;
const PAGE_MINUTES = 10;
const IDLE_MS = 10 * 60 * 1000;
const NET_UID = 13101;   // component.json "uids": the only uid of this tool mgu-uplink routes
const LOG_LINES = 40;

function createService(opts) {
    const o = Object.assign({
        stateDir: process.env.EMBY_STATE || '/var/opt/aurelm-emby/state',
        nft: process.env.EMBY_NFT === 'off' ? null : (process.env.EMBY_NFT || 'nft'),
        uid: process.env.EMBY_UID === '' ? null : Number(process.env.EMBY_UID || NET_UID),
        pagePort: Number(process.env.EMBY_PAGE_PORT || PAGE_PORT),
        pageIfaces: process.env.EMBY_PAGE_IFACES ? process.env.EMBY_PAGE_IFACES.split(',') : null,
        leasePath: process.env.EMBY_LEASE || '/run/mgu-uplink/lease.json',
        now: Date.now,
        childEnv: {},
        playerBin: process.env.EMBY_PLAYER || path.join(__dirname, 'emby-player'),
        playerEnv: {},
        videoPath: undefined,
    }, opts || {});
    const now = o.now;
    const lines = [];
    function log(s) {
        const t = new Date(now()).toISOString().slice(11, 19);
        lines.push(t + ' ' + s);
        if (lines.length > LOG_LINES) lines.shift();
        console.log(s);
    }

    /* ---------- state ---------- */
    try { fs.mkdirSync(o.stateDir, 0o700); } catch (e) { /* there */ }
    try { fs.chmodSync(o.stateDir, 0o700); } catch (e) { /* not ours to change */ }
    const file = (n) => path.join(o.stateDir, n);
    const readJson = (n) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch (e) { return null; } };
    function writeJson(n, v) {
        const tmp = file(n + '.tmp');
        fs.writeFileSync(tmp, JSON.stringify(v, null, 1), { mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, file(n));
    }
    let device = readJson('device.json');
    if (!device || !device.id) { device = { id: 'aurelm-emby-' + crypto.randomBytes(8).toString('hex'), name: 'BMW iDrive' }; writeJson('device.json', device); }
    let account = readJson('account.json');
    if (account && !account.token) account = null;

    const st = {
        version: VERSION, client: { state: account ? 'starting' : 'signed-out' }, page: { open: false },
        play: null, playstate: null, command: null, lastSignIn: null, error: null, playback: null,
    };

    /* ---------- the player (root: its frame file; it runs as the tool's uid) ---------- */
    const player = createPlayer({ bin: o.playerBin, uid: o.uid, env: o.playerEnv, videoPath: o.videoPath, log,
        onEvent: (id, ev) => toChild({ op: 'player', id, ev }) });

    /* ---------- the client (internet uid) ---------- */
    let child = null, childStarts = 0, signinWait = {};
    function startChild() {
        if (child) return;
        childStarts++;
        const env = Object.assign({ PATH: process.env.PATH || '/usr/bin:/bin', EMBY_DEVICE_ID: device.id, EMBY_DEVICE_NAME: device.name,
            EMBY_VERSION: VERSION, EMBY_LEASE: o.leasePath }, o.childEnv);
        // fd 4: the film's stream, from the client to the player (player.js)
        const fopts = { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc', 'pipe'] };
        if (o.uid !== null) { fopts.uid = o.uid; fopts.gid = o.uid; }
        let c;
        try { c = fork(path.join(__dirname, 'client.js'), [], fopts); }
        catch (e) { st.error = 'the Emby client did not start: ' + e.message; log(st.error); return; }
        child = c;
        if (c.stdio[4]) player.attach(c.stdio[4]);
        c.on('message', onChild);
        c.on('error', (e) => log('client: ' + e.message));
        c.on('exit', (code, sig) => {
            if (child !== c) return;
            child = null;
            Object.keys(signinWait).forEach((id) => { signinWait[id]({ ok: false, error: 'the Emby client ended' }); delete signinWait[id]; });
            player.stopAll();
            st.playback = null;
            if (stopping) return;
            log('client ended (' + (sig || code) + ')' + (childStarts < 20 ? ', starting it again in 5 s' : ''));
            st.client = { state: 'error', error: 'the Emby client ended' };
            if (childStarts < 20) setTimeout(() => { startChild(); if (account) toChild({ op: 'run', account }); }, 5000);
        });
    }
    const toChild = (m) => { if (child && child.connected) child.send(m); };
    function onChild(m) {
        if (!m) return;
        if (m.ev === 'log') log(m.line);
        else if (m.ev === 'status') st.client = m.status;
        else if (m.ev === 'ready') log('client running as uid ' + m.uid);
        else if (m.ev === 'play') { st.play = m.data; st.playstate = null; }
        else if (m.ev === 'playstate') st.playstate = m.data;
        else if (m.ev === 'command') st.command = m.data;
        else if (m.ev === 'playback') st.playback = m.status;
        else if (m.ev === 'player-start') player.start(m.id);
        else if (m.ev === 'player-ctl') player.ctl(m.id, m.line);
        else if (m.ev === 'player-stop') player.stop(m.id);
        else if (m.ev === 'signed-out') {
            if (account) log('signed out: ' + m.why);
            account = null;
            try { fs.unlinkSync(file('account.json')); } catch (e) { /* none */ }
            st.client = { state: 'signed-out', error: m.why === 'signed out' ? null : m.why };
        } else if (m.ev === 'signin' && signinWait[m.id]) { signinWait[m.id](m); delete signinWait[m.id]; }
    }
    function signIn(server, user, password) {
        return new Promise((res) => {
            startChild();
            if (!child) return res({ ok: false, error: st.error || 'the Emby client did not start' });
            const id = crypto.randomBytes(6).toString('hex');
            const t = setTimeout(() => { if (signinWait[id]) { delete signinWait[id]; res({ ok: false, error: 'the server did not answer in time' }); } }, 45000);
            signinWait[id] = (r) => { clearTimeout(t); res(r); };
            toChild({ op: 'signin', id, server, user, password });
        });
    }

    /* ---------- the sign-in page ---------- */
    let pageSrv = null, pageToken = null, pageTimer = null, fwTimer = null;
    /** the car Wi-Fi: the interfaces the phone reaches us on (wireless CarPlay), with their IPv4 address */
    function carWifi() {
        const all = os.networkInterfaces();
        const out = [];
        Object.keys(all).forEach((name) => (all[name] || []).forEach((a) => {
            if (a.family !== 'IPv4' || a.internal) return;
            const want = o.pageIfaces ? o.pageIfaces.indexOf(name) >= 0
                : /^(wlan|uap|ap|wl)/.test(name) && name !== 'vethuplink' || /^172\.16\.222\./.test(a.address);
            if (want) out.push({ name, ip: a.address });
        }));
        out.sort((a, b) => (b.name === 'wlan_bridge') - (a.name === 'wlan_bridge'));
        return out;
    }
    function firewall() {
        if (!o.nft) return;
        const names = carWifi().map((i) => i.name);
        try {
            const r = nftm.apply(names, o.pagePort, { nft: o.nft });
            const bad = r.filter((x) => !x.ok);
            st.page.firewall = bad.length ? 'failed: ' + bad[0].chain + ': ' + bad[0].error : r.length + ' chains open for tcp ' + o.pagePort;
            if (r.some((x) => x.changed)) log('firewall: ' + st.page.firewall + ' on ' + (names.join(', ') || 'no interface'));
        } catch (e) { st.page.firewall = 'failed: ' + e.message; }
    }
    function pageUrl() {
        const ifs = carWifi();
        return ifs.length ? 'http://' + ifs[0].ip + ':' + o.pagePort + '/' + pageToken : null;
    }
    function openPage() {
        bump();
        if (pageSrv) { st.page.until = now() + PAGE_MINUTES * 60000; armPageTimer(); return Promise.resolve(); }
        pageToken = crypto.randomBytes(6).toString('hex');
        return new Promise((res) => {
            const srv = http.createServer(onPage);
            srv.on('error', (e) => { st.page = { open: false, error: 'the sign-in page did not open: ' + e.message }; log(st.page.error); pageSrv = null; res(); });
            srv.listen(o.pagePort, '0.0.0.0', () => {
                pageSrv = srv;
                st.page = { open: true, until: now() + PAGE_MINUTES * 60000, url: pageUrl(), error: null };
                firewall();
                fwTimer = setInterval(() => { firewall(); st.page.url = pageUrl(); }, 5000);
                armPageTimer();
                log('sign-in page open: ' + (st.page.url || 'no car Wi-Fi yet (connect the iPhone with wireless CarPlay)'));
                res();
            });
        });
    }
    function armPageTimer() { clearTimeout(pageTimer); pageTimer = setTimeout(() => closePage('10 minutes passed'), Math.max(1000, st.page.until - now())); }
    function closePage(why) {
        clearTimeout(pageTimer); clearInterval(fwTimer);
        if (pageSrv) { try { pageSrv.close(); } catch (e) { /* closed */ } pageSrv = null; log('sign-in page closed' + (why ? ' (' + why + ')' : '')); }
        if (o.nft) { try { nftm.remove({ nft: o.nft }); } catch (e) { /* best effort */ } }
        st.page = { open: false };
        pageToken = null;
    }
    function onPage(req, res) {
        const send = (code, html) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); };
        const p = (req.url || '').split('?')[0];
        if (!pageToken || p !== '/' + pageToken) return send(404, pagem.closed());
        const action = '/' + pageToken;
        if (req.method === 'GET') return send(200, pagem.form({ action, server: account ? account.server : (st.lastSignIn && st.lastSignIn.server), user: account ? account.userName : '', device: device.name }));
        if (req.method !== 'POST') return send(405, pagem.closed());
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (d) => { body += d; if (body.length > 8192) req.destroy(); });
        req.on('end', () => {
            const f = qs.parse(body);
            const server = String(f.server || '').trim(), user = String(f.user || '').trim();
            log('sign-in: ' + user + ' at ' + server);
            signIn(server, user, String(f.password || '')).then((r) => {
                st.lastSignIn = { at: now(), ok: r.ok, server, error: r.ok ? null : r.error };
                if (!r.ok) { log('sign-in failed: ' + r.error); return send(200, pagem.form({ action, server, user, device: device.name, error: r.error })); }
                account = r.account;
                writeJson('account.json', account);
                toChild({ op: 'run', account });
                send(200, pagem.done({ serverName: account.serverName, server: account.server, userName: account.userName, device: device.name }));
                setTimeout(() => closePage('signed in'), 2000);
            });
        });
    }

    /* ---------- control ---------- */
    let lastReq = now(), idleTimer = null, stopping = false;
    function bump() { lastReq = now(); }
    function uplink() {
        try { const l = JSON.parse(fs.readFileSync(o.leasePath, 'utf8')); return l && l.ip ? { online: true, iface: l.interface, ip: l.ip, dns: l.dns || [] } : { online: false }; }
        catch (e) { return { online: false }; }
    }
    function status() {
        return Object.assign({}, st, {
            now: now(), device: device.name, uplink: uplink(), player: player.state(),
            account: account ? { server: account.server, userName: account.userName, serverName: account.serverName, serverVersion: account.serverVersion } : null,
            page: Object.assign({}, st.page, st.page.open ? { url: pageUrl(), left: Math.max(0, Math.round((st.page.until - now()) / 1000)) } : {}),
            log: lines.slice(-14),
        });
    }
    async function command(m) {
        bump();
        const cmd = m && m.cmd;
        if (cmd === 'signin-open') await openPage();
        else if (cmd === 'signin-close') closePage('closed from the app');
        else if (cmd === 'signout') {
            if (account) {
                log('signing out ' + account.userName);
                toChild({ op: 'signout' });
                account = null;
                try { fs.unlinkSync(file('account.json')); } catch (e) { /* none */ }
                st.play = st.playstate = st.command = st.playback = null;
                st.client = { state: 'signed-out' };
            }
        } else if (cmd === 'playstate' && m.command) {
            toChild({ op: 'playstate', command: String(m.command) });
        } else if (cmd === 'exit') { setTimeout(() => stop(0), 100); }
        return status();
    }
    function serve(server) {
        server.on('connection', (c) => {
            let buf = '';
            c.setEncoding('utf8');
            c.on('error', () => {});
            c.on('data', (d) => {
                buf += d;
                let i;
                while ((i = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, i); buf = buf.slice(i + 1);
                    let m = null;
                    try { m = JSON.parse(line); } catch (e) { m = { cmd: 'status' }; }
                    command(m).then((s) => { try { c.write(JSON.stringify(s) + '\n'); } catch (e) { /* gone */ } })
                        .catch((e) => { try { c.write(JSON.stringify({ version: VERSION, error: e.message }) + '\n'); } catch (x) { /* gone */ } });
                }
                if (buf.length > 65536) c.destroy();
            });
        });
    }

    function start() {
        if (o.nft) { const n = nftm.remove({ nft: o.nft }); if (n) log('firewall: removed ' + n + ' old rules'); }
        log('aurelm-emby ' + VERSION + ', device "' + device.name + '" ' + device.id);
        startChild();
        if (account) toChild({ op: 'run', account });
        // signed out: ends when unused (the socket starts it again); signed in: stays, so casting works
        idleTimer = setInterval(() => { if (!account && !pageSrv && now() - lastReq > IDLE_MS) { log('idle: ending'); stop(0); } }, 30000);
    }
    function stop(code) {
        if (stopping) return;
        stopping = true;
        clearInterval(idleTimer);
        closePage();
        player.killSync();
        if (child) { try { child.kill('SIGTERM'); } catch (e) { /* gone */ } }
        if (o.exit !== false) setTimeout(() => process.exit(code || 0), 200);
    }
    return { start, stop, serve, command, status, signIn, carWifi };
}

if (require.main === module) {
    const svc = createService();
    const server = net.createServer();
    svc.serve(server);
    // systemd passes the socket as fd 3 (LISTEN_FDS); outside it, EMBY_SOCK
    if (process.env.LISTEN_FDS && Number(process.env.LISTEN_FDS) >= 1) server.listen({ fd: 3 });
    else {
        const p = process.env.EMBY_SOCK || '/run/aurelm-emby.sock';
        try { fs.unlinkSync(p); } catch (e) { /* none */ }
        server.listen(p);
    }
    try { const g = require('./sockgroup').apply(process.env.EMBY_SOCK || '/run/aurelm-emby.sock'); console.log('control socket: ' + (g === null ? 'root only' : 'group ' + g)); }
    catch (e) { console.log('control socket mode: ' + e.message); }
    svc.start();
    process.on('SIGTERM', () => svc.stop(0));
    process.on('SIGINT', () => svc.stop(0));
}

module.exports = { createService, VERSION, PAGE_PORT, NET_UID };
