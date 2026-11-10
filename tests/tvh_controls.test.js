'use strict';
/**
 * The channel's controls over the picture (apps/aurelm_tvh/controls.js): node tests/tvh_controls.test.js
 * Touch and the iDrive controller (the kit's codes), CH- / CH+ / stop / aspect / exit, the channel list (LIST, or a
 * push up) chosen by touch or by the knob and a press, hiding after 5 s; drawn with the kit's Recorder. Also the
 * app's channel order for CH+ / CH- (round).
 */
const assert = require('assert');
const path = require('path');
const { createControls, hm } = require(path.join(__dirname, '..', 'apps', 'aurelm_tvh', 'controls'));
const record = require(path.join(__dirname, '..', 'kit', 'runtime', 'record'));

const PL = { w: 1920, h: 720 };
const chans = ['1  PRO TV HD  -  Stirile', '2  Antena 1 HD', '3  Digi 24 HD', '4  Kanal D', '5  TVR 1'].map((t, i) => ({ uuid: 'u' + i, t }));
const t0 = Date.now() / 1000;
const info = { title: '1  PRO TV HD', now: { title: 'Stirile Pro TV', start: t0 - 600, stop: t0 + 1200 }, aspect: 'fit', profile: 'mgu-hd', current: 'u0', channels: chans };
let clock = 0;
function make() {
    const acts = [];
    const c = createControls({ now: () => clock, act: (a) => acts.push(a) });
    c.key(info);
    return { c, acts };
}
const centre = (b) => [b.x + b.w / 2, b.y + b.h / 2];
const tests = [];
const test = (n, f) => tests.push({ n, f });

test('touch: the first shows the bar; the buttons run; above the bar hides it; hidden after 5 s', () => {
    const { c, acts } = make();
    c.touch('down', 900, 300, PL, info);
    assert.strictEqual(c.visible(), true);
    assert.deepStrictEqual(acts, []);
    const L = c.layout(PL);
    ['chdown', 'chup', 'aspect'].forEach((id) => { c.touch('down', ...centre(L.buttons.find((b) => b.id === id)), PL, info); c.touch('up', 0, 0, PL, info); });
    assert.deepStrictEqual(acts, ['chdown', 'chup', 'aspect']);
    c.touch('down', 900, 100, PL, info);
    assert.strictEqual(c.visible(), false);
    c.show();
    c.touch('down', ...centre(L.buttons.find((b) => b.id === 'stop')), PL, info);
    assert.strictEqual(acts[acts.length - 1], 'stop');
    assert.strictEqual(c.visible(), false, 'stop hides the bar');
    c.show(); clock += 5001;
    assert.strictEqual(c.visible(), false, '5 s');
});

test('the channel list: LIST opens it on the channel playing; a touch on a row plays that channel', () => {
    const { c, acts } = make();
    c.show();
    const L = c.layout(PL);
    c.touch('down', ...centre(L.buttons.find((b) => b.id === 'list')), PL, info);
    const m = c.menu();
    assert.ok(m && m.items.length === 5 && m.focus === 0 && m.cur === 'u0');
    const M = c.menuLayout(PL);
    const r = M.row(2 - m.first);
    c.touch('down', r.x + 20, r.y + r.h / 2, PL, info);
    assert.deepStrictEqual(acts, [{ channel: 'u2' }]);
    assert.strictEqual(c.menu(), null, 'closed');
    // the channel playing chosen again: nothing
    c.openList();
    c.touch('down', M.row(0 - c.menu().first).x + 20, M.row(0 - c.menu().first).y + 10, PL, info);
    assert.strictEqual(acts.length, 1);
});

test('the controller: knob and press along the buttons; push up opens the list, the knob and a press play one', () => {
    const { c, acts } = make();
    c.ccu({ knob: 100, press: 0, tilt: 0 });
    c.ccu({ knob: 101, press: 0, tilt: 0 });
    assert.strictEqual(c.visible(), true, 'the first move shows the bar');
    assert.strictEqual(c.focus(), 'chup');
    c.ccu({ knob: 101, press: 1, tilt: 0 }); c.ccu({ knob: 101, press: 0, tilt: 0 });
    assert.deepStrictEqual(acts, ['chup']);
    c.ccu({ knob: 101, press: 0, tilt: 1 }); c.ccu({ knob: 101, press: 0, tilt: 0 });
    assert.ok(c.menu(), 'push up: the list');
    c.ccu({ knob: 104, press: 0, tilt: 0 });
    assert.strictEqual(c.menu().focus, 3);
    c.ccu({ knob: 104, press: 2, tilt: 0 });
    assert.deepStrictEqual(acts[1], { channel: 'u3' });
    c.ccu({ knob: 104, press: 0, tilt: 7 });
    assert.strictEqual(c.visible(), false, 'push down hides');
    c.ccu({ knob: 104, press: 15, tilt: 15 });
    assert.strictEqual(c.visible(), false, 'no controller behind it');
});

test('drawn: the bar, the programme, the list', () => {
    const { c } = make();
    c.show(); c.openList();
    const rec = new record.Recorder(PL.w, PL.h).clear(0x000000ff);
    const said = [];
    const text = rec.text.bind(rec);
    rec.text = (t, ...r) => { said.push(String(t)); return text(t, ...r); };
    c.draw(rec, PL, info);
    const texts = said.join('|');
    assert.ok(texts.indexOf('Stirile Pro TV') >= 0 && texts.indexOf('CHANNELS') >= 0 && texts.indexOf('CH +') >= 0 && texts.indexOf('mgu-hd') >= 0, 'texts drawn');
    assert.ok(/^\d\d:\d\d$/.test(hm(t0)));
});

test('the app: CH+ / CH- go round the list', () => {
    // main.js runs the app when required: its helper is checked as written there
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'apps', 'aurelm_tvh', 'main.js'), 'utf8');
    const body = /function neighbour\(list, uuid, d\) \{[\s\S]*?\n\}/.exec(src)[0];
    const neighbour = new Function(body + '; return neighbour;')();
    const l = [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }];
    assert.strictEqual(neighbour(l, 'c', 1).uuid, 'a');
    assert.strictEqual(neighbour(l, 'a', -1).uuid, 'c');
    assert.strictEqual(neighbour(l, 'x', 1).uuid, 'a', 'nothing playing: the first');
    assert.strictEqual(neighbour(l, 'x', -1).uuid, 'c');
    assert.strictEqual(neighbour([], 'a', 1), null);
});

let failed = 0;
for (const t of tests) {
    try { t.f(); console.log('ok   ' + t.n); } catch (e) { failed++; console.log('FAIL ' + t.n + '\n     ' + (e && e.stack || e)); }
}
console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
