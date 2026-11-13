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
            // an id 0 is "none" (requestSteerWheelFunctions: "getter": {"id": 0}; BMW's generator refuses to read it)
            const has = (k) => !!(v[k] && v[k].id);
            fields[f] = { getter: has('getter'), setter: has('setter'), notifier: has('notifier') };
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
    const out = { format: 2, catalog: { size: st.size, mtimeMs: st.mtime.getTime(), version: catalog.version || null }, ifaces, interfaces: sum.interfaces,
        instances: sum.instances, gen: { count: 0, error: null, ms: 0 } };
    const t0 = Date.now();
    // one interface at a time: a field the generator refuses costs that field's flag, never the other interfaces
    const errors = [];
    let gen = null;
    try { gen = require('./oapgen'); } catch (e) { errors.push('oapgen: ' + e.message); }
    Object.keys(sum.interfaces).forEach((n) => {
        if (!gen) return;
        const e = entry(sum.interfaces[n]);
        for (let tries = 0; tries < 12; tries++) {
            const mf = path.join(outDir, 'manifest.json');
            fs.writeFileSync(mf, JSON.stringify({ proxies: { [n]: e }, services: {} }, null, 1));
            try { gen.main([catalogPath, mf, '0', outDir]); return; }
            catch (err) {
                const msg = String(err && err.message || err);
                const m = /Requested (read|write|subscribe) for (\w+) but no/i.exec(msg);
                const flag = m ? { read: 'r', write: 'w', subscribe: 's' }[m[1].toLowerCase()] : null;
                if (flag && e.attributes && e.attributes[m[2]] != null) {
                    e.attributes[m[2]] = e.attributes[m[2]].replace(flag, '');
                    if (!e.attributes[m[2]]) delete e.attributes[m[2]];
                    console.log('prepare: ' + n.split('.').pop() + '.' + m[2] + ': no ' + m[1] + ' (' + msg.slice(0, 160) + '): left out');
                    continue;
                }
                errors.push(n + ': ' + msg.slice(0, 300));
                return;
            }
        }
        errors.push(n + ': gave up after 12 tries');
    });
    out.gen.count = fs.readdirSync(outDir).filter((f) => /\.json$/.test(f) && ['manifest.json', 'acl.json', 'summary.json'].indexOf(f) < 0).length;
    if (errors.length) { out.gen.errors = errors; if (!out.gen.count) out.gen.error = errors.join('; '); }
    out.gen.ms = Date.now() - t0;
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(out));
    console.log('prepare: ' + Object.keys(sum.interfaces).length + ' interfaces, generator ' + (out.gen.error ? 'failed: ' + out.gen.error : out.gen.count + ' configs') + ' in ' + out.gen.ms + ' ms' +
        (out.gen.errors && !out.gen.error ? '; refused: ' + out.gen.errors.join('; ') : ''));
}

if (require.main === module) {
    try { main(process.argv.slice(2)); process.exit(0); }
    catch (e) { console.error('prepare: ' + (e && e.stack || e)); process.exit(1); }
}
module.exports = { summarize, entry, main };
