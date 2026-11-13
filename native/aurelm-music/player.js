'use strict';
/**
 * player.js - ma-player (native/ma-player): the sound into SmartXbar's CarLife input. Started by the service as root,
 * it becomes nobody with the groups mgu_alsa and audio itself (the smartx plugin refuses root and the tools' uids).
 *
 * The client's frames (fd 4: u8 type, u32 BE length, payload) are read here whole and handed to the player's stdin:
 * a player started anew (a crash, the first sound) gets the format and the volume again first. It is started by
 * the first sound and ended after IDLE_MS without any, so it holds the sound device only while there is music.
 *
 *   const p = createPlayer({ bin, env, log, onEvent });
 *   p.attach(readable)     the client's fd 4
 *   p.state()              { running, open, error, played, underruns, restarts }
 *   p.stop()
 */
const cp = require('child_process');

const IDLE_MS = 30000;
const GROUPS = 'mgu_alsa,audio';

function createPlayer(o) {
    const log = o.log || (() => {});
    let child = null, fmt = null, vol = null, lastAudio = 0, restarts = 0, lastStart = 0;
    const st = { running: false, open: null, error: null, played: 0, underruns: 0, restarts: 0, ended: null };
    let buf = Buffer.alloc(0);

    function start() {
        if (child) return;
        if (Date.now() - lastStart < 2000) return;   // a player that dies at once is not started in a loop
        lastStart = Date.now();
        const env = Object.assign({ PATH: process.env.PATH || '/usr/bin:/bin' }, o.env || {});
        if (process.getuid && process.getuid() === 0) { env.MGU_RUN_AS = env.MGU_RUN_AS || 'nobody'; env.MGU_GROUPS = env.MGU_GROUPS || GROUPS; }
        let c;
        try { c = cp.spawn(o.bin, [], { env, cwd: '/', stdio: ['pipe', 'pipe', 'pipe'] }); }
        catch (e) { st.error = 'ma-player did not start: ' + e.message; log(st.error); return; }
        child = c;
        st.running = true; st.error = null;
        c.stdin.on('error', () => {});
        let out = '';
        c.stdout.setEncoding('utf8');
        c.stdout.on('data', (d) => {
            out += d;
            let i;
            while ((i = out.indexOf('\n')) >= 0) {
                const line = out.slice(0, i); out = out.slice(i + 1);
                if (line.indexOf('MGU ') !== 0) continue;
                let e = null;
                try { e = JSON.parse(line.slice(4)); } catch (x) { continue; }
                if (e.ev === 'open') { st.open = e; log('ma-player: ' + (e.out === 'alsa' ? e.device : e.out) + ' ' + e.rate + ' Hz ' + e.channels + ' ch'); }
                else if (e.ev === 'error') { st.error = e.error; log('ma-player: ' + e.error); }
                else if (e.ev === 'tick') { st.played = e.played; st.underruns = e.underruns; }
                if (o.onEvent) o.onEvent(e);
            }
        });
        c.stderr.on('data', (d) => log('ma-player stderr: ' + String(d).trim().slice(0, 300)));
        c.on('exit', (code, sig) => {
            if (child !== c) return;
            child = null; st.running = false; st.open = null;
            st.ended = { code, sig, at: Date.now() };
            if (code !== 0 || sig) { restarts++; st.restarts = restarts; log('ma-player ended (' + (sig || code) + ')'); }
        });
        // a new player: what it needs before the sound
        if (fmt) write(fmt);
        if (vol) write(vol);
    }
    function write(f) { if (child && child.stdin.writable) child.stdin.write(f); }
    function onFrame(type, f) {
        // a player started now gets the format (and the volume) from start()
        if (type === 'F') { fmt = f; if (child) write(f); else start(); return; }
        if (type === 'V') { vol = f; write(f); return; }
        if (type === 'A') {
            lastAudio = Date.now();
            if (!child) start();
            write(f);
            return;
        }
        write(f);
    }
    function attach(readable) {
        readable.on('data', (d) => {
            buf = buf.length ? Buffer.concat([buf, d]) : d;
            while (buf.length >= 5) {
                const len = buf.readUInt32BE(1);
                if (len > (1 << 20)) { log('sound pipe: a frame of ' + len + ' bytes: dropped what was queued'); buf = Buffer.alloc(0); return; }
                if (buf.length < 5 + len) break;
                const f = buf.slice(0, 5 + len);
                buf = buf.slice(5 + len);
                onFrame(String.fromCharCode(f[0]), f);
            }
        });
        readable.on('error', (e) => log('sound pipe: ' + e.message));
    }
    const idle = setInterval(() => {
        if (child && lastAudio && Date.now() - lastAudio > IDLE_MS) { log('ma-player: no sound for ' + IDLE_MS / 1000 + ' s, closing the sound device'); stop(); }
    }, 5000);
    if (idle.unref) idle.unref();
    function stop() {
        if (!child) return;
        const c = child;
        try { c.stdin.end(Buffer.from([0x51, 0, 0, 0, 0])); } catch (e) { /* gone */ }   // 'Q'
        setTimeout(() => { try { c.kill('SIGTERM'); } catch (e) { /* gone */ } }, 1500);
        child = null; st.running = false; st.open = null;
    }
    function killSync() { if (child) { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } child = null; } }
    return { attach, stop, killSync, state: () => Object.assign({}, st, { audioAgo: lastAudio ? Date.now() - lastAudio : null }) };
}

module.exports = { createPlayer, IDLE_MS };
