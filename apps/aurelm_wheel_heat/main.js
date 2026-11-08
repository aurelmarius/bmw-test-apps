'use strict';
/**
 * Wheel Heating - steering wheel heating on / off for an iDrive 7 car with a heated iDrive 8 (LCI)
 * steering wheel, which has no heating button of its own.
 *
 * Opened from a favourite button (bookmark), the app switches the heating (setting "onOpen") and
 * shows the result; opened from the apps menu it only shows the status (setting "onMenu"); the status screen also has an on / off button and a
 * details page with what the car answered. The switching is in heat.js.
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { fitText } = require('./kit/text-layout');
const { WheelHeat } = require('./heat');

const W = 1600, H = 520;
const HOT = '#ff6a1a';
const GREEN = '#2fd27a';
const RED = '#ef2b2d';
const ENTRY_DEBOUNCE_MS = 3000;     // MainApp can report one press twice (event + start reason)
const AUTO_CLOSE_MS = 3000;         // setting showOnShortcut "brief": the status shows this long after the switch

let onEntry = () => true;
let lastOpen = null;                // { reason, fav, mode, t }: shown on the details page
/** A favourite button saves the app as a bookmark: MainApp reports BOOKMARK (event reason or start reason). */
const isFavourite = (reason) => /BOOKMARK/i.test(String(reason));

