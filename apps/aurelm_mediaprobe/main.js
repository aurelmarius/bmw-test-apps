'use strict';
/**
 * Media Probe - what the car offers a music player (the first step of a Music Assistant client).
 *
 * The screen of the Media Probe service (native/aurelm-mediaprobe, a root tool): on the left its tests, on the right
 * what it watches all the time:
 *   Wheel      every press of the steering wheel's buttons (skip left / right, the knurled wheel, the star...)
 *   Forwarded  buttons the BMW MediaPlayer forwarded (after the test "Button forwarding")
 *   Source     the source the HMI takes as playing, and what it shows as playing
 *   CarLife    CarLife's bridge to BMW's media (CarLifeMp) and its manager
 *   1046       the BMW MediaPlayer for apps (OapGenericMedia): state, time
 *
 * "Previous test" / "Next test" choose a test, "Run / undo" runs it (a second press undoes one that stays on),
 * "Stop all" undoes everything, "Report" writes the service's log and a report to a USB stick (when one is in).
 *
 * Talks to the service over /run/aurelm-mediaprobe.sock (a JSON object per line).
 */
const net = require('net');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');

const W = 1600, H = 520;
const SOCK = process.env.PROBE_SOCK || '/run/aurelm-mediaprobe.sock';
const SERVICE_VERSION = '0.1.1';
const GREEN = '#52b54b', AMBER = '#ffb020', RED = '#ef2b2d', BLUE = '#40a0eb';
const older = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };

function ask(cmd, extra, ms) {
    return new Promise((res) => {
        let buf = '', done = false;
        const end = (v) => { if (!done) { done = true; clearTimeout(t); try { c.destroy(); } catch (e) { /* gone */ } res(v); } };
        const c = net.connect(SOCK);
        const t = setTimeout(() => end(null), ms || 5000);
        c.setEncoding('utf8');
        c.on('connect', () => c.write(JSON.stringify(Object.assign({ cmd }, extra || {})) + '\n'));
        c.on('data', (d) => {
            buf += d;
            const i = buf.indexOf('\n');
            if (i < 0) return;
            try { end(JSON.parse(buf.slice(0, i))); } catch (e) { end(null); }
        });
        c.on('error', () => end(null));
    });
}

