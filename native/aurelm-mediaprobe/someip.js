'use strict';
/**
 * someip.js - SOME/IP for the probe service: any interface of the head unit's catalog, as root.
 *
 * The interface configs are made on the unit, at the service's start, the way MainApp's installer makes an app's
 * (oapgen.js: BMW's own generator, loaded from the firmware), from a manifest that asks for every field (with its
 * getter, setter and notifier as the catalog has them), method and event of the interfaces below. When that fails,
 * MainApp's own configs (/usr/lib/oap-mainapp/src-gen, as RideTube's daemon uses them) are tried.
 *
 * The native binding deadlocks when called inline next to other SOME/IP traffic (kit/runtime/signals.js): every
 * call goes through one queue, each in a fresh setImmediate tick, one at a time.
 *
 *   const s = createSomeip({ log, dir });
 *   await s.prepare(ifaces)                 configs for these interfaces (once)
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
    let catalog = null, catalogError = null;
    try { catalog = o.catalog || JSON.parse(fs.readFileSync(CATALOG, 'utf8')); } catch (e) { catalogError = e.message; }
    const gen = { done: false, error: null, count: 0 };
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
        return catalog && catalog.interfaces ? catalog.interfaces[iface] || null : null;
    }
    function instances(iface) {
        const m = catalog && catalog.instanceIDs ? catalog.instanceIDs[iface] : null;
        return m ? Object.keys(m) : [];
    }
    /** the manifest entry asking for all of an interface, with each field's flags as the catalog has them */
    function entry(iface) {
        const x = info(iface);
        if (!x) return null;
        const attributes = {};
        Object.keys(x.fields || {}).forEach((f) => {
            const v = x.fields[f];
            attributes[f] = (v.getter ? 'r' : '') + (v.setter ? 'w' : '') + (v.notifier ? 's' : '');
        });
        const e = { instances: '*' };
        if (Object.keys(attributes).length) e.attributes = attributes;
        if (Object.keys(x.methods || {}).length) e.methods = Object.keys(x.methods);
        if (Object.keys(x.events || {}).length) e.broadcasts = Object.keys(x.events);
        return e;
    }

    /** configs for `ifaces` (proxies) and `offers` ({ iface: [instances] }, services this process could offer) */
    function prepare(ifaces, offers) {
        if (gen.done) return gen;
        gen.done = true;
        if (!catalog) { gen.error = 'no catalog: ' + catalogError; return gen; }
        if (o.generate === false) return gen;
        try {
            const proxiesM = {};
            ifaces.forEach((i) => { const e = entry(i); if (e) proxiesM[i] = e; else log('catalog: no ' + i); });
            const services = {};
            Object.keys(offers || {}).forEach((i) => { if (info(i)) services[i] = { instances: offers[i] }; });
            const manifest = { proxies: proxiesM, services };
            try { fs.mkdirSync(dir, 0o700); } catch (e) { /* there (Node 8: no recursive) */ }
            const mf = path.join(dir, 'manifest.json');
            fs.writeFileSync(mf, JSON.stringify(manifest, null, 1));
            require('./oapgen').main([CATALOG, mf, '0', dir]);
            gen.count = fs.readdirSync(dir).filter((f) => /\.json$/.test(f) && f !== 'manifest.json' && f !== 'acl.json').length;
        } catch (e) {
            gen.error = String(e && e.message || e);
            log('config generator: ' + gen.error + ' (MainApp\'s configs are tried instead)');
        }
        return gen;
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

    return { prepare, proxy, get, set, call, on, avail, isAvailable, info, instances, entry, binding, shutdown, gen,
        catalogVersion: () => (catalog && catalog.version) || null, hasCatalog: () => !!catalog, hasNative: () => !!native };
}

module.exports = { createSomeip, SOMEIP, CATALOG, SRCGEN };
