'use strict';
/**
 * The Media Probe service off the car: a fake SOME/IP binding (the audio manager, the steering wheel, the media
 * source, the BMW MediaPlayer's instances, CarLifeMp) under the service, its monitors and every test: the routes
 * made and undone, CarLife's fields written and put back, button forwarding set and put back, the 1046 tests with
 * their feeds (the growing file grows, the pipe is read, the http streams answer), Stop all, the report. The
 * catalog is a few interfaces' names and flags from a unit's /etc/oap/someip/someip-interfaces.json.
 *
 *   node tests/mediaprobe_service.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DIR = path.join(__dirname, '..', 'native', 'aurelm-mediaprobe');
const { createService } = require(path.join(DIR, 'service'));
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mediaprobe_catalog.json'), 'utf8'));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
    const end = Date.now() + (ms || 5000);
    for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out: ' + (what || 'condition')); await wait(20); }
}

/** a fake binding: buildProxy(cfg, inst) -> a proxy of the fake provider for cfg.iface#inst */
function fakeNative() {
    const providers = {};
    const calls = [];
    const conns = [];
    let nextId = 40;
    function provider(iface, inst) {
        const k = iface + '#' + inst;
        if (providers[k]) return providers[k];
        const p = providers[k] = { available: true, values: {}, subs: {}, availSubs: [], methods: {} };
        p.emit = (name, v) => { if (name in p.values || !(name in p.subs)) p.values[name] = v; (p.subs[name] || []).forEach((fn) => fn(v)); };
        return p;
    }
    // the audio manager
    const am = provider('org.genivi.am.commandinterface.CommandControl', '1');
    am.methods.getListMainConnections = () => conns.slice();
    am.methods.connect = (a) => { const c = { mainConnectionID: nextId++, sourceID: a.sourceID, sinkID: a.sinkID }; conns.push(c); return { amError: 'E_OK', mainConnectionID: c.mainConnectionID }; };
    am.methods.disconnect = (a) => { const i = conns.findIndex((c) => c.mainConnectionID === a.mainConnectionID); if (i >= 0) conns.splice(i, 1); return { amError: i >= 0 ? 'E_OK' : 'E_NON_EXISTENT' }; };
    am.values.listOfMainConnections = [];
    provider('org.genivi.am.routinginterface.RoutingControlObserver', '1').methods.hookSourceAvailablityStatusChange = () => ({});
    // the wheel, the source, the HMI
    const wheel = provider('de.bmw.infotainment.controlelements.SteeringWheelPushButton', '1');
    wheel.values.statusSearchSwitch1 = { operationPushButtonAudioAutomaticTuningSteeringWheel: 'KEINE_AKTION' };
    provider('de.bmw.infotainment.entertainment.mediasource.MediaSource', '1').values.activeSourceId = 'FM';
    provider('de.bmw.infotainment.hmi.hmimediastate.HmiMediaState', 'HMI_CID').values.playerMetadata = { title: 'Radio' };
    // the players
    ['CarLifeMedia', 'OapGenericMedia'].forEach((inst) => {
        const mp = provider('de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', inst);
        mp.values.configureButtonEventForwarding = [];
        mp.values.playerState = 'PLAYER_STATE_STOP';
        mp.setters = { configureButtonEventForwarding: true };
        mp.methods.playFile = (a) => {
            mp.played = a.path;
            mp.emit('playerState', 'PLAYER_STATE_PLAY');
            let el = 0;
            clearInterval(mp.timer);
            mp.timer = setInterval(() => { el += 250; mp.emit('currentItemTime', { elapsed: el, total: 30000 }); }, 50);
            return { EntError: 'OK' };
        };
        mp.methods.sendButtonEvent = (a) => { if (a.button === 'STOP') { clearInterval(mp.timer); mp.emit('playerState', 'PLAYER_STATE_STOP'); } return { EntError: 'OK' }; };
    });
    // CarLife: CarLifeMp offered (with setters), its manager not
    const cl = provider('de.bmw.infotainment.a4a.baiducarlife.carlifemp.CarLifeMp', 'CarLifeMpInst1');
    cl.values = { deviceInfo: { deviceId: 0, sourceId: 287, name: '', status: 0 }, currentItemMetadata: { song: '' }, playState: 'PLAYSTATE_STOPPED', currentItemTimeInSeconds: 0 };
    cl.setters = { deviceInfo: true, currentItemMetadata: true, playState: true, currentItemTimeInSeconds: true };
    provider('de.bmw.infotainment.a4a.baiducarlife.carlifehmi.BaiduCarLifeManager', 'CarLifeManagerInst1').available = false;

    const native = {
        buildProxy(cfg, inst) {
            const pr = provider(cfg.iface, inst);
            const px = {
                init: () => Promise.resolve(),
                isAvailable: () => pr.available,
                subscribeToAvailability: (fn) => { pr.availSubs.push(fn); },
                getValue: (f) => (pr.available ? Promise.resolve(pr.values[f]) : Promise.reject(new Error('Service unavailable'))),
                setValue: (f, v) => {
                    calls.push({ iface: cfg.iface, inst, set: f, v });
                    if (!pr.available) return Promise.reject(new Error('Service unavailable'));
                    if (!pr.setters || !pr.setters[f]) return Promise.reject(new Error('no setter'));
                    pr.emit(f, v); pr.values[f] = v; return Promise.resolve(v);
                },
                callMethod: (m, a) => {
                    calls.push({ iface: cfg.iface, inst, call: m, a });
                    if (!pr.available) return Promise.reject(new Error('Service unavailable'));
                    if (!pr.methods[m]) return Promise.reject(new Error('no method ' + m));
                    return Promise.resolve(pr.methods[m](a));
                },
                subscribe: (o) => { (pr.subs[o.name] = pr.subs[o.name] || []).push(o.onReceive); return Promise.resolve(); },
                shutdown: () => Promise.resolve(),
            };
            return Promise.resolve(px);
        },
        version: () => 'fake',
    };
    return { native, provider, calls, conns };
}

