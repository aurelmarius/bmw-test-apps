'use strict';
/**
 * service.js - Music Assistant for the app "Music Assistant" (apps/aurelm_music). Root, the unit's /usr/bin/node.
 *
 * Started by the app's first connection to /run/aurelm-music.sock (socket activation), never at boot. Signed in, it
 * stays (the car is a Music Assistant player while the unit is awake: music can be sent to it from the phone's Music
 * Assistant app); signed out, it ends 10 minutes after the last request.
 *
 *   client.js   the Music Assistant client, a child running as the tool's internet uid (mgu-uplink routes it, never
 *               root): the REST API (browsing, the queue) and the Sendspin player (the sound, what plays, its artwork)
 *   ma-player   the sound (player.js): started here as root, it plays as nobody into SmartXbar's CarLife input; the
 *               client's frames come through this process (fd 4 -> its stdin)
 *   sign-in     while the app asks for it (10 minutes): a page on the car Wi-Fi (the phone, on it for wireless CarPlay,
 *               opens it from the QR code), and an accept rule per chain for its port (nft.js); both go when it closes
 *   state       /var/opt/aurelm-music/state: device.json (the car's Sendspin id), account.json (server, user, the
 *               long-lived token; 0600; no password)
 *
 * Control: one JSON object per line; the reply is the status unless said otherwise:
 *   {"cmd":"status"} | {"cmd":"signin-open"} | {"cmd":"signin-close"} | {"cmd":"signout"} | {"cmd":"exit"}
 *   {"cmd":"req","what":"home"|"row"|"library"|"search"|"open"|"play"|"control"|"queue"|"image","args":{...}}
 *       -> { ok, data | error }   (image: data is the PNG in base64, kept here for the next asks)
 *   {"cmd":"art"} -> { ver, png (base64) | null }   (what plays, from Sendspin)
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

const VERSION = '0.1.0';
const PAGE_PORT = 8495;
const PAGE_MINUTES = 10;
const IDLE_MS = 10 * 60 * 1000;
const NET_UID = 13106;   // component.json "uids": the only uid of this tool mgu-uplink routes
const LOG_LINES = 60;
const IMAGES = 400;      // PNGs kept in memory (covers of 160 px are 20-60 KB)

function createService(opts) {
    const o = Object.assign({
        stateDir: process.env.MUSIC_STATE || '/var/opt/aurelm-music/state',
        nft: process.env.MUSIC_NFT === 'off' ? null : (process.env.MUSIC_NFT || 'nft'),
        uid: process.env.MUSIC_UID === '' ? null : Number(process.env.MUSIC_UID || NET_UID),
        pagePort: Number(process.env.MUSIC_PAGE_PORT || PAGE_PORT),
        pageIfaces: process.env.MUSIC_PAGE_IFACES ? process.env.MUSIC_PAGE_IFACES.split(',') : null,
        leasePath: process.env.MUSIC_LEASE || '/run/mgu-uplink/lease.json',
        playerBin: process.env.MUSIC_PLAYER || path.join(__dirname, 'ma-player'),
        playerEnv: {},
        childEnv: {},
        now: Date.now,
    }, opts || {});
    const now = o.now;
    const lines = [];
    function log(s) {
        const t = new Date(now()).toISOString().slice(11, 19);
        lines.push(t + ' ' + s);
        if (lines.length > LOG_LINES) lines.shift();
        if (o.quiet !== true) console.log(s);
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
    if (!device || !device.id) { device = { id: 'aurelm-music-' + crypto.randomBytes(6).toString('hex'), name: 'BMW iDrive' }; writeJson('device.json', device); }
    let account = readJson('account.json');
    if (account && !account.token) account = null;

    const st = { version: VERSION, client: { conn: account ? 'starting' : 'signed-out' }, page: { open: false }, lastSignIn: null, error: null };
    let art = { ver: 0, png: null };
    const images = new Map();   // key|size -> base64

    /* ---------- the player ---------- */
    const player = createPlayer({ bin: o.playerBin, env: o.playerEnv, log });

    /* ---------- the client (internet uid) ---------- */
    let child = null, childStarts = 0;
    const waits = {};
    let seq = 0;
    function startChild() {
        if (child) return;
        childStarts++;
        const env = Object.assign({ PATH: process.env.PATH || '/usr/bin:/bin', MUSIC_DEVICE_ID: device.id, MUSIC_DEVICE_NAME: device.name,
            MUSIC_LEASE: o.leasePath }, o.childEnv);
        // fd 4: the sound, from the client to the player
        const fopts = { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc', 'pipe'] };
        if (o.uid !== null) { fopts.uid = o.uid; fopts.gid = o.uid; }
        let c;
        try { c = fork(path.join(__dirname, 'client.js'), [], fopts); }
        catch (e) { st.error = 'the client did not start: ' + e.message; log(st.error); return; }
        child = c;
        if (c.stdio[4]) player.attach(c.stdio[4]);
        c.on('message', onChild);
        c.on('error', (e) => log('client: ' + e.message));
        c.on('exit', (code, sig) => {
            if (child !== c) return;
            child = null;
            Object.keys(waits).forEach((id) => { waits[id]({ ok: false, error: 'the client ended' }); delete waits[id]; });
            player.stop();
            if (stopping) return;
            log('client ended (' + (sig || code) + ')' + (childStarts < 20 ? ', starting it again in 5 s' : ''));
            st.client = { conn: 'error', error: 'the client ended' };
            if (childStarts < 20) setTimeout(() => { startChild(); if (account) toChild({ op: 'run', account }); }, 5000);
        });
    }
    const toChild = (m) => { if (child && child.connected) child.send(m); };
    function onChild(m) {
        if (!m) return;
        if (m.ev === 'log') log(m.line);
        else if (m.ev === 'status') st.client = m.status;
        else if (m.ev === 'ready') log('client running as uid ' + m.uid);
        else if (m.ev === 'art') art = { ver: m.ver, png: m.png };
        else if ((m.ev === 'res' || m.ev === 'signin') && waits[m.id]) { waits[m.id](m); delete waits[m.id]; }
        else if (m.ev === 'signed-out') {
            if (account) log('signed out: ' + m.why);
            account = null;
            try { fs.unlinkSync(file('account.json')); } catch (e) { /* none */ }
            player.stop();
            st.client = { conn: 'signed-out', error: m.why === 'signed out' ? null : m.why };
        }
    }
    function ask(msg, ms) {
        return new Promise((res) => {
            startChild();
            if (!child) return res({ ok: false, error: st.error || 'the client did not start' });
            const id = String(++seq);
            const t = setTimeout(() => { if (waits[id]) { delete waits[id]; res({ ok: false, error: 'no answer in time' }); } }, ms || 30000);
            waits[id] = (r) => { clearTimeout(t); res(r); };
            toChild(Object.assign({ id }, msg));
        });
    }
    async function req(what, args) {
        if (!account) return { ok: false, error: 'not signed in' };
        if (what === 'image') {
            const k = String(args && args.key) + '|' + (args && args.size);
            if (images.has(k)) { const v = images.get(k); images.delete(k); images.set(k, v); return { ok: true, data: v }; }
            const r = await ask({ op: 'req', what, args }, 25000);
            if (r.ok) { images.set(k, r.data); if (images.size > IMAGES) images.delete(images.keys().next().value); }
            return { ok: r.ok, data: r.data, error: r.error };
        }
        const r = await ask({ op: 'req', what, args }, what === 'play' || what === 'search' ? 40000 : 30000);
        return { ok: r.ok, data: r.data, error: r.error };
    }

    /* ---------- the sign-in page ---------- */
    let pageSrv = null, pageToken = null, pageTimer = null, fwTimer = null;
    function carWifi() {
        const all = os.networkInterfaces();
        const out = [];
        Object.keys(all).forEach((name) => (all[name] || []).forEach((a) => {
            if (a.family !== 'IPv4' || a.internal && !(o.pageIfaces && o.pageIfaces.indexOf(name) >= 0)) return;
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
    function pageUrl() { const ifs = carWifi(); return ifs.length ? 'http://' + ifs[0].ip + ':' + o.pagePort + '/' + pageToken : null; }
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
    function onPage(rq, res) {
        const send = (code, html) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); };
        const p = (rq.url || '').split('?')[0];
        if (!pageToken || p !== '/' + pageToken) return send(404, pagem.closed());
        const action = '/' + pageToken;
        const last = st.lastSignIn || {};
        if (rq.method === 'GET') return send(200, pagem.form({ action, server: account ? account.server : last.server, user: account ? account.userName : last.user, device: device.name }));
        if (rq.method !== 'POST') return send(405, pagem.closed());
        let body = '';
        rq.setEncoding('utf8');
        rq.on('data', (d) => { body += d; if (body.length > 16384) rq.destroy(); });
        rq.on('end', () => {
            const f = qs.parse(body);
            const server = String(f.server || '').trim(), user = String(f.user || '').trim(), token = String(f.token || '').trim();
            if (!token && !user) return send(200, pagem.form({ action, server, user, device: device.name, error: 'Enter the user and password, or a token' }));
            log('sign-in: ' + (token ? 'a token' : user) + ' at ' + server);
            ask({ op: 'signin', server, user, password: String(f.password || ''), token: token || null }, 45000).then((r) => {
                st.lastSignIn = { at: now(), ok: r.ok, server, user, error: r.ok ? null : r.error };
                if (!r.ok) { log('sign-in failed: ' + r.error); return send(200, pagem.form({ action, server, user, device: device.name, error: r.error })); }
                account = r.account;
                writeJson('account.json', account);
                toChild({ op: 'run', account });
                log('signed in: ' + account.userName + ' at ' + account.server + (account.serverVersion ? ' (Music Assistant ' + account.serverVersion + ')' : ''));
                send(200, pagem.done({ serverName: account.serverName, server: account.server, userName: account.userName, device: device.name }));
                setTimeout(() => closePage('signed in'), 2000);
            });
        });
    }

    /* ---------- control ---------- */
    let lastReq = now(), idleTimer = null, stopping = false;
    function bump() { lastReq = now(); }
    function uplink() {
        try { const l = JSON.parse(fs.readFileSync(o.leasePath, 'utf8')); return l && l.ip ? { online: true, iface: l.interface, ip: l.ip } : { online: false }; }
        catch (e) { return { online: false }; }
    }
    function status() {
        return {
            version: VERSION, now: now(), device: device.name, uplink: uplink(), player: player.state(), client: st.client,
            account: account ? { server: account.server, userName: account.userName, serverName: account.serverName, serverVersion: account.serverVersion } : null,
            page: Object.assign({}, st.page, st.page.open ? { url: pageUrl(), left: Math.max(0, Math.round((st.page.until - now()) / 1000)) } : {}),
            lastSignIn: st.lastSignIn ? { at: st.lastSignIn.at, ok: st.lastSignIn.ok, error: st.lastSignIn.error } : null,
            artVer: art.ver, error: st.error, log: lines.slice(-14),
        };
    }
    async function command(m) {
        bump();
        const cmd = m && m.cmd;
        if (cmd === 'req') return req(String(m.what || ''), m.args || {});
        if (cmd === 'art') return { ver: art.ver, png: art.png };
        if (cmd === 'signin-open') await openPage();
        else if (cmd === 'signin-close') closePage('closed from the app');
        else if (cmd === 'signout') {
            if (account) {
                log('signing out ' + account.userName);
                toChild({ op: 'signout' });
                account = null;
                try { fs.unlinkSync(file('account.json')); } catch (e) { /* none */ }
                player.stop();
                st.client = { conn: 'signed-out' };
                images.clear();
            }
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
                        .catch((e) => { try { c.write(JSON.stringify({ version: VERSION, ok: false, error: e.message }) + '\n'); } catch (x) { /* gone */ } });
                }
                if (buf.length > 65536) c.destroy();
            });
        });
    }

    function start() {
        if (o.nft) { try { const n = nftm.remove({ nft: o.nft }); if (n) log('firewall: removed ' + n + ' old rules'); } catch (e) { /* none */ } }
        log('aurelm-music ' + VERSION + ', device "' + device.name + '" ' + device.id);
        startChild();
        if (account) toChild({ op: 'run', account });
        // signed out: ends when unused (the socket starts it again); signed in: stays, a player for Music Assistant
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
    return { start, stop, serve, command, status, carWifi, device: () => device };
}

if (require.main === module) {
    const svc = createService();
    const server = net.createServer();
    svc.serve(server);
    // systemd passes the socket as fd 3 (LISTEN_FDS); outside it, MUSIC_SOCK
    if (process.env.LISTEN_FDS && Number(process.env.LISTEN_FDS) >= 1) server.listen({ fd: 3 });
    else {
        const p = process.env.MUSIC_SOCK || '/run/aurelm-music.sock';
        try { fs.unlinkSync(p); } catch (e) { /* none */ }
        server.listen(p);
    }
    try { const g = require('./sockgroup').apply(process.env.MUSIC_SOCK || '/run/aurelm-music.sock'); console.log('control socket: ' + (g === null ? 'root only' : 'group ' + g)); }
    catch (e) { console.log('control socket mode: ' + e.message); }
    svc.start();
    process.on('SIGTERM', () => svc.stop(0));
    process.on('SIGINT', () => svc.stop(0));
}

module.exports = { createService, VERSION, PAGE_PORT, NET_UID };
