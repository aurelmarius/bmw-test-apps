'use strict';
/**
 * The kit's draggable targets (record.js target(..., drag), display.js _touch): a finger put down on one goes to its
 * drag function (1 down, 2 move, 3 up) until it lifts, also when it leaves the target; a tap elsewhere is a tap.
 * Music Assistant's progress bar uses it. node tests/kit_drag_target.test.js
 */
const assert = require('assert');
const path = require('path');
const { Display } = require(path.join(__dirname, '..', 'kit', 'runtime', 'display'));
const { Recorder } = require(path.join(__dirname, '..', 'kit', 'runtime', 'record'));

const calls = [];
const r = new Recorder(1600, 600);
r.target(400, 200, 600, 50, () => calls.push('run bar'), 'seekbar', 0, (p, x) => calls.push(p + '@' + x));
r.target(0, 300, 100, 50, () => calls.push('tap b'), 'b', 0);
assert.strictEqual(typeof r.targets[0].drag, 'function', 'the recorder keeps drag');
const d = Object.create(Display.prototype);
Object.assign(d, { log: { error: (a, e) => { throw e; } }, place: { scale: 1, ox: 0, oy: 0, h: 720, x: 0 }, tabs: [], sheet: null, barOff: 0, pageTargets: r.targets });
d.own = () => true; d.barH = () => 80; d.buttons = () => []; d._repaint = () => {};
d._touch(1, 450, 220); d._touch(2, 700, 230); d._touch(2, 1200, 400); d._touch(3, 1300, 410);
d._touch(1, 10, 310); d._touch(3, 10, 310);
assert.deepStrictEqual(calls, ['1@450', '2@700', '2@1200', '3@1300', 'tap b']);
console.log('ok   a dragged target follows the finger until it lifts; a tap elsewhere is a tap\nall 1 passed');
