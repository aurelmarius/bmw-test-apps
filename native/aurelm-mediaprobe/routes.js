'use strict';
/**
 * routes.js - the probe's sound routes in the GENIVI audio manager, to the main speakers (sink 1024):
 *   287   SmartXbar's input for CarLife (unused in Europe), as myAirPlay, TVH Player and Emby play into it
 *         (apps/aurelm_emby/car_audio.js): marked available first through the routing interface, else a
 *         connect stays CS_CONNECTING for ever
 *   1046  the BMW MediaPlayer's source for online apps (instance OapGenericMedia), as RideTube plays
 *
 * Only our own connections are ever disconnected: their ids are kept in a file with the boot they were made in
 * (an id from before a restart may be another's now, so it is forgotten, never disconnected). A connection on
 * 287 that is not ours (another app playing) is left alone and the probe says so.
 *
 *   const r = createRoutes({ s, log, file });
 *   await r.connect(287 | 1046) -> { ok, id, detail }
 *   await r.disconnect(287 | 1046)
 *   await r.list()  -> the audio manager's main connections
 *   r.state()       -> { 287: { id }, 1046: { id } }
 */
const fs = require('fs');

const AM = 'org.genivi.am.commandinterface.CommandControl';
const AMR = 'org.genivi.am.routinginterface.RoutingControlObserver';
const SINK = 1024;
const CARLIFE = 287, OAP = 1046;

function createRoutes(opts) {
    const { s, log } = opts;
    const file = opts.file || null;
    const bootId = () => { try { return (opts.bootId ? opts.bootId() : fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); } catch (e) { return null; } };
    const ours = {};   // source -> mainConnectionID
    let q = Promise.resolve();
    const serial = (fn) => { const p = q.then(fn, fn); q = p.catch(() => {}); return p; };

    function save() {
        if (!file) return;
        try { fs.writeFileSync(file, JSON.stringify({ boot: bootId(), ours })); } catch (e) { /* not writable */ }
    }
    const am = () => s.proxy(AM, '1');
    async function list() {
        const p = await am();
        const r = await s.call(p, 'getListMainConnections', {});
        return Array.isArray(r) ? r : (r && Object.keys(r).map((k) => r[k]).find(Array.isArray)) || [];
    }
    const okErr = (r) => r && (r.amError === 'E_OK' || r.amError === 0 || r.amError === 'E_ALREADY_EXISTS');
    async function avail(on) {
        const p = await s.proxy(AMR, '1');
        return s.call(p, 'hookSourceAvailablityStatusChange',
            { sourceID: CARLIFE, availability: { availability: on ? 'A_AVAILABLE' : 'A_UNAVAILABLE', availabilityReason: 0 } });
    }

    /** a crash's leftovers from this boot: disconnected */
    function leftovers() {
        return serial(async () => {
            let saved = null;
            try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return; }
            if (!saved || saved.boot !== bootId()) { save(); return; }
            const now = await list();
            for (const src of Object.keys(saved.ours || {})) {
                const id = saved.ours[src];
                if (now.some((c) => c && c.mainConnectionID === id)) {
                    const p = await am();
                    log('route: our leftover ' + src + ' #' + id + ' disconnect ' + JSON.stringify(await s.call(p, 'disconnect', { mainConnectionID: id })));
                    if (Number(src) === CARLIFE) await avail(false).catch(() => {});
                }
            }
            save();
        });
    }

    function connect(src) {
        return serial(async () => {
            if (ours[src] != null) return { ok: true, id: ours[src], detail: 'already connected (#' + ours[src] + ')' };
            const other = (await list()).filter((c) => c && c.sourceID === src);
            if (src === CARLIFE && other.length) {
                return { ok: false, detail: '287 is in use by another app (#' + other.map((c) => c.mainConnectionID).join(', #') + '): stop it there first' };
            }
            if (src === CARLIFE) log('route: 287 available ' + JSON.stringify(await avail(true)));
            const p = await am();
            const r = await s.call(p, 'connect', { sourceID: src, sinkID: SINK });
            log('route: connect ' + src + ' -> ' + SINK + ' ' + JSON.stringify(r));
            if (!okErr(r) || r.mainConnectionID == null) {
                if (src === CARLIFE) await avail(false).catch(() => {});
                return { ok: false, detail: 'connect refused: ' + JSON.stringify(r) };
            }
            ours[src] = r.mainConnectionID;
            save();
            return { ok: true, id: r.mainConnectionID, detail: 'connected #' + r.mainConnectionID + ' (' + r.amError + ')' };
        });
    }

    function disconnect(src) {
        return serial(async () => {
            const id = ours[src];
            if (id == null) return { ok: true, detail: 'not connected' };
            delete ours[src];
            save();
            const p = await am();
            const r = await s.call(p, 'disconnect', { mainConnectionID: id }).catch((e) => String(e));
            log('route: disconnect ' + src + ' #' + id + ' ' + JSON.stringify(r));
            if (src === CARLIFE) {
                const left = (await list().catch(() => [])).filter((c) => c && c.sourceID === CARLIFE && c.mainConnectionID !== id);
                if (!left.length) log('route: 287 unavailable ' + JSON.stringify(await avail(false).catch((e) => String(e))));
            }
            return { ok: true, detail: 'disconnected #' + id };
        });
    }

    return { connect, disconnect, list, leftovers, state: () => ({ 287: ours[CARLIFE] != null ? ours[CARLIFE] : null, 1046: ours[OAP] != null ? ours[OAP] : null }) };
}

module.exports = { createRoutes, CARLIFE, OAP, SINK, AM, AMR };
