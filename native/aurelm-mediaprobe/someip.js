'use strict';
/**
 * someip.js - SOME/IP for the probe service: any interface of the head unit's catalog, as root.
 *
 * The interface configs are made on the unit, at the service's first start, the way MainApp's installer makes an
 * app's (oapgen.js: BMW's own generator, loaded from the firmware), asking for every field (with its getter, setter
 * and notifier as the catalog has them), method and event of the probe's interfaces. That runs in a child process
 * (prepare.js: its own memory, the 4.6 MB catalog and the firmware's bundle never in the service, which keeps
 * answering meanwhile), and is kept: the next start uses it while the catalog file is the same. When it fails,
 * MainApp's own configs (/usr/lib/oap-mainapp/src-gen, as RideTube's daemon uses them) are tried.
 *
 * The native binding deadlocks when called inline next to other SOME/IP traffic (kit/runtime/signals.js): every
 * call goes through one queue, each in a fresh setImmediate tick, one at a time.
 *
 *   const s = createSomeip({ log, dir });
 *   await s.prepare(ifaces)                 configs and the catalog's summary for these interfaces (once)
 *   const p = await s.proxy(iface, inst)    a proxy, made once and kept
 *   s.get(p, field) / s.set(p, field, v) / s.call(p, method, args) / s.on(p, name, fn) / s.avail(p, fn)
 *   s.info(iface)                           the catalog's entry: { fields: {name: {getter,setter,notifier}}, events, methods }
 *   s.binding()                             what the native module offers (its exports and a proxy's methods)
 */
const fs = require('fs');
const path = require('path');

const SOMEIP = process.env.PROBE_SOMEIP || '/usr/lib/someip.node';
const CATALOG = process.env.PROBE_CATALOG || '/etc/oap/someip/someip-interfaces.json';
const SRCGEN = process.env.PROBE_SRCGEN || '/usr/lib/oap-mainapp/src-gen';

