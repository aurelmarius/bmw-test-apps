'use strict';
/**
 * playback.js - the channel that plays: its stream from Tvheadend with a stream profile, the player's state, the
 * profile lowered when the internet is slow. Runs in the TVH client (client.js, uid 13101: the internet); the
 * player itself (tvh-player, started by the root service) gets the stream through `sink`.
 *
 *   const pb = createPlayback({ tvh, log, now, sink, profiles: () => names | null });
 *   pb.play(channel)      { uuid, name, number }: another channel is a new stream and a new player
 *   pb.stop()             ends it
 *   pb.setPrefs({ profile, adaptive })
 *   pb.onPlayer(id, ev)   the player's events (open, decoder, audio, tick, end, error, exit), stream id first
 *   pb.status()           for the app
 *   sink: { start(id), data(id, buf) -> bool (false: wait for drain), end(id), drain(id, fn), ctl(id, line), stop(id) }
 *
 * The stream: /stream/channel/<uuid>?profile=<profile>, MPEG-TS. The server's profiles for the car (mgu-hd, mgu-sd,
 * mgu-low: H.264 progressive, deinterlaced by the server's VAAPI, with AAC) are a ladder, best first: with
 * "lower the quality by itself" on, the stream running dry (the player "buffering") twice within a minute, or for 8 s
 * at once, goes on with the next profile down (a new stream of the same channel); 5 minutes without running dry, one
 * back up, never above the setting; 30 s at least between two steps. A profile the server does not have is passed
 * over. A stream that ends or breaks (live TV never ends) is opened again, 3 times, 2 s apart.
 */
const LADDER = ['mgu-hd', 'mgu-sd', 'mgu-low'];
const STALL_WINDOW_MS = 60000;
const STALLS = 2;
const STALL_LONG_MS = 8000;
const SWITCH_COOLDOWN_MS = 30000;
const RETRIES = 3;

/** the kit's fonts have ASCII only: Romanian and other accented letters as ASCII (ș -> s) */
const ASCII = { 'ș': 's', 'ş': 's', 'Ș': 'S', 'Ş': 'S', 'ț': 't', 'ţ': 't', 'Ț': 'T', 'Ţ': 'T', '„': '"', '“': '"', '”': '"', '«': '"', '»': '"',
    '‘': "'", '’': "'", '‚': "'", '–': '-', '—': '-', '…': '...', ' ': ' ', 'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'ø': 'o', 'Ø': 'O',
    'œ': 'oe', 'Œ': 'OE', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D' };
function ascii(s) {
    return String(s == null ? '' : s).replace(/[\s\S]/g, (ch) => (ASCII[ch] !== undefined ? ASCII[ch] : ch)).normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^\x20-\x7e]/g, '');
}

/** the ladder this server has, from the setting down; [setting] alone when the profiles are unknown or not mgu-* */
function ladderFor(setting, have) {
    if (!have) return [setting];
    const i = LADDER.indexOf(setting);
    if (i < 0) return [setting];
    return LADDER.slice(i).filter((p) => have.indexOf(p) >= 0);
}