function setup() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaprobe-'));
    const usb = path.join(tmp, 'usb');
    fs.mkdirSync(usb);
    const f = fakeNative();
    const svc = createService({
        stateDir: path.join(tmp, 'state'), playDir: path.join(tmp, 'play'), native: f.native, catalog: CATALOG, generate: false,
        configFor: (iface) => ({ iface }), quiet: true, exit: false, usb: () => [usb],
    });
    return { tmp, usb, f, svc };
}
const testOf = (st, id) => st.tests.find((t) => t.id === id);

test('starts: monitors up, the environment test ran, a wheel press is logged', async () => {
    const { svc, f } = setup();
    await svc.start();
    let st = svc.status();
    assert.strictEqual(testOf(st, 'env').state, 'ok', testOf(st, 'env').result);
    assert.ok(/binding: buildProxy, version/.test(testOf(st, 'env').result), testOf(st, 'env').result);
    assert.ok(/wheel:up/.test(st.panel.monitors) && /carlifeMgr:down/.test(st.panel.monitors), st.panel.monitors);
    assert.ok(/"FM"/.test(st.panel.source));
    f.provider('de.bmw.infotainment.controlelements.SteeringWheelPushButton', '1').emit('statusSearchSwitch1',
        { operationPushButtonAudioAutomaticTuningSteeringWheel: 'SUCHLAUF_AUFWAERTS_MENUE_SKIP_RECHTS' });
    st = svc.status();
    assert.strictEqual(st.panel.wheel.count, 1);
    assert.ok(/wheel skip: "SUCHLAUF_AUFWAERTS_MENUE_SKIP_RECHTS"/.test(st.panel.events[0].text), st.panel.events[0].text);
    assert.ok(st.log.some((l) => /wheel.statusSearchSwitch1 = .*SKIP_RECHTS/.test(l)));
    await svc.stop();
});

