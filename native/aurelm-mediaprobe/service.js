'use strict';
/**
 * service.js - the Media Probe service, for the app Media Probe (apps/aurelm_mediaprobe). Root, the unit's /usr/bin/node.
 *
 * What the car offers a music player (the first step of a Music Assistant client): the steering wheel's buttons,
 * which source the HMI takes as playing, CarLife's bridge to BMW's media (metadata, buttons), the BMW MediaPlayer's
 * source for online apps (1046) with files, a growing file, a pipe and http:// streams. See probe.js.
 *
 * Started by the app's first connection to /run/aurelm-mediaprobe.sock (socket activation), never at boot; ends
 * 20 minutes after the app's last request with no test on. Whatever a test changed is undone when it ends (a
 * second press, Stop all, the service's end): routes, button forwarding, CarLife's fields as they were.
 *
 * Its log: /var/opt/aurelm-mediaprobe/state/probe.log (every change of every field watched, every test). "Report"
 * writes report.json beside it and copies both to a USB stick, if one is in.
 *
 * Control: one JSON object per line: {"cmd":"status"}, {"cmd":"run","id":"<test>"}, {"cmd":"stopall"},
 * {"cmd":"report"}, {"cmd":"exit"}; the reply is the status.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { createSomeip } = require('./someip');
const { createProbe, show, usbMounts } = require('./probe');

const VERSION = '0.1.0';
const IDLE_MS = 20 * 60 * 1000;
const LOG_LINES = 400;
const LOG_MAX = 4 * 1024 * 1024;

function createService(opts) {
    const o = Object.assign({
        stateDir: process.env.PROBE_STATE || '/var/opt/aurelm-mediaprobe/state',
        playDir: process.env.PROBE_PLAY || '/var/opt/aurelm-mediaprobe/play',
        mediaDir: process.env.PROBE_MEDIA || path.join(__dirname, 'media'),
        now: Date.now,
        native: undefined, catalog: undefined, generate: undefined, configFor: undefined,
    }, opts || {});
    const now = o.now;
    try { fs.mkdirSync(o.stateDir, 0o700); } catch (e) { /* there */ }
    const logFile = path.join(o.stateDir, 'probe.log');
    const lines = [];
    function log(msg) {
        const d = new Date(now());
        const line = d.toISOString().slice(11, 23) + ' ' + msg;
        lines.push(line);
        if (lines.length > LOG_LINES) lines.shift();
        if (o.quiet !== true) console.log(msg);
        try {
            const st = fs.existsSync(logFile) ? fs.statSync(logFile) : null;
            if (st && st.size > LOG_MAX) fs.renameSync(logFile, logFile + '.1');
            fs.appendFileSync(logFile, d.toISOString() + ' ' + msg + '\n');
        } catch (e) { /* not writable */ }
    }

    const s = createSomeip({ log, dir: path.join(o.stateDir, 'someip'), native: o.native, catalog: o.catalog, generate: o.generate, configFor: o.configFor });
    const probe = createProbe({ s, log, mediaDir: o.mediaDir, playDir: o.playDir, stateDir: o.stateDir, now });
    let lastReq = now(), stopping = false, idleTimer = null, report = null;

    function status() {
        return { version: VERSION, now: now(), tests: probe.testList(), panel: probe.panel(), report, log: lines.slice(-10) };
    }

    function writeReport() {
        const r = { version: VERSION, at: new Date(now()).toISOString(), tests: probe.testList(), panel: probe.panel(), monitors: probe.monitors(), values: {} };
        const vals = probe.vals();
        Object.keys(vals).forEach((k) => { r.values[k] = { value: vals[k].v, at: new Date(vals[k].at).toISOString(), changes: vals[k].n }; });
        const out = path.join(o.stateDir, 'report.json');
        let text;
        try { text = JSON.stringify(r, null, 1); } catch (e) { text = show(r, 1e7); }
        fs.writeFileSync(out, text);
        const copied = [];
        const stamp = new Date(now()).toISOString().replace(/[:T]/g, '-').slice(0, 19);
        (o.usb || usbMounts)().forEach((m) => {
            try {
                fs.writeFileSync(path.join(m, 'mediaprobe-' + stamp + '-report.json'), text);
                fs.writeFileSync(path.join(m, 'mediaprobe-' + stamp + '.log'), fs.readFileSync(logFile));
                copied.push(m);
            } catch (e) { log('report: copy to ' + m + ': ' + e.message); }
        });
        report = { at: now(), file: out, log: logFile, usb: copied };
        log('report: ' + out + (copied.length ? ', copied to ' + copied.join(', ') : ', no USB stick (only on the unit)'));
        return report;
    }

    async function command(m) {
        lastReq = now();
        const cmd = m && m.cmd;
        if (cmd === 'run' && m.id) await probe.run(String(m.id));
        else if (cmd === 'stopall') await probe.stopAll('the app');
        else if (cmd === 'report') writeReport();
        else if (cmd === 'exit') setTimeout(() => stop(0), 100);
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
                    command(m).then((st) => { try { c.write(JSON.stringify(st) + '\n'); } catch (e) { /* gone */ } })
                        .catch((e) => { try { c.write(JSON.stringify({ version: VERSION, error: e.message }) + '\n'); } catch (x) { /* gone */ } });
                }
                if (buf.length > 65536) c.destroy();
            });
        });
    }

    function start() {
        log('aurelm-mediaprobe ' + VERSION + ' starting (log ' + logFile + ')');
        idleTimer = setInterval(() => { if (!probe.active() && now() - lastReq > IDLE_MS) { log('idle: ending'); stop(0); } }, 30000);
        return probe.start().catch((e) => log('start: ' + (e && e.stack || e)));
    }
    function stop(code) {
        if (stopping) return Promise.resolve();
        stopping = true;
        clearInterval(idleTimer);
        // whatever the tests changed, undone (systemd gives 8 s)
        const t = new Promise((res) => setTimeout(res, 6000));
        return Promise.race([probe.stopAll('the service ends').catch((e) => log('stop: ' + e)), t])
            .then(() => s.shutdown().catch(() => {}))
            .then(() => { log('ended'); if (o.exit !== false) setTimeout(() => process.exit(code || 0), 100); });
    }
    return { start, stop, serve, command, status, writeReport, probe, log };
}

if (require.main === module) {
    const svc = createService();
    const server = net.createServer();
    svc.serve(server);
    // systemd passes the socket as fd 3 (LISTEN_FDS); outside it, PROBE_SOCK
    if (process.env.LISTEN_FDS && Number(process.env.LISTEN_FDS) >= 1) server.listen({ fd: 3 });
    else {
        const p = process.env.PROBE_SOCK || '/run/aurelm-mediaprobe.sock';
        try { fs.unlinkSync(p); } catch (e) { /* none */ }
        server.listen(p);
    }
    try { const g = require('./sockgroup').apply(process.env.PROBE_SOCK || '/run/aurelm-mediaprobe.sock'); console.log('control socket: ' + (g === null ? 'root only' : 'group ' + g)); }
    catch (e) { console.log('control socket mode: ' + e.message); }
    svc.start();
    process.on('SIGTERM', () => svc.stop(0));
    process.on('SIGINT', () => svc.stop(0));
    process.on('uncaughtException', (e) => { svc.log('uncaught: ' + (e && e.stack || e)); });
    process.on('unhandledRejection', (e) => { svc.log('unhandled: ' + (e && e.stack || e)); });
}

module.exports = { createService, VERSION };
