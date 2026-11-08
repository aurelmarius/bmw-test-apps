'use strict';
/**
 * car_audio.js - stage 3: the receiver's sound on the car's speakers, through the audio manager.
 *
 * The receiver plays into SmartXbar's input for CarLife, source 287 (unused in Europe); the GENIVI audio manager
 * routes it to the main speakers, MediaSink_Front (1024), as Moonride does (its main.js, JustAnotherPU,
 * GPL-3.0-or-later): 287 is A_UNAVAILABLE without a CarLife phone and a connect to it would stay CS_CONNECTING for
 * ever, so it is marked available through the routing interface first; one connect while the sound is wanted, one
 * disconnect after it, in order; a 287 connection left by a crash or a power-off is cleared at start.
 *
 *   const audio = createCarAudio(ctx.signals, log);
 *   audio.want(true | false);     // the receiver has an iPhone with sound and the app is up
 *   audio.state()                 // { on, connected, error }
 */
const AM = 'org.genivi.am.commandinterface.CommandControl';
const AMR = 'org.genivi.am.routinginterface.RoutingControlObserver';
const SRC = 287, SINK = 1024;

function createCarAudio(signals, log) {
    const am = { p: null, r: null, id: null, on: false, q: Promise.resolve(), connected: false, error: null };
    // a fresh proxy answers "Service unavailable" until the provider is found: wait for it (max 5 s)
    async function proxy(iface) {
        const p = await signals.proxy(iface, '1');
        await new Promise((res) => { const t = setTimeout(res, 5000); signals.onAvailable(p, (a) => { if (a) { clearTimeout(t); res(); } }); });
        return p;
    }
    const avail = (on) => signals.call(am.r, 'hookSourceAvailablityStatusChange',
        { sourceID: SRC, availability: { availability: on ? 'A_AVAILABLE' : 'A_UNAVAILABLE', availabilityReason: 0 } })
        .then(() => log.info('car audio: source ' + (on ? 'available' : 'unavailable')), (e) => log.warn('car audio availability: ' + e));
    async function sweep() {
        const r = await signals.call(am.p, 'getListMainConnections', {});
        const list = Array.isArray(r) ? r : (r && Object.values(r).find(Array.isArray)) || [];
        for (const c of list.filter((x) => x && x.sourceID === SRC)) {
            log.info('car audio: leftover ' + c.mainConnectionID + ' ' + JSON.stringify(await signals.call(am.p, 'disconnect', { mainConnectionID: c.mainConnectionID })));
        }
    }
    async function ready() {
        if (am.p) return;
        am.p = await proxy(AM);
        am.r = await proxy(AMR);
        await sweep().catch((e) => log.warn('car audio sweep: ' + e));
    }
    // at start: what a crash or a power-off left goes
    am.q = am.q.then(async () => { await ready(); await avail(false); }).catch((e) => { am.error = String(e); log.warn('car audio start: ' + e); });

    function want(on) {
        if (on === am.on) return;
        am.on = on;
        am.q = am.q.then(async () => {
            await ready();
            if (on) {
                await avail(true);
                const r = await signals.call(am.p, 'connect', { sourceID: SRC, sinkID: SINK });
                const ok = r && (r.amError === 'E_OK' || r.amError === 'E_ALREADY_EXISTS' || r.amError === 0);
                am.id = ok && r.mainConnectionID != null ? r.mainConnectionID : null;
                am.connected = ok;
                am.error = ok ? null : 'connect refused: ' + JSON.stringify(r);
                log.info('car audio: connect ' + JSON.stringify(r));
            } else {
                if (am.id != null) {
                    log.info('car audio: disconnect ' + JSON.stringify(await signals.call(am.p, 'disconnect', { mainConnectionID: am.id })));
                    am.id = null;
                } else await sweep();
                am.connected = false;
                await avail(false);
            }
        }).catch((e) => { am.error = String(e); log.warn('car audio: ' + e); });
    }
    return { want, state: () => ({ on: am.on, connected: am.connected, error: am.error }) };
}

module.exports = { createCarAudio, SRC, SINK };
