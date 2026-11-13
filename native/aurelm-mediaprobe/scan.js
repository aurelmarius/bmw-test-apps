'use strict';
/**
 * scan.js - the probe's SDK search, run by the service as a child process with capped memory
 * (node --max-old-space-size=96 scan.js): MainApp's and the apps' JavaScript searched for how the binding offers a
 * service (registerService, as the binding exports it): the calls around each one show its arguments. One line per
 * finding on stdout, the summary last.
 */
const fs = require('fs');
const path = require('path');
const show = (v) => { const s = JSON.stringify(v); return s.length > 600 ? s.slice(0, 600) + '...' : s; };

/**
 * The SDK's (and MainApp's) JavaScript, searched for how the binding offers a service: next to each buildProxy
 * the binding's other calls show. Logs what it finds; returns a one-line summary.
 */
function scanSdk(log) {
    const roots = ['/usr/lib/oap-mainapp', '/usr/lib/node_modules', '/var/opt/public/oap'];
    const files = [];
    const walk = (d, depth) => {
        if (files.length >= 300 || depth > 9) return;
        let ents = [];
        try { ents = fs.readdirSync(d); } catch (e) { return; }
        for (const n of ents) {
            const f = path.join(d, n);
            let st;
            try { st = fs.lstatSync(f); } catch (e) { continue; }
            if (st.isDirectory()) { if (!/^(data|rhmiData|resources|fonts|images|media|\.git)$/.test(n)) walk(f, depth + 1); }
            else if (/\.js$/.test(n) && st.size < 4 * 1024 * 1024 && files.length < 300) files.push(f);
        }
    };
    roots.forEach((r) => walk(r, 0));
    const names = {};
    const snippets = [];
    const RX = /\b(registerService|registerWodService|createWakeOnDemandService|build(?:Stub|Skeleton|Service|Provider)|createStub|createSkeleton|offerService|stopOfferService|registerService|offerEvent|offerField|fireEvent|fireSelectiveEvent|notifyEvent|setFieldValue|registerMethod|registerRequestHandler)\b/g;
    for (const f of files) {
        let txt;
        try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
        RX.lastIndex = 0;
        const has = RX.test(txt);
        RX.lastIndex = 0;
        if (txt.indexOf('buildProxy') < 0 && !has) continue;
        let mm;
        while ((mm = RX.exec(txt))) {
            names[mm[1]] = (names[mm[1]] || 0) + 1;
            if (snippets.length < 20) snippets.push(f + ': ...' + txt.slice(Math.max(0, mm.index - 140), mm.index + 160).replace(/\s+/g, ' ') + '...');
        }
        const bp = txt.indexOf('buildProxy');
        if (bp >= 0 && snippets.length < 24) snippets.push(f + ' (buildProxy): ...' + txt.slice(Math.max(0, bp - 200), bp + 300).replace(/\s+/g, ' ') + '...');
    }
    log('scan: ' + files.length + ' files; provider-like calls ' + show(names, 600));
    snippets.forEach((x) => log(x.slice(0, 900)));
    const k = Object.keys(names);
    return files.length + ' JS files, ' + (k.length ? k.map((n) => n + ' x' + names[n]).join(', ') : 'no provider-like calls');
}

if (require.main === module) {
    const lines = [];
    const sum = scanSdk((l) => lines.push(l));
    lines.forEach((l) => process.stdout.write(l.replace(/\n/g, ' ') + '\n'));
    process.stdout.write(sum + '\n');
}
module.exports = { scanSdk };