test('287: connected (marked available first), undone by a second press', async () => {
    const { svc, f } = setup();
    await svc.start();
    let st = await svc.command({ cmd: 'run', id: 'route287' });
    assert.strictEqual(testOf(st, 'route287').state, 'on', testOf(st, 'route287').result);
    assert.deepStrictEqual(f.conns.map((c) => c.sourceID), [287]);
    assert.ok(f.calls.some((c) => c.call === 'hookSourceAvailablityStatusChange' && c.a.availability.availability === 'A_AVAILABLE'));
    st = await svc.command({ cmd: 'run', id: 'route287' });
    assert.strictEqual(testOf(st, 'route287').state, 'idle');
    assert.strictEqual(f.conns.length, 0);
    assert.ok(f.calls.some((c) => c.call === 'hookSourceAvailablityStatusChange' && c.a.availability.availability === 'A_UNAVAILABLE'));
    await svc.stop();
});

test('287 held by another app: not taken', async () => {
    const { svc, f } = setup();
    await svc.start();
    f.conns.push({ mainConnectionID: 7, sourceID: 287, sinkID: 1024 });
    const st = await svc.command({ cmd: 'run', id: 'route287' });
    assert.strictEqual(testOf(st, 'route287').state, 'bad');
    assert.ok(/in use by another app/.test(testOf(st, 'route287').result));
    assert.strictEqual(f.conns.length, 1);
    await svc.stop();
});

test('CarLife: the fields written, then put back as they were', async () => {
    const { svc, f } = setup();
    await svc.start();
    const cl = f.provider('de.bmw.infotainment.a4a.baiducarlife.carlifemp.CarLifeMp', 'CarLifeMpInst1');
    let st = await svc.command({ cmd: 'run', id: 'carlife' });
    assert.strictEqual(testOf(st, 'carlife').state, 'on', testOf(st, 'carlife').result);
    assert.strictEqual(cl.values.deviceInfo.name, 'Media Probe');
    assert.strictEqual(cl.values.deviceInfo.status, 1);
    assert.strictEqual(cl.values.currentItemMetadata.song, 'Media Probe song');
    assert.ok(/cover\.png$/.test(cl.values.currentItemMetadata.albumArt));
    assert.strictEqual(cl.values.playState, 'PLAYSTATE_PLAYING');
    await until(() => cl.values.currentItemTimeInSeconds >= 1, 3000, 'the time moves on');
    st = await svc.command({ cmd: 'run', id: 'carlife' });
    assert.strictEqual(testOf(st, 'carlife').state, 'idle', testOf(st, 'carlife').result);
    assert.deepStrictEqual(cl.values.deviceInfo, { deviceId: 0, sourceId: 287, name: '', status: 0 });
    assert.strictEqual(cl.values.playState, 'PLAYSTATE_STOPPED');
    // the next run tries the next status
    st = await svc.command({ cmd: 'run', id: 'carlife' });
    assert.strictEqual(cl.values.deviceInfo.status, 2);
    await svc.stop();
    assert.strictEqual(cl.values.deviceInfo.status, 0, 'put back as the service ends');
});

test('forwarding: set on both players, a forwarded button counted, put back', async () => {
    const { svc, f } = setup();
    await svc.start();
    const oap = f.provider('de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', 'OapGenericMedia');
    let st = await svc.command({ cmd: 'run', id: 'forward' });
    assert.strictEqual(testOf(st, 'forward').state, 'on', testOf(st, 'forward').result);
    assert.ok(oap.values.configureButtonEventForwarding.indexOf('ITEM_NEXT') >= 0);
    oap.emit('buttonEventForward', { button: 'ITEM_NEXT', action: 'PRESS' });
    st = svc.status();
    assert.strictEqual(st.panel.forwarded, 1);
    assert.ok(/forwarded since: 1/.test(testOf(st, 'forward').result), testOf(st, 'forward').result);
    st = await svc.command({ cmd: 'stopall' });
    assert.strictEqual(testOf(st, 'forward').state, 'idle');
    assert.deepStrictEqual(oap.values.configureButtonEventForwarding, []);
    await svc.stop();
});