mgu.run({
    onEntry(reason, uuid) { return onEntry(reason, uuid); },
    // "Stay on the current screen": the entry is not mapped to the screen, so the HMI asks the app before
    // opening anything (read at the app's start: the mapping is made then)
    get lazyEntry() {
        try { return new mgu.Settings(mgu.SPEC.settings).get('showOnShortcut') === 'stay'; } catch (e) { return false; }
    },

    async start(ctx) {
        const { ui, settings, log } = ctx;
        let page = 0, loop = null;
        let toast = null, toastUntil = 0;
        const say = (msg, ms) => { toast = msg; toastUntil = Date.now() + (ms || 5000); };

        const heat = new WheelHeat(ctx.signals, log, {
            clientGroupId: () => settings.get('clientGroupId'),
            path: () => settings.get('path'),
            probe: () => settings.get('probe') !== false,
            onLearn: (id) => { log.info('climate service took client group ' + id + ': kept'); settings.set('clientGroupId', id); },
        });
        const ready = heat.init();

        const run = (want) => ready.then(() => heat.toggle(want)).then((r) => { say(r.msg || (r.ok ? 'Done' : 'Not switched')); kick(); return r; });

        // after a favourite button (showOnShortcut "brief"): the screen closes on its own a few seconds after
        // the switch, unless it is used meanwhile (a button, a tab, a tap) or the settings sheet is open
        // what this head unit's HMI offers an app (shown on the details page, for the next tests)
        let hmiNote = '';
        const hmiApi = (() => {
            const names = new Set();
            for (let o = ui.rhmi; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) Object.getOwnPropertyNames(o).forEach((n) => { try { if (typeof ui.rhmi[n] === 'function') names.add(n); } catch (e) { /* getter */ } });
            const want = ['closeTask', 'removeStateFromHistory', 'removeTaskFromHistory', 'closeState', 'openState', 'openEntryState'];
            log.info('rhmi methods: ' + Array.from(names).sort().join(', '));
            return want.filter((n) => names.has(n)).join(' ') || 'none of ' + want.join(' ');
        })();
        let autoClose = null;
        const cancelAutoClose = () => { if (autoClose) { clearTimeout(autoClose); autoClose = null; log.info('auto close cancelled'); } };
        const closeSoon = (after) => {
            cancelAutoClose();
            Promise.resolve(after).catch(() => {}).then(() => {
                autoClose = setTimeout(() => {
                    autoClose = null;
                    if (!ui.isVisible('MAIN') || (ctx.display && ctx.display.sheet)) return;
                    log.info('closing after the favourite button');
                    hmiNote = 'closed ' + new Date().toTimeString().slice(0, 8) + ', stack before: ' + JSON.stringify(ui.stack || null);
                    log.info('auto close: ' + hmiNote);
                    Promise.resolve(ui.close('MAIN')).catch((e) => log.warn('auto close: ' + e));
                }, AUTO_CLOSE_MS);
            });
        };
        const userRun = () => { cancelAutoClose(); return run(); };

        // favourite button (BOOKMARK) / apps menu (ENTRY_POINT, ...): each has its own setting, so opening
        // the app from the menu to look doesn't switch off a heating the car switched on by itself
        let lastEntry = 0;
        onEntry = (reason) => {
            const now = Date.now();
            const fav = isFavourite(reason);
            const mode = (fav ? settings.get('onOpen') : settings.get('onMenu')) || (fav ? 'toggle' : 'show');
            lastOpen = { reason: String(reason), fav, mode, t: now };
            log.info('opened (' + reason + (fav ? ', favourite button' : ', apps menu') + '): ' + mode);
            const screen = fav ? (settings.get('showOnShortcut') || 'brief') : 'show';
            if (now - lastEntry > ENTRY_DEBOUNCE_MS) {
                lastEntry = now;
                const done = mode !== 'show' ? run(mode === 'on' ? true : undefined) : null;
                if (screen === 'brief') closeSoon(done);
            }
            kick();
            return screen !== 'stay';
        };

        ui.onClick('BTN_TOGGLE', () => userRun());
        ui.onClick('BTN_PAGE', () => { cancelAutoClose(); page = 1 - page; kick(); });
        heat.on('change', () => kick());

        /* ---------- drawing ---------- */
        const yesNo = (v) => (v === true ? 'yes' : v === false ? 'no' : '--');
        const val = (v) => (v === undefined || v === null ? '--' : String(v));
        const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + ' s ago' : Math.round(s / 60) + ' min ago'; };

        function drawWheel(cv, cx, cy, r, color) {
            cv.arc(cx, cy, r - 14, r, 0, 360, color);
            cv.circle(cx, cy + 6, r * 0.22, color);
            cv.line(cx - r + 8, cy - 2, cx - r * 0.22, cy + 2, 14, color);
            cv.line(cx + r - 8, cy - 2, cx + r * 0.22, cy + 2, 14, color);
            cv.line(cx, cy + r * 0.28, cx, cy + r - 8, 14, color);
        }
        function drawWaves(cv, cx, y, color) {
            for (let i = -1; i <= 1; i++) {
                const x = cx + i * 46;
                const pts = [];
                for (let k = 0; k <= 12; k++) pts.push([x + Math.sin(k / 12 * Math.PI * 2) * 9, y - k * 5]);
                cv.polyline(pts, 6, color);
            }
        }

        function drawStatus(cv, t) {
            const st = heat.state();
            const on = st.on;
            const color = on === true ? HOT : on === false ? t.dim : withAlpha('#ffffff', 0.35);
            G.panel(cv, t, 24, 44, 760, 468, 'Steering Wheel Heating');
            drawWheel(cv, 404, 300, 130, color);
            if (on === true) drawWaves(cv, 404, 150, HOT);
            G.panel(cv, t, 816, 44, 760, 468, 'Status');
            cv.text(on === true ? 'ON' : on === false ? 'OFF' : '--', 848, 200, 96, on === true ? HOT : t.text, { font: 'bold' });
            cv.text(on === null ? 'Waiting for the car to report the heating' : 'reported by the ' + (st.climate.configured !== undefined ? 'climate service' : 'steering wheel'), 848, 240, 22, t.dim);
            const touch = !!(cv.own && cv.target);
            cv.fillRect(848, 290, 692, 110, withAlpha(on === true ? HOT : t.accent, 0.14));
            cv.strokeRoundRect(848, 290, 692, 110, 8, 1.5, withAlpha(on === true ? HOT : t.accent, 0.5));
            cv.text(heat.busy ? 'Switching...' : on === true ? 'Switch off' : 'Switch on', 1194, 358, 34, t.text, { font: 'bold', align: 'center' });
            if (touch) cv.target(848, 290, 692, 110, () => userRun(), 'toggle', 8);
            const last = heat.last;
            if (last) {
                cv.text(fitText(cv, (last.ok ? '' : 'Not switched: ') + (last.msg || '') + '  (' + ago(last.t) + ')', 21, 692), 848, 445, 21, last.ok ? (last.confirmed ? GREEN : t.text) : RED);
            } else {
                cv.text(fitText(cv, 'Put this app on a favourite button: highlight it in the apps menu and hold the button', 19, 692), 848, 445, 19, t.dim);
            }
            cv.text(fitText(cv, 'Favourite button: ' + settings.display('onOpen').toLowerCase() + '  ·  apps menu: ' + settings.display('onMenu').toLowerCase(), 19, 692), 848, 482, 19, t.dim);
        }

        function drawDetails(cv, t) {
            const st = heat.state();
            G.panel(cv, t, 24, 44, 760, 468, 'What the car reports');
            const rows = [
                ['CLIMATE SERVICE (ClimateMaster)', null],
                ['reachable', st.climate.error ? 'error' : yesNo(st.climate.service)],
                ['wheel heating available', yesNo(st.climate.available)],
                ['level set / actual', val(st.climate.configured) + ' / ' + val(st.climate.actual)],
                ['level range', st.climate.range ? st.climate.range.minValue + ' - ' + st.climate.range.maxValue : '--'],
                ['priority client', val(st.climate.priorityClient)],
                ['STEERING WHEEL SERVICE', null],
                ['reachable', st.body.error ? 'error' : yesNo(st.body.service)],
                ['coded / available', yesNo(st.body.coded) + ' / ' + yesNo(st.body.available)],
                ['heating', yesNo(st.body.heating)],
            ];
            let y = 124;
            rows.forEach(([k, v]) => {
                if (v === null) { if (y > 130) y += 8; cv.text(k, 56, y, 18, t.accent, { font: 'bold', spacing: 1 }); y += 36; return; }
                cv.text(k, 72, y, 21, t.dim);
                cv.text(v, 750, y, 22, t.text, { font: 'bold', align: 'right' });
                y += 34;
            });
            G.panel(cv, t, 816, 44, 760, 468, 'Requests sent');
            cv.text(fitText(cv, 'HMI offers: ' + hmiApi, 17, 692), 848, 392, 17, t.dim);
            cv.text(fitText(cv, hmiNote ? 'Auto close: ' + hmiNote : 'HMI stack: ' + JSON.stringify(ui.stack || null), 17, 692), 848, 420, 17, t.dim);
            if (lastOpen) cv.text(fitText(cv, 'Last opened: ' + (lastOpen.fav ? 'favourite button' : 'apps menu') + ' (' + lastOpen.reason + ') -> ' + lastOpen.mode + '  ·  ' + ago(lastOpen.t), 19, 692), 848, 482, 19, t.dim);
            cv.text(fitText(cv, 'Client group ' + settings.get('clientGroupId') + '  ·  path ' + settings.display('path') + (settings.get('probe') !== false ? '  ·  tries other groups' : ''), 19, 692), 848, 124, 19, t.dim);
            y = 170;
            if (!heat.history.length) cv.text('Nothing sent yet', 848, y, 21, t.dim);
            heat.history.slice(0, 5).forEach((h) => {
                const a = h.via === 'climate' ? 'group ' + h.args.clientGroupId + ', level ' + h.args.steeringWheelHeating
                    : h.via === 'climate-set' ? 'write level ' + h.args.configuredIntensityLevel : 'heating ' + h.args.heating;
                const ok = ['IS_ACCEPTED', 'NO_CHANGES', 'SENT', 'SET'].indexOf(h.answer) >= 0;
                cv.text(fitText(cv, h.via + ': ' + a, 20, 380), 848, y, 20, t.text);
                cv.text(fitText(cv, h.answer, 19, 300), 1544, y, 19, ok ? GREEN : RED, { align: 'right' });
                y += 36;
            });
        }

        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            G.frame(cv, t, ['Heating', 'Details'], page, [toast && Date.now() < toastUntil && { text: toast, color: 'accent' }]);
            if (page === 0) drawStatus(cv, t); else drawDetails(cv, t);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.onTab((i) => { cancelAutoClose(); page = i; kick(); });
        loop = ctx.loop('MAIN', 2, render);
        function kick() { if (loop) loop.kick(); }
    },
});