function createPlayback(o) {
    const log = o.log || (() => {});
    const now = o.now || Date.now;
    const tvh = o.tvh, sink = o.sink;
    const retryMs = o.retryMs != null ? o.retryMs : 2000;
    const upAfterMs = o.adaptUpMs || 300000;
    const prefs = { profile: 'mgu-hd', adaptive: true };
    let cur = null, ids = 0;
    const st = { state: 'idle', phase: null, phaseAt: null, error: null, at: now() };

    function set(state, error) { st.state = state; st.error = error || null; st.at = now(); if (state !== 'loading') st.phase = null; }
    function phase(p) { st.phase = p; st.phaseAt = now(); }

    function ladder() { const l = ladderFor(prefs.profile, o.profiles ? o.profiles() : null); return l.length ? l : [prefs.profile]; }

    /* ---------- the stream ---------- */
    async function open(c, why) {
        const id = ++ids;
        c.id = id; c.stream = null; c.player = { state: 'starting', fields: 0, interlaced: false };
        c.openedAt = now();
        set('loading'); phase('stream');
        log('stream ' + id + ': ' + c.ch.name + ' with ' + c.profile + (why ? ' (' + why + ')' : ''));
        let r;
        try { r = await tvh.stream(c.ch.uuid, c.profile); }
        catch (e) { return broke(c, id, e.message); }
        if (cur !== c || c.id !== id) { try { r.res.resume(); r.abort(); } catch (e) { /* gone */ } return; }
        if (r.status !== 200) {
            r.res.resume(); r.abort();
            const why2 = r.status === 401 || r.status === 403 ? 'the server refused the user (' + r.status + '): the streaming right, or this profile'
                : r.status === 404 ? 'the server has no such channel, or no profile "' + c.profile + '"'
                    : r.status === 503 ? 'no free tuner for this channel (503)' : 'HTTP ' + r.status;
            log('stream ' + id + ': ' + why2);
            if (r.status === 503 || r.status >= 500) return broke(c, id, why2);
            return fail(c, why2);
        }
        c.stream = r;
        c.bytes = 0;
        phase('player');
        sink.start(id);
        const res = r.res;
        res.on('data', (d) => {
            if (cur !== c || c.id !== id) return;
            c.bytes += d.length;
            if (!sink.data(id, d)) { res.pause(); sink.drain(id, () => { if (cur === c && c.id === id) res.resume(); }); }
        });
        const ended = (what) => {
            if (cur !== c || c.id !== id || c.closing) return;
            sink.end(id);
            broke(c, id, what);
        };
        res.on('end', () => ended('the stream ended'));
        res.on('error', (e) => ended('the stream broke: ' + e.message));
        res.on('aborted', () => ended('the server closed the stream'));
    }
    /** a stream that could not open or broke: opened again (3 times), then an error */
    function broke(c, id, why) {
        if (cur !== c || c.id !== id) return;
        close(c);
        if (c.tries >= RETRIES) return fail(c, why);
        c.tries++;
        c.reconnects++;
        log('stream ' + id + ': ' + why + '; again in ' + retryMs / 1000 + ' s (' + c.tries + '/' + RETRIES + ')');
        set('loading'); phase('retry'); st.error = why;
        setTimeout(() => { if (cur === c && !c.closing) open(c, 'again: ' + why); }, retryMs);
    }
    function fail(c, why) {
        if (cur !== c) return;
        close(c);
        set('error', why);
    }
    /** the stream and its player end (the stream id is left: its bytes still in the pipe are dropped) */
    function close(c) {
        if (c.stream) { try { c.stream.abort(); } catch (e) { /* gone */ } c.stream = null; }
        if (c.id) sink.stop(c.id);
        c.id = 0;   // its player's last events (its exit) are no longer ours
    }

    /* ---------- the quality ---------- */
    function adapt(c, state) {
        const t = now();
        if (state === 'buffering' && c.lastState !== 'buffering') { c.stalls.push(t); c.stallSince = t; }
        if (state !== 'buffering') c.stallSince = 0;
        if (state === 'buffering') c.cleanSince = t;
        c.lastState = state;
        c.stalls = c.stalls.filter((x) => t - x < STALL_WINDOW_MS);
        if (!prefs.adaptive || t - c.switchedAt < SWITCH_COOLDOWN_MS) return false;
        const l = ladder(), i = l.indexOf(c.profile);
        const down = i >= 0 && i + 1 < l.length ? l[i + 1] : null, up = i > 0 ? l[i - 1] : null;
        if (down && (c.stalls.length >= STALLS || (c.stallSince && t - c.stallSince >= STALL_LONG_MS))) {
            step(c, down, c.stalls.length >= STALLS ? 'the stream ran dry ' + c.stalls.length + ' times in a minute' : 'the stream ran dry for ' + Math.round((t - c.stallSince) / 1000) + ' s');
            return true;
        }
        if (up && state === 'playing' && t - c.cleanSince >= upAfterMs) { step(c, up, Math.round(upAfterMs / 60000) + ' minutes without running dry'); return true; }
        return false;
    }
    function step(c, profile, why) {
        log('quality: ' + c.profile + ' -> ' + profile + ' (' + why + ')');
        c.profile = profile; c.switchedAt = now(); c.cleanSince = now(); c.stalls = []; c.stallSince = 0; c.tries = 0;
        close(c);
        open(c, why);
    }
    function setPrefs(p) {
        const profile = p && p.profile ? String(p.profile) : prefs.profile;
        const adaptive = p && p.adaptive !== undefined ? !!p.adaptive : prefs.adaptive;
        if (profile === prefs.profile && adaptive === prefs.adaptive) return;
        prefs.profile = profile; prefs.adaptive = adaptive;
        log('quality: ' + profile + (adaptive ? ', lower when the internet is slow' : ', fixed'));
        // what plays goes on with the new setting (fixed: the setting itself; adaptive: never above it)
        const c = cur;
        if (!c) return;
        const l = ladder();
        const want = adaptive && l.indexOf(c.profile) >= 0 ? c.profile : l[0];
        if (want !== c.profile) step(c, want, 'the setting');
    }

    /* ---------- what plays ---------- */
    function play(ch) {
        if (!ch || !ch.uuid) return;
        if (cur) { cur.closing = true; close(cur); }
        const l = ladder();
        const c = { ch: { uuid: ch.uuid, name: ascii(ch.name), number: ch.number != null ? ch.number : null }, profile: l[0], tries: 0, reconnects: 0,
            stalls: [], stallSince: 0, cleanSince: now(), switchedAt: 0, lastState: null, startedAt: now(), id: 0 };
        cur = c;
        open(c, null);
    }
    function stop() {
        const c = cur;
        cur = null;
        if (c) { c.closing = true; close(c); log('stopped ' + c.ch.name); }
        set('idle');
    }

    function onPlayer(id, ev) {
        const c = cur;
        if (!c || c.id !== id || !ev) return;
        if (ev.ev === 'open') {
            c.player.video = ev.video || null; c.player.audioCodec = ev.audio ? ev.audio.codec : null;
            if (ev.video && ev.video.interlaced) { c.player.interlaced = true; log('stream ' + id + ': interlaced: profile ' + c.profile + ' does not deinterlace'); }
        } else if (ev.ev === 'audio' && ev.ok === false) c.player.audioError = ev.error;
        else if (ev.ev === 'error') c.player.error = ev.error;
        else if (ev.ev === 'tick') {
            const s = ev.state === 'starting' ? 'loading' : ev.state;
            c.player.state = ev.state; c.player.fields = ev.fields || 0; c.player.buffered = ev.buffered;
            if (ev.fields > 0) c.player.interlaced = true;
            if (s === 'playing' || s === 'buffering') {
                if (st.state !== s) set(s);
                if (s === 'playing') c.tries = 0;
                adapt(c, s);
            }
        } else if (ev.ev === 'end' || ev.ev === 'exit') {
            // the player went while its stream is still on: a picture or sound it cannot play, or a crash
            if (c.closing) return;
            const why = c.player.error || (ev.ev === 'exit' ? 'the player ended (' + (ev.signal || 'code ' + ev.code) + ')' : 'the player ended');
            if (c.player.error) return fail(c, why);
            if (ev.ev === 'exit') broke(c, id, why);
        }
    }

    function status() {
        const c = cur;
        return Object.assign({}, st, {
            channel: c ? c.ch : null, profile: c ? c.profile : null, setting: prefs.profile, adaptive: prefs.adaptive, ladder: ladder(),
            lowered: !!(c && c.profile !== ladder()[0]), reconnects: c ? c.reconnects : 0, since: c ? c.startedAt : null,
            kbytes: c && c.bytes ? Math.round(c.bytes / 1024) : 0,
            video: c && c.player.video ? c.player.video : null, interlaced: !!(c && c.player.interlaced), fields: c ? c.player.fields : 0,
            audioError: c ? c.player.audioError || null : null, buffered: c ? c.player.buffered : null,
        });
    }

    return { play, stop, setPrefs, onPlayer, status };
}

module.exports = { createPlayback, LADDER, ladderFor, ascii };