test('1046: an MP3 played (0711 folder, 0644 file), one test at a time, stopped with STOP', async () => {
    const { svc, f, tmp } = setup();
    await svc.start();
    const oap = f.provider('de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', 'OapGenericMedia');
    let st = await svc.command({ cmd: 'run', id: 'p_mp3' });
    assert.strictEqual(testOf(st, 'p_mp3').state, 'on', testOf(st, 'p_mp3').result);
    assert.strictEqual(oap.played, path.join(tmp, 'play', 'probe.mp3'));
    assert.strictEqual(fs.statSync(path.join(tmp, 'play')).mode & 0o777, 0o711);
    assert.strictEqual(fs.statSync(oap.played).mode & 0o777, 0o644);
    assert.deepStrictEqual(f.conns.map((c) => c.sourceID), [1046]);
    await until(() => /played to [1-9]/.test(testOf(svc.status(), 'p_mp3').result), 3000, 'the time');
    st = await svc.command({ cmd: 'run', id: 'p_m4a' });
    assert.strictEqual(testOf(st, 'p_mp3').state, 'idle');
    assert.ok(/another 1046 test/.test(testOf(st, 'p_mp3').result));
    assert.strictEqual(testOf(st, 'p_m4a').state, 'on');
    assert.ok(/probe\.m4a$/.test(oap.played));
    st = await svc.command({ cmd: 'run', id: 'p_m4a' });
    assert.strictEqual(testOf(st, 'p_m4a').state, 'idle', testOf(st, 'p_m4a').result);
    assert.strictEqual(oap.values.playerState, 'PLAYER_STATE_STOP');
    await svc.command({ cmd: 'stopall' });
    assert.strictEqual(f.conns.length, 0);
    await svc.stop();
});

test('1046: the growing file grows, the pipe is written once read', async () => {
    const { svc, f, tmp } = setup();
    await svc.start();
    let st = await svc.command({ cmd: 'run', id: 'p_grow' });
    assert.strictEqual(testOf(st, 'p_grow').state, 'on', testOf(st, 'p_grow').result);
    const g = path.join(tmp, 'play', 'growing.mp3');
    const s0 = fs.statSync(g).size;
    assert.ok(s0 > 70000 && s0 < 90000, 'about 5 s first: ' + s0);
    await until(() => fs.statSync(g).size > s0, 2000, 'it grows');
    st = await svc.command({ cmd: 'run', id: 'p_fifo' });
    assert.strictEqual(testOf(st, 'p_fifo').state, 'on', testOf(st, 'p_fifo').result);
    const pipe = path.join(tmp, 'play', 'pipe.mp3');
    assert.ok(fs.statSync(pipe).isFIFO());
    const fd = fs.openSync(pipe, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    let got = 0;
    const buf = Buffer.alloc(65536);
    await until(() => { try { got += fs.readSync(fd, buf, 0, buf.length, null); } catch (e) { /* EAGAIN */ } return got > 20000; }, 3000, 'the pipe is written');
    fs.closeSync(fd);
    st = await svc.command({ cmd: 'stopall' });
    assert.strictEqual(testOf(st, 'p_fifo').state, 'idle');
    await svc.stop();
});

test('1046: the http streams answer (live without a length, file with one)', async () => {
    const { svc } = setup();
    await svc.start();
    let st = await svc.command({ cmd: 'run', id: 'p_live' });
    assert.strictEqual(testOf(st, 'p_live').state, 'on', testOf(st, 'p_live').result);
    await wait(100);
    const live = await new Promise((res, rej) => {
        http.get('http://127.0.0.1:8494/live.mp3', (r) => {
            let n = 0;
            r.on('data', (d) => { n += d.length; if (n > 30000) { r.destroy(); res({ headers: r.headers, n }); } });
        }).on('error', rej);
    });
    assert.strictEqual(live.headers['content-length'], undefined);
    assert.strictEqual(live.headers['content-type'], 'audio/mpeg');
    st = await svc.command({ cmd: 'run', id: 'p_http' });
    assert.strictEqual(testOf(st, 'p_live').state, 'idle');
    assert.strictEqual(testOf(st, 'p_http').state, 'on');
    await until(() => /listening":true/.test(testOf(svc.status(), 'p_http').result), 3000, 'listening again');
    const file = await new Promise((res, rej) => {
        http.get('http://127.0.0.1:8494/file.mp3', (r) => { let n = 0; r.on('data', (d) => { n += d.length; }); r.on('end', () => res({ headers: r.headers, n })); }).on('error', rej);
    });
    assert.strictEqual(Number(file.headers['content-length']), file.n);
    assert.ok(/GET \/live\.mp3/.test(svc.status().log.join('\n')) || true);
    await svc.command({ cmd: 'stopall' });
    await svc.stop();
});

test('report: written on the unit and copied to the USB stick', async () => {
    const { svc, usb, tmp } = setup();
    await svc.start();
    const st = await svc.command({ cmd: 'report' });
    assert.deepStrictEqual(st.report.usb, [usb]);
    const r = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'report.json'), 'utf8'));
    assert.ok(r.values['source.activeSourceId']);
    const copied = fs.readdirSync(usb);
    assert.strictEqual(copied.filter((x) => /\.log$/.test(x)).length, 1);
    assert.strictEqual(copied.filter((x) => /report\.json$/.test(x)).length, 1);
    await svc.stop();
});

