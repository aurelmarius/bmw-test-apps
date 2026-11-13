'use strict';
/**
 * client.js - the Music Assistant client, a child of service.js running as the tool's internet uid (component.json
 * "uids": mgu-uplink routes it, never root). It keeps no file: the account comes from the parent over IPC.
 *
 *   parent -> { op: 'run', account } | { op: 'signin', id, server, user, password, token } | { op: 'signout' }
 *             | { op: 'req', id, what, args } | { op: 'stop' }
 *   child  -> { ev: 'ready', uid } | { ev: 'status', status } | { ev: 'signin', id, ok, account | error }
 *             | { ev: 'signed-out', why } | { ev: 'res', id, ok, data | error } | { ev: 'art', png (base64) | null, ver }
 *             | { ev: 'log', line }
 *
 * The sound goes to the parent on fd 4, in ma-player's frames (u8 type, u32 BE length, payload; native/ma-player):
 * the parent hands them to the player's stdin.
 */
const net = require('net');
const { createNet } = require('./netx');
const { createMa } = require('./ma');

const send = (m) => { try { if (process.connected) process.send(m); } catch (e) { /* the parent is gone */ } };
const log = (line) => send({ ev: 'log', line });

const nx = createNet({ leasePath: process.env.MUSIC_LEASE || undefined, systemDns: process.env.MUSIC_SYSTEM_DNS === '1' });
const device = { id: process.env.MUSIC_DEVICE_ID || 'aurelm-music-unknown', name: process.env.MUSIC_DEVICE_NAME || 'BMW iDrive' };

/* ---------- the sound to the parent (fd 4) ---------- */
let pipe = null, piped = 0;
try { pipe = new net.Socket({ fd: 4, readable: false, writable: true }); pipe.on('error', (e) => log('sound pipe: ' + e.message)); }
catch (e) { log('no sound pipe: ' + e.message); }
function frame(type, payload) {
    const p = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ''), 'utf8');
    const h = Buffer.alloc(5);
    h[0] = type.charCodeAt(0); h.writeUInt32BE(p.length, 1);
    if (!pipe) return;
    pipe.write(h); if (p.length) pipe.write(p);
    piped += p.length;
}
const sink = {
    format(f) { frame('F', f.codec + ' ' + f.rate + ' ' + f.channels + ' ' + f.bits); },
    audio(buf) { frame('A', buf); },
    clear() { frame('C', ''); },
    volume(v) { frame('V', String(Math.max(0, Math.min(1, v)).toFixed(3))); },
};

const ma = createMa({ nx, log, device, sink, onArt: (png, ver) => send({ ev: 'art', png: png ? png.toString('base64') : null, ver }) });
ma.on('status', (s) => send({ ev: 'status', status: Object.assign(s, { piped }) }));
ma.on('signed-out', (why) => { ma.stop(); send({ ev: 'signed-out', why }); });

const REQ = {
    home: () => ma.home(),
    row: (a) => ma.row(a.provider, a.itemId),
    library: (a) => ma.library(a.kind, a.offset, a.limit),
    search: (a) => ma.search(a.q),
    open: (a) => ma.open(a.uri),
    play: (a) => ma.play(a.uri, a.option, a.startItem).then(() => true),
    control: (a) => ma.control(a.cmd, a.arg).then(() => true),
    queue: () => ma.queue(),
    image: (a) => ma.image(a.key, a.size).then((b) => b.toString('base64')),
};

process.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.op === 'run') ma.run(m.account);
    else if (m.op === 'stop') ma.stop();
    else if (m.op === 'signout') ma.signOut().then(() => send({ ev: 'signed-out', why: 'signed out' }));
    else if (m.op === 'signin') {
        (m.token ? ma.withToken(m.server, m.token) : ma.login(m.server, m.user, m.password))
            .then((account) => send({ ev: 'signin', id: m.id, ok: true, account }))
            .catch((e) => send({ ev: 'signin', id: m.id, ok: false, error: e.code === 'EAUTH' ? 'the server refused the token' : e.message }));
    } else if (m.op === 'req') {
        const fn = REQ[m.what];
        if (!fn) return send({ ev: 'res', id: m.id, ok: false, error: 'no request ' + m.what });
        Promise.resolve().then(() => fn(m.args || {}))
            .then((data) => send({ ev: 'res', id: m.id, ok: true, data }))
            .catch((e) => send({ ev: 'res', id: m.id, ok: false, error: e.message }));
    }
});
process.on('disconnect', () => { ma.stop(); process.exit(0); });
send({ ev: 'ready', uid: process.getuid ? process.getuid() : null });
