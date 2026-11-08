'use strict';
/**
 * mirror_view.js - stage 2: the iPhone's mirrored screen over the whole centre screen.
 *
 * The receiver's GPU decoder writes the pictures to a frame file (/dev/shm/mgu-video-aurelm-airplay, owned by
 * nobody); this view names it to mgu-render on a connection of its own (mgu_render_client.js, from Moonride: the
 * native dialect, a layer over the whole screen, as Moonride's game screen) and draws it: black, then the newest
 * picture fitted in (aspect kept). The kit's page (the status) stays underneath.
 *
 * Shown while: the receiver test runs, the decoder writes pictures, the app's page is up, the car is PARKED
 * (parked.js strict: no speed, or a speed older than 5 s, counts as moving) and nobody hid it. A tap on it, or a
 * press or a push of the iDrive controller (grabbed while shown), hides it: the status page is back; "Start
 * receiver" shows it again.
 *
 *   const view = createMirrorView({ RenderClient, Recorder, appId, log, statIno });
 *   view.update({ rx, pageVisible, driving });   // each second and on every change
 *   view.wantAgain();                            // the user asked for the picture
 *   view.state()                                 // { shown, why }
 */
const VID = 1;
const KEEPALIVE_MS = 800;   // mgu-render hides an app silent for 3 s
const HINT_MS = 4000;       // how long "tap to return" stays over the picture

function createMirrorView(o) {
    const log = o.log || { info() {}, warn() {} };
    const now = o.now || Date.now;
    const gpu = new o.RenderClient(o.appId, log, { kit: o.kit });
    let shown = false, ino = null, path = null, rec = null, lastFrame = 0, userHid = false, why = 'not started', ready = false;
    let lastPress = 0, lastTilt = 0;

    gpu.on('ready', (screen, info) => {
        if (!info) { why = 'the renderer does not show videos (mgu-render/1 needed)'; ready = false; return; }
        ready = true;
        gpu.mode('layer');
        gpu.place({ x: 0, y: 0, w: screen.w, h: screen.h, scale: 1, ox: 0, oy: 0 });
        ino = null;   // the renderer forgot the video with the connection
        rec = null;
        log.info('mirror: mgu-render ' + screen.w + 'x' + screen.h + (info.video ? '' : ' (no video support)'));
    });
    gpu.on('close', () => { ino = null; ready = false; });
    const hide = (by) => {
        if (!shown) return;
        userHid = true;
        log.info('mirror: hidden by ' + by);
        apply(false);
    };
    gpu.on('touch', (phase) => { if (phase === 'down') hide('a tap'); return true; });
    gpu.on('ccu', (c) => {
        if (c.press && c.press !== lastPress) hide('the controller');
        else if (c.tilt && c.tilt !== lastTilt) hide('the controller');
        lastPress = c.press; lastTilt = c.tilt;
    });
    gpu.connect();

    let shownAt = 0, hinted = false;
    function frame() {
        const pl = gpu.placement;
        if (!pl) return;
        // the first seconds: how to get back, over the picture
        const hint = now() - shownAt < HINT_MS;
        if (!rec || hint !== hinted) {
            rec = new o.Recorder(pl.w, pl.h).clear(0x000000ff).video(VID, 0, 0, pl.w, pl.h, 0);
            if (hint) {
                rec.roundRect(pl.w / 2 - 330, pl.h - 96, 660, 60, 30, 0x000000b0);
                rec.text(o.hintText || 'Tap the screen or press a button to return', pl.w / 2, pl.h - 56, 26, 0xffffffff, { align: 'center', font: 'bold', literal: true });
            }
            hinted = hint;
        }
        gpu.frame(rec);
        lastFrame = now();
    }

    function apply(want) {
        if (want === shown) return;
        shown = want;
        if (!want) { gpu.video(VID, null); ino = null; }
        // touch and the controller are ours only while the picture is up: hidden, the HMI gets them all (CarPlay's tile)
        const pl = gpu.placement;
        gpu.claim(want && pl ? [{ x: 0, y: 0, w: pl.w, h: pl.h }] : []);
        gpu.grab(want);
        gpu.show(want);
        if (want) { shownAt = now(); rec = null; frame(); }
        log.info('mirror: ' + (want ? 'shown' : 'hidden'));
    }

    /** s: { rx (the service's status.rx), pageVisible, driving } */
    function update(s) {
        const rx = s.rx || null, dec = rx && rx.decoder;
        const pictures = !!(rx && rx.running && dec && dec.ok && rx.stream && rx.stream.shown > 0 && rx.videoRunning);
        if (!rx || !rx.running) why = 'the receiver is not running';
        else if (dec && !dec.ok) why = 'the GPU decoder failed: ' + dec.error;
        else if (!pictures) why = 'waiting for the picture';
        else if (s.driving) why = 'hidden while driving';
        else if (!s.pageVisible) why = 'the app is not in front';
        else if (!ready || !gpu.placement) why = 'waiting for mgu-render';
        else if (userHid) why = 'hidden: press "Start receiver" to show it again';
        else why = 'on the screen';
        if (!pictures) userHid = false;   // a new stream shows again
        const want = pictures && !s.driving && !!s.pageVisible && ready && !!gpu.placement && !userHid;
        path = (dec && dec.path) || path;
        if (want) {
            let cur = null;
            try { const st = o.statIno(path); cur = st; } catch (e) { cur = null; }
            if (cur === null) { apply(false); why = 'the frame file is missing'; return; }
            // a new frame file (the decoder opened it again): named again
            if (ino !== null && cur !== ino) gpu.video(VID, null);
            if (cur !== ino) gpu.video(VID, path);
            ino = cur;
        }
        apply(want);
        if (shown && (now() - lastFrame >= KEEPALIVE_MS || (hinted && now() - shownAt >= HINT_MS))) frame();
    }

    function wantAgain() { userHid = false; }
    function state() { return { shown, why }; }
    function close() { apply(false); try { gpu.close(); } catch (e) { /* closed */ } }

    return { update, wantAgain, state, close, gpu };
}

module.exports = { createMirrorView, VID };