function createSomeip(opts) {
    const o = opts || {};
    const log = o.log || console.log;
    const dir = o.dir;                 // where the made configs go
    let native = null, nativeError = null;
    try { native = o.native || require(SOMEIP); } catch (e) { nativeError = e.message; }
    // the catalog's summary for the probe's interfaces (prepare.js); tests hand a catalog in
    let sum = o.catalog ? Object.assign({ catalog: { version: o.catalog.version || null } }, require('./prepare').summarize(o.catalog, Object.keys(o.catalog.interfaces || {}))) : null;
    const gen = { done: false, error: null, count: 0, cached: false, ms: 0 };
    const proxies = new Map();

    let chain = Promise.resolve();
    function tick(fn) {
        const run = () => new Promise((res, rej) => setImmediate(() => { try { Promise.resolve(fn()).then(res, rej); } catch (e) { rej(e); } }));
        const p = chain.then(run, run);
        chain = p.catch(() => {});
        return p;
    }
    function timeout(p, ms, what) {
        return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(what + ': no answer in ' + ms + ' ms')), ms);
            p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
        });
    }

    function info(iface) {
        if (!sum || !sum.interfaces[iface]) return null;
        const x = sum.interfaces[iface];
        const ev = {}, me = {};
        (x.events || []).forEach((e) => { ev[e] = {}; });
        (x.methods || []).forEach((m) => { me[m] = {}; });
        return { fields: x.fields, events: ev, methods: me };
    }
    function instances(iface) { return (sum && sum.instances[iface]) || []; }

    /** the configs and the summary for `ifaces`: made by prepare.js in a child process, or kept from the last start */
    function prepare(ifaces) {
        if (gen.done) return Promise.resolve(gen);
        gen.done = true;
        if (o.catalog) return Promise.resolve(gen);
        const sumFile = path.join(dir, 'summary.json');
        let st = null;
        try { st = fs.statSync(CATALOG); } catch (e) { gen.error = 'no catalog: ' + e.message; return Promise.resolve(gen); }
        try {
            const old = JSON.parse(fs.readFileSync(sumFile, 'utf8'));
            if (old.format === 2 && old.catalog.size === st.size && old.catalog.mtimeMs === st.mtime.getTime() && old.ifaces.join(',') === ifaces.join(',') && !old.gen.error) {
                sum = old; gen.count = old.gen.count; gen.cached = true; gen.ms = old.gen.ms;
                log('configs: kept from an earlier start (' + gen.count + ' configs, catalog ' + (old.catalog.version || '?') + ')');
                return Promise.resolve(gen);
            }
        } catch (e) { /* none yet */ }
        log('configs: making them (prepare.js, a child process)...');
        return new Promise((res) => {
            const cp = require('child_process');
            cp.execFile(process.execPath, [path.join(__dirname, 'prepare.js'), CATALOG, dir, ifaces.join(',')], { timeout: 120000, maxBuffer: 1 << 20 }, (err, out, errOut) => {
                if (out && out.trim()) log(out.trim());
                if (errOut && errOut.trim()) log('prepare stderr: ' + errOut.trim().slice(0, 600));
                try { sum = JSON.parse(fs.readFileSync(sumFile, 'utf8')); } catch (e) { sum = null; }
                if (!sum) gen.error = 'prepare.js: ' + (err ? (err.killed ? 'timed out' : err.message) : 'no summary');
                else { gen.error = sum.gen.error; gen.count = sum.gen.count; gen.ms = sum.gen.ms; }
                if (gen.error) log('config generator: ' + gen.error + ' (MainApp\'s configs are tried instead)');
                res(gen);
            });
        });
    }

    function config(iface) {
        const f = iface.replace(/\./g, '_') + '.json';
        const tried = [];
        for (const d of [dir, SRCGEN]) {
            if (!d) continue;
            try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch (e) { tried.push(d); }
        }
        if (o.configFor) return o.configFor(iface);
        throw new Error('no config for ' + iface + ' (looked in ' + tried.join(', ') + ')');
    }

    async function proxy(iface, inst) {
        const key = iface + '#' + inst;
        if (proxies.has(key)) return proxies.get(key);
        if (!native) throw new Error('someip native module: ' + nativeError);
        const cfg = config(iface);
        const p = timeout(tick(() => native.buildProxy(cfg, String(inst)).then((px) => px.init().then(() => px))), 15000, 'proxy ' + key);
        proxies.set(key, p);
        p.catch(() => proxies.delete(key));
        return p;
    }
    const get = (p, f, ms) => timeout(tick(() => p.getValue(f, ms || 3000)), (ms || 3000) + 2000, 'get ' + f);
    const set = (p, f, v, ms) => timeout(tick(() => p.setValue(f, v, ms || 5000)), (ms || 5000) + 2000, 'set ' + f);
    const call = (p, m, a, ms) => timeout(tick(() => p.callMethod(m, a || {}, ms || 5000)), (ms || 5000) + 2000, 'call ' + m);
    function on(p, name, fn) {
        return tick(() => p.subscribe({ name, onReceive: (v) => { try { fn(v); } catch (e) { log('handler ' + name + ': ' + (e && e.stack || e)); } } }));
    }
    function avail(p, fn) {
        return tick(() => { try { return p.subscribeToAvailability((a) => fn(!!a)); } catch (e) { return null; } })
            .then(() => { if (p.isAvailable && p.isAvailable()) fn(true); });
    }
    const isAvailable = (p) => { try { return !!(p.isAvailable && p.isAvailable()); } catch (e) { return false; } };

    /** what the binding offers: its exports, and the methods of a proxy (its prototype chain) */
    function binding(sample) {
        const out = { module: SOMEIP, loaded: !!native, error: nativeError, exports: {}, proxy: [] };
        if (native) {
            Object.keys(native).forEach((k) => { out.exports[k] = typeof native[k]; });
            Object.getOwnPropertyNames(Object.getPrototypeOf(native) || {}).forEach((k) => { if (!(k in out.exports)) out.exports[k] = 'proto'; });
        }
        if (sample) {
            const seen = {};
            for (let x = sample; x && x !== Object.prototype; x = Object.getPrototypeOf(x)) {
                Object.getOwnPropertyNames(x).forEach((k) => { if (!seen[k] && k !== 'constructor') { seen[k] = 1; out.proxy.push(k + ':' + typeof sample[k]); } });
            }
        }
        return out;
    }

    async function shutdown() {
        const all = Array.from(proxies.values());
        proxies.clear();
        for (const pp of all) {
            try { const p = await pp; if (p.shutdown) await tick(() => p.shutdown()); } catch (e) { /* gone */ }
        }
    }

    return { prepare, proxy, get, set, call, on, avail, isAvailable, info, instances, binding, shutdown, gen,
        catalogVersion: () => (sum && sum.catalog && sum.catalog.version) || null, hasCatalog: () => !!sum, hasNative: () => !!native };
}

module.exports = { createSomeip, SOMEIP, CATALOG, SRCGEN };