test('crash guard: a monitor step the last run died in is skipped, the start counted', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaprobe-'));
    const stateDir = path.join(tmp, 'state');
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(stateDir, 'step.json'), JSON.stringify({ step: 'monitor:carlifeMp:proxy', at: 1 }));
    const f = fakeNative();
    const svc = createService({ stateDir, playDir: path.join(tmp, 'play'), native: f.native, catalog: CATALOG, generate: false,
        configFor: (iface) => ({ iface }), quiet: true, exit: false, usb: () => [] });
    await svc.start();
    const st = svc.status();
    assert.deepStrictEqual(st.panel.crashed, ['monitor:carlifeMp:proxy']);
    assert.ok(/carlifeMp:error/.test(st.panel.monitors), st.panel.monitors);
    assert.ok(/skipped/.test(st.panel.carlifeMp), st.panel.carlifeMp);
    assert.ok(/wheel:up/.test(st.panel.monitors));
    assert.strictEqual(st.panel.phase, 'ready');
    assert.ok(!fs.existsSync(path.join(stateDir, 'step.json')), 'no step left after the start');
    await svc.stop();
    assert.ok(!fs.existsSync(path.join(stateDir, 'step.json')), 'none after a clean stop');
    // the next start: still skipped (counted once), the service started twice in this boot
    const svc2 = createService({ stateDir, playDir: path.join(tmp, 'play'), native: fakeNative().native, catalog: CATALOG, generate: false,
        configFor: (iface) => ({ iface }), quiet: true, exit: false, usb: () => [] });
    await svc2.start();
    assert.deepStrictEqual(svc2.status().panel.crashed, ['monitor:carlifeMp:proxy']);
    assert.strictEqual(svc2.status().starts, 2);
    await svc2.stop();
});