function clip(cv, s, size, w, font) {
    s = String(s == null ? '' : s);
    if (cv.textWidth(s, size, { font, literal: true }) <= w) return s;
    while (s.length > 1 && cv.textWidth(s + '...', size, { font, literal: true }) > w) s = s.slice(0, -1);
    return s + '...';
}
/** s in lines of at most w pixels, at most n of them */
function wrap(cv, s, size, w, n, font) {
    const out = [];
    let cur = '';
    String(s || '').split(/\s+/).forEach((word) => {
        const next = cur ? cur + ' ' + word : word;
        if (cur && cv.textWidth(next, size, { font, literal: true }) > w) { out.push(cur); cur = word; } else cur = next;
    });
    if (cur) out.push(cur);
    if (out.length > n) { out.length = n; out[n - 1] = clip(cv, out[n - 1] + ' ...', size, w, font); }
    return out.map((l) => clip(cv, l, size, w, font));
}
const ago = (t, now) => { const s = Math.max(0, Math.round((now - t) / 1000)); return s < 60 ? s + ' s' : s < 3600 ? Math.round(s / 60) + ' min' : Math.round(s / 3600) + ' h'; };

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        // st: the service's last answer, kept while it does not answer (busy starting, or restarting after a crash)
        let st = null, sel = 0, busy = null, polling = false, askedExit = false, okAt = 0, misses = 0;

        async function poll() {
            if (polling) return;
            polling = true;
            try {
                const r = await ask('status');
                if (r) { st = r; okAt = Date.now(); misses = 0; } else misses++;
                if (st && st.version && older(st.version, SERVICE_VERSION) && !askedExit) {
                    askedExit = true;
                    log.info('mediaprobe: service ' + st.version + ' running, ' + SERVICE_VERSION + ' installed: asking it to end');
                    await ask('exit');
                    await new Promise((r) => setTimeout(r, 2000));
                    st = await ask('status');
                }
            } finally { polling = false; }
        }
        async function command(cmd, label, extra, ms) {
            busy = label;
            render();
            const r = await ask(cmd, extra, ms || 30000);
            busy = null;
            if (r) st = r;
            log.info('mediaprobe: ' + cmd + (extra && extra.id ? ' ' + extra.id : '') + ' -> ' + (r ? 'ok' : 'no service'));
            return render();
        }
        const tests = () => (st && st.tests) || [];
        ui.onClick('BTN_UP', () => { const n = tests().length; if (n) sel = (sel + n - 1) % n; return render(); });
        ui.onClick('BTN_DOWN', () => { const n = tests().length; if (n) sel = (sel + 1) % n; return render(); });
        ui.onClick('BTN_RUN', () => {
            const t = tests()[sel];
            if (!t || busy) return undefined;
            return command('run', (t.state === 'on' ? 'Undoing: ' : 'Running: ') + t.label, { id: t.id });
        });
        ui.onClick('BTN_STOPALL', () => command('stopall', 'Undoing everything...'));
        ui.onClick('BTN_REPORT', () => command('report', 'Writing the report...'));

        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const silent = st && misses >= 2 ? Math.round((Date.now() - okAt) / 1000) : 0;
            G.frame(cv, t, ['Media Probe'], 0, [busy && { text: busy, color: 'accent' }, silent && { text: 'SERVICE SILENT ' + silent + ' S' }]);
            draw(cv, t);
            return ui.image('MAIN_GFX', cv);
        }

        function draw(cv, t) {
            if (!st) {
                cv.text('The Media Probe service does not answer.', 44, 110, 26, t.text, { font: 'bold', literal: true });
                cv.text('Install "Media Probe service" from the Store, then restart the head unit once.', 44, 150, 20, t.dim, { literal: true });
                return;
            }
            const COL = { ok: GREEN, on: BLUE, running: AMBER, bad: RED, idle: withAlpha('#ffffff', 0.3) };
            const list = tests();
            if (sel >= list.length) sel = 0;
            // the tests: a dot, the name, the result
            const x0 = 24, rowH = 28, y0 = 72;
            list.forEach((x, i) => {
                const y = y0 + i * rowH;
                if (i === sel) cv.fillRect(x0 - 8, y - 20, 1000, rowH, withAlpha(t.accent || '#ffffff', 0.18));
                cv.circle(x0 + 8, y - 7, 7, COL[x.state] || COL.idle);
                cv.text(clip(cv, x.label, 18, 420, 'bold'), x0 + 24, y, 18, t.text, { font: 'bold', literal: true });
                cv.text(clip(cv, x.result || '', 15, 540, 'label'), x0 + 450, y, 15, x.state === 'idle' ? t.dim : t.text, { literal: true });
            });
            // the chosen test's whole result
            const cur = list[sel];
            if (cur) {
                const yd = y0 + list.length * rowH + 8;
                cv.fillRect(x0 - 8, yd - 6, 1000, 1, withAlpha('#ffffff', 0.15));
                wrap(cv, (cur.state === 'on' ? '[on - Run again undoes it] ' : '') + (cur.result || 'not run yet'), 15, 990, Math.max(1, Math.floor((H - yd - 4) / 19)), 'label')
                    .forEach((l, i) => cv.text(l, x0, yd + 14 + i * 19, 15, t.text, { literal: true }));
            }
            // what the service watches
            const p = st.panel || {};
            const px = 1040, pw = W - px - 20;
            const rows = [
                ['Wheel', (p.wheel ? p.wheel.count + ' changes' + (p.wheel.monitor !== 'available' ? ' (' + p.wheel.monitor + ')' : '') + ' - skip: ' + p.wheel.skip : '-')],
                ['Forwarded', String(p.forwarded || 0) + ' buttons'],
                ['Source', p.source],
                ['HMI shows', p.hmi],
                ['CarLifeMp', p.carlifeMp],
                ['CarLife mgr', p.carlifeMgr],
                ['1046', p.oap],
                ['Service', st.version + ', start ' + (st.starts || '?') + (st.starts > 1 ? ' (RESTARTED)' : '') + ', ' + (st.memory || '?') + ' MB, ' + (p.phase || '?') +
                    (p.crashed && p.crashed.length ? ' | crashed in: ' + p.crashed.join(', ') : '')],
                ['Routes', p.routes ? '287: ' + (p.routes['287'] != null ? '#' + p.routes['287'] : '-') + ', 1046: ' + (p.routes['1046'] != null ? '#' + p.routes['1046'] : '-') : '-'],
            ];
            rows.forEach((r, i) => {
                const y = 72 + i * 24;
                cv.text(r[0], px, y, 16, t.dim, { font: 'bold', literal: true });
                cv.text(clip(cv, r[1], 15, pw - 120, 'label'), px + 120, y, 15, t.text, { literal: true });
            });
            let y = 72 + rows.length * 24 + 10;
            cv.fillRect(px, y - 14, pw, 1, withAlpha('#ffffff', 0.15));
            cv.text('Last events', px, y + 4, 16, t.dim, { font: 'bold', literal: true });
            y += 24;
            (p.events || []).slice().reverse().slice(0, 6).forEach((e) => {
                cv.text(clip(cv, ago(e.at, st.now) + '  ' + e.text, 14, pw, 'label'), px, y, 14, t.text, { literal: true });
                y += 19;
            });
            if (!(p.events || []).length) { cv.text('press the steering wheel\'s buttons', px, y, 14, t.dim, { literal: true }); y += 19; }
            y += 6;
            cv.fillRect(px, y - 14, pw, 1, withAlpha('#ffffff', 0.15));
            const logLines = (st.log || []).slice(-Math.max(1, Math.floor((H - y) / 17)));
            logLines.forEach((l) => { cv.text(clip(cv, l, 13, pw, 'label'), px, y + 2, 13, t.dim, { literal: true }); y += 17; });
            if (st.report && st.report.at && st.now - st.report.at < 60000) {
                cv.text(st.report.usb && st.report.usb.length ? 'Report on the USB stick' : 'Report on the unit only (no USB stick)', W - 20, 25, 16, GREEN, { align: 'right', font: 'bold', literal: true });
            }
        }

        function shown() { return !ui.isVisible || ui.isVisible('MAIN'); }
        setInterval(() => { if (shown()) poll().catch(() => {}); }, 1000);
        await poll();
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('Media Probe first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});

module.exports = { ask, wrap, clip };
