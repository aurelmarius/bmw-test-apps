'use strict';
/**
 * client.js - the Emby client, a child of service.js running as the tool's internet uid (component.json
 * "uids": mgu-uplink routes it, never root). It holds no file of its own: the account comes from the
 * parent over IPC, and everything it learns goes back the same way.
 *
 *   parent -> { op: 'run', account } | { op: 'signin', id, server, user, password } | { op: 'signout' } | { op: 'stop' }
 *             | { op: 'player', id, ev } (the player's events) | { op: 'playback-stop' } | { op: 'playstate', command }
 *   child  -> { ev: 'status', status } | { ev: 'signin', id, ok, account | error } | { ev: 'play' | 'playstate' |
 *             'command', data } | { ev: 'signed-out', why } | { ev: 'log', line }
 *             | { ev: 'playback', status } | { ev: 'player-start', id } | { ev: 'player-ctl', id, line } | { ev: 'player-stop', id }
 *
 * The film's stream goes to the parent on fd 4 (the parent hands it to emby-player's stdin), in frames: a stream
 * id (u32 LE), a length (u32 LE; 0xffffffff: that stream ended), the bytes. A stream left (a seek) can still have
 * bytes in the pipe: the parent drops what is not the current stream's.
 */
const net = require('net');
const { createNet } = require('./netx');
const { createClient } = require('./emby');
const { createPlayback } = require('./playback');

const send = (m) => { try { if (process.connected) process.send(m); } catch (e) { /* the parent is gone */ } };
const log = (line) => send({ ev: 'log', line });

const nx = createNet({ leasePath: process.env.EMBY_LEASE || undefined, systemDns: process.env.EMBY_SYSTEM_DNS === '1' });
const device = { id: process.env.EMBY_DEVICE_ID || 'aurelm-emby-unknown', name: process.env.EMBY_DEVICE_NAME || 'BMW iDrive' };
const c = createClient({ nx, device, version: process.env.EMBY_VERSION || '0.0.0', log });

/* ---------- the stream to the parent (fd 4) ---------- */
let pipe = null;
try { pipe = new net.Socket({ fd: 4, readable: false, writable: true }); pipe.on('error', (e) => log('stream pipe: ' + e.message)); }
catch (e) { log('no stream pipe: ' + e.message); }
function frame(id, len) { const h = Buffer.alloc(8); h.writeUInt32LE(id >>> 0, 0); h.writeUInt32LE(len >>> 0, 4); return h; }
const sink = {
    start(id) { send({ ev: 'player-start', id }); },
    data(id, buf) { if (!pipe) return true; pipe.write(frame(id, buf.length)); return pipe.write(buf); },
    end(id) { if (pipe) pipe.write(frame(id, 0xffffffff)); },
    drain(id, fn) { if (pipe) pipe.once('drain', fn); else fn(); },
    ctl(id, line) { send({ ev: 'player-ctl', id, line }); },
    stop(id) { send({ ev: 'player-stop', id }); },
};

const pb = createPlayback({
    api: (m, p, b) => c.call(m, p, b), apiText: (p) => c.callText(p), nx,
    onSubs: (key, cues) => send({ ev: 'subs', key, cues }),
    sessionId: () => c.status().sessionId, account: () => c.account(), device, log, sink, describe: c.describe,
    bitrate: Number(process.env.EMBY_BITRATE) || undefined, serverLogAfterMs: Number(process.env.EMBY_SERVER_LOG_AFTER_MS) || undefined,
});
let lastSent = '';
function playbackStatus() {
    const s = pb.status();
    const j = JSON.stringify(s);
    if (j !== lastSent) { lastSent = j; send({ ev: 'playback', status: s }); }
}
setInterval(playbackStatus, 1000);

c.on('status', (status) => send({ ev: 'status', status }));
// The phone casting a film it plays sends no Play (see playback.js takeOver): a command while nothing plays here is
// the cue to take that film over, 1.5 s later (the phone's Stopped, sent with it, saved the position by then), unless
// a Play came meanwhile; once a minute at most.
let lastPlay = 0, overAt = 0;
function cue(why) {
    if (pb.status().state !== 'idle' || Date.now() - overAt < 60000) return;
    overAt = Date.now();
    const at = Date.now();
    setTimeout(() => {
        if (lastPlay >= at || pb.status().state !== 'idle') return;
        pb.takeOver(why).then((took) => { if (took) playbackStatus(); else overAt = 0; }).catch((e) => { overAt = 0; log('take over: ' + e.message); });
    }, 1500);
}
c.on('play', (data) => { lastPlay = Date.now(); send({ ev: 'play', data }); pb.play(data); playbackStatus(); });
c.on('playstate', (data) => {
    send({ ev: 'playstate', data });
    if (pb.status().state === 'idle' && /^(PlayPause|Unpause)$/.test(data.command || '')) cue(data.command);
    else { pb.playstate(data); playbackStatus(); }
});
c.on('command', (data) => {
    send({ ev: 'command', data }); pb.command(data); playbackStatus();
    if (data.name === 'SetVolume' || data.name === 'Unmute') cue(data.name);
});
c.on('signed-out', (why) => { pb.stop(); send({ ev: 'signed-out', why }); });

process.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.op === 'run') c.run(m.account);
    else if (m.op === 'stop') { pb.stop(); c.stop(); }
    else if (m.op === 'player') { pb.onPlayer(m.id, m.ev); if (m.ev && m.ev.ev !== 'tick') playbackStatus(); }
    else if (m.op === 'playback-stop') { pb.stop(); playbackStatus(); }
    // Stop from the iDrive parks the film (paused for the phone, the player closed): the phone has no Stop to undo it
    else if (m.op === 'playstate') { if (m.command === 'Stop') pb.park(); else pb.playstate({ command: m.command, seek: m.seek }); playbackStatus(); }
    else if (m.op === 'signout') { pb.stop(); c.signOut().then(() => send({ ev: 'signed-out', why: 'signed out' })); }
    else if (m.op === 'signin') {
        c.signIn(m.server, m.user, m.password)
            .then((account) => send({ ev: 'signin', id: m.id, ok: true, account }))
            .catch((e) => send({ ev: 'signin', id: m.id, ok: false, error: e.message }));
    }
});
// the parent went: so do we
process.on('disconnect', () => { pb.stop(); c.stop(); process.exit(0); });
send({ ev: 'ready', uid: process.getuid ? process.getuid() : null });