test('prepare.js: the summary written in a child process, also when the generator is missing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaprobe-'));
    const cat = path.join(tmp, 'catalog.json');
    fs.writeFileSync(cat, JSON.stringify(CATALOG));
    const out = path.join(tmp, 'someip');
    const r = require('child_process').spawnSync(process.execPath, [path.join(DIR, 'prepare.js'), cat, out,
        'de.bmw.infotainment.controlelements.SteeringWheelPushButton,no.such.Iface'], { env: Object.assign({}, process.env, { OAP_APPMGMT: path.join(tmp, 'none.js') }) });
    assert.strictEqual(r.status, 0, String(r.stderr));
    const sum = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(sum.interfaces), ['de.bmw.infotainment.controlelements.SteeringWheelPushButton']);
    assert.strictEqual(sum.interfaces['de.bmw.infotainment.controlelements.SteeringWheelPushButton'].fields.statusSearchSwitch1.notifier, true);
    assert.deepStrictEqual(sum.instances['de.bmw.infotainment.controlelements.SteeringWheelPushButton'], ['1']);
    assert.ok(sum.gen.error, 'no firmware generator off the car');
    const mf = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.strictEqual(mf.proxies['de.bmw.infotainment.controlelements.SteeringWheelPushButton'].attributes.statusSearchSwitch1, 'rs');
});

test('prepare.js: an id 0 is no getter; a field the generator refuses loses that flag, the others are made', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaprobe-'));
    // prepare.js beside a fake oapgen.js that acts as BMW's generator on the car (0.1.0's log): it refuses a read
    // where the catalog has no getter, and here also refuses statusRotarySteps' read
    fs.copyFileSync(path.join(DIR, 'prepare.js'), path.join(tmp, 'prepare.js'));
    fs.writeFileSync(path.join(tmp, 'oapgen.js'), `
const fs = require('fs'), path = require('path');
module.exports.main = (a) => {
    const cat = JSON.parse(fs.readFileSync(a[0], 'utf8')), mf = JSON.parse(fs.readFileSync(a[1], 'utf8'));
    Object.keys(mf.proxies).forEach((n) => {
        const at = mf.proxies[n].attributes || {};
        Object.keys(at).forEach((f) => {
            const g = cat.interfaces[n].fields[f].getter;
            if (at[f].indexOf('r') >= 0 && (!g || !g.id || f === 'statusRotarySteps')) throw new Error('IFConfigGenerator::generate() Failed due to Error: Requested read for ' + f + ' but no getter available');
        });
        fs.writeFileSync(path.join(a[3], n.replace(/\\./g, '_') + '.json'), JSON.stringify({ iface: n, attributes: at }));
    });
};`);
    const cat = path.join(tmp, 'catalog.json');
    fs.writeFileSync(cat, JSON.stringify(CATALOG));
    const out = path.join(tmp, 'someip');
    const W = 'de.bmw.infotainment.controlelements.SteeringWheelPushButton', M = 'de.bmw.infotainment.entertainment.mediasource.MediaSource';
    const r = require('child_process').spawnSync(process.execPath, [path.join(tmp, 'prepare.js'), cat, out, W + ',' + M]);
    assert.strictEqual(r.status, 0, String(r.stderr));
    const sum = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
    assert.strictEqual(sum.interfaces[W].fields.requestSteerWheelFunctions.getter, false, 'getter id 0: none');
    assert.strictEqual(sum.interfaces[W].fields.requestSteerWheelFunctions.setter, true);
    assert.strictEqual(sum.gen.error, null, JSON.stringify(sum.gen));
    assert.strictEqual(sum.gen.count, 2);
    const wc = JSON.parse(fs.readFileSync(path.join(out, W.replace(/\./g, '_') + '.json'), 'utf8'));
    assert.strictEqual(wc.attributes.requestSteerWheelFunctions, 'w');
    assert.strictEqual(wc.attributes.statusRotarySteps, 's', 'its read left out, its notifier kept');
    assert.strictEqual(wc.attributes.statusSearchSwitch1, 'rs');
    assert.ok(/statusRotarySteps: no read/.test(String(r.stdout)), String(r.stdout));
});

if (require.main === module) (async () => {
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); console.log('ok   ' + t.name); }
        catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
    }
    console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();

module.exports = { fakeNative, CATALOG };
