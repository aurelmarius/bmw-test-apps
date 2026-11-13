'use strict';
/**
 * prepare.js - run by the service as a child process (its own memory, the service keeps answering meanwhile):
 * reads the unit's catalog once, writes the interface configs for the probe's interfaces with BMW's generator
 * (oapgen.js), and a small summary of those interfaces (fields with their getter / setter / notifier, events,
 * methods, instances) that the service reads instead of the 4.6 MB catalog.
 *
 *   node prepare.js <catalog> <outDir> <iface,iface,...>
 *
 * Writes <outDir>/summary.json { catalog: { size, mtimeMs, version }, ifaces, interfaces, instances, gen: { count, error } }.
 * Exit 0 when the summary is written (the generator may still have failed: gen.error), 1 when not even that.
 */
const fs = require('fs');
const path = require('path');

function summarize(catalog, ifaces) {
    const interfaces = {}, instances = {};
    ifaces.forEach((n) => {
        const x = catalog.interfaces && catalog.interfaces[n];
        if (!x) return;
        const fields = {};
        Object.keys(x.fields || {}).forEach((f) => {
            const v = x.fields[f];
            fields[f] = { getter: !!v.getter, setter: !!v.setter, notifier: !!v.notifier };
        });
        interfaces[n] = { fields, events: Object.keys(x.events || {}), methods: Object.keys(x.methods || {}) };
        instances[n] = Object.keys((catalog.instanceIDs && catalog.instanceIDs[n]) || {});
    });
    return { interfaces, instances };
}

/** the manifest entry asking for all of an interface, each field with its flags as the catalog has them */
function entry(info) {
    const attributes = {};
    Object.keys(info.fields).forEach((f) => {
        const v = info.fields[f];
        attributes[f] = (v.getter ? 'r' : '') + (v.setter ? 'w' : '') + (v.notifier ? 's' : '');
    });
    const e = { instances: '*' };
    if (Object.keys(attributes).length) e.attributes = attributes;
    if (info.methods.length) e.methods = info.methods;
    if (info.events.length) e.broadcasts = info.events;
    return e;
}

function main(argv) {
    const catalogPath = argv[0], outDir = argv[1], ifaces = String(argv[2] || '').split(',').filter(Boolean);
    try { fs.mkdirSync(outDir, 0o700); } catch (e) { /* there */ }
    const st = fs.statSync(catalogPath);
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const sum = summarize(catalog, ifaces);
    const out = { catalog: { size: st.size, mtimeMs: st.mtime.getTime(), version: catalog.version || null }, ifaces, interfaces: sum.interfaces,
        instances: sum.instances, gen: { count: 0, error: null, ms: 0 } };
    const t0 = Date.now();
    try {
        const proxies = {};
        Object.keys(sum.interfaces).forEach((n) => { proxies[n] = entry(sum.interfaces[n]); });
        const mf = path.join(outDir, 'manifest.json');
        fs.writeFileSync(mf, JSON.stringify({ proxies, services: {} }, null, 1));
        require('./oapgen').main([catalogPath, mf, '0', outDir]);
        out.gen.count = fs.readdirSync(outDir).filter((f) => /\.json$/.test(f) && ['manifest.json', 'acl.json', 'summary.json'].indexOf(f) < 0).length;
    } catch (e) {
        out.gen.error = String(e && e.message || e);
    }
    out.gen.ms = Date.now() - t0;
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(out));
    console.log('prepare: ' + Object.keys(sum.interfaces).length + ' interfaces, generator ' + (out.gen.error ? 'failed: ' + out.gen.error : out.gen.count + ' configs') + ' in ' + out.gen.ms + ' ms');
}

if (require.main === module) {
    try { main(process.argv.slice(2)); process.exit(0); }
    catch (e) { console.error('prepare: ' + (e && e.stack || e)); process.exit(1); }
}
module.exports = { summarize, entry, main };
