'use strict';
/**
 * playback.js - what the head unit plays when the Emby app casts to it: the queue, the stream from the server, the
 * reports back. Runs in the Emby client (client.js, uid 13101: the internet); the player itself (emby-player,
 * started by the root service) gets the stream through `sink`.
 *
 *   const pb = createPlayback({ api, nx, account, device, log, now, sink, bitrate });
 *   pb.play(data)        a Play message (PlayNow / PlayNext / PlayLast)
 *   pb.playstate(data)   a Playstate message (Stop, Pause, Unpause, PlayPause, Seek, NextTrack, PreviousTrack, Rewind, FastForward)
 *   pb.command(data)     a GeneralCommand (SetVolume, VolumeUp/Down, Mute, Unmute, ToggleMute, SetAudioStreamIndex,
 *                        SetSubtitleStreamIndex)
 *   pb.onPlayer(id, ev)  the player's events (open, decoder, audio, tick, end, error, exit), stream id first
 *   pb.stop()            ends what plays (reported Stopped), e.g. at sign-out
 *   pb.status()          for the app
 *   sink: { start(id), data(id, buf) -> bool (false: wait for drain), end(id), drain(id, fn), ctl(id, line), stop(id) }
 *
 * The stream: PlaybackInfo with our profile (DEVICE_PROFILE: H.264 up to 1080p, 8 bits, progressive, square pixels;
 * AAC or AC-3 up to 6 channels; subtitles burned in), so the server sends what fits as it is (remuxed) and
 * transcodes the rest, always as MPEG-TS over plain HTTP(S), from StartTimeTicks. A seek, another audio or subtitle
 * track, or a lost connection is a new stream from the position. Reports: Sessions/Playing at the start,
 * /Progress every 10 s and at pause, unpause, volume, /Stopped at the end; the transcode is stopped
 * (Videos/ActiveEncodings) when its stream is left.
 */
const TICKS = 10000000;
const PROGRESS_MS = 10000;
const RETRIES = 3;

/** Emby's device profile: what emby-player plays (H.264 on the GPU, AAC / AC-3 / E-AC-3 with libavcodec) */
function deviceProfile(bitrate) {
    return {
        Name: 'BMW iDrive',
        MaxStreamingBitrate: bitrate, MaxStaticBitrate: bitrate, MusicStreamingTranscodingBitrate: 192000,
        // nothing is fetched as a file: the player reads one MPEG-TS stream, which the server makes (remux or transcode)
        DirectPlayProfiles: [],
        TranscodingProfiles: [
            { Container: 'ts', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac,ac3', Protocol: 'http', Context: 'Streaming',
                MaxAudioChannels: '6', BreakOnNonKeyFrames: false, CopyTimestamps: false },
            { Container: 'ts', Type: 'Audio', AudioCodec: 'aac', Protocol: 'http', Context: 'Streaming', MaxAudioChannels: '2' },
        ],
        ContainerProfiles: [],
        CodecProfiles: [
            { Type: 'Video', Codec: 'h264', Conditions: [
                { Condition: 'LessThanEqual', Property: 'Width', Value: '1920', IsRequired: true },
                { Condition: 'LessThanEqual', Property: 'Height', Value: '1080', IsRequired: true },
                { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: true },
                { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '51', IsRequired: false },
                { Condition: 'EqualsAny', Property: 'VideoProfile', Value: 'high|main|baseline|constrained baseline', IsRequired: false },
                { Condition: 'NotEquals', Property: 'IsInterlaced', Value: 'true', IsRequired: false },
                { Condition: 'NotEquals', Property: 'IsAnamorphic', Value: 'true', IsRequired: false },
            ] },
            { Type: 'VideoAudio', Codec: 'aac,ac3', Conditions: [
                { Condition: 'LessThanEqual', Property: 'AudioChannels', Value: '6', IsRequired: false },
            ] },
        ],
        // text subtitles come apart (External) and the app draws them over the picture: burned in, they cost the server a
        // whole transcode, and 0.2.4 in the car got HTTP 500 for a 4K Dolby Vision film with Romanian SubRip burned in;
        // picture subtitles (PGS, DVD, DVB) can only be burned in
        SubtitleProfiles: TEXT_SUBS.map((f) => ({ Format: f, Method: 'External' }))
            .concat(['pgs', 'pgssub', 'dvdsub', 'dvbsub', 'sub'].map((f) => ({ Format: f, Method: 'Encode' }))),
        ResponseProfiles: [],
    };
}

const TEXT_SUBS = ['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'smi', 'ttml', 'mov_text'];

/** HH:MM:SS,mmm -> seconds */
function srtTime(t) {
    const m = /(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/.exec(t);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number((m[4] + '00').slice(0, 3)) / 1000 : null;
}
/** the kit's fonts have ASCII only: Romanian and other accented letters, typographic quotes and dashes as ASCII */
const ASCII = { 'ș': 's', 'ş': 's', 'Ș': 'S', 'Ş': 'S', 'ț': 't', 'ţ': 't', 'Ț': 'T', 'Ţ': 'T', '„': '"', '“': '"', '”': '"', '«': '"', '»': '"',
    '‘': "'", '’': "'", '‚': "'", '–': '-', '—': '-', '…': '...', ' ': ' ', 'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'ø': 'o', 'Ø': 'O',
    'œ': 'oe', 'Œ': 'OE', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D' };
function ascii(s) {
    return String(s).replace(/[\s\S]/g, (ch) => (ASCII[ch] !== undefined ? ASCII[ch] : ch)).normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^\x20-\x7e\n]/g, '');
}
/** SubRip text -> [{ s, e, t }] (seconds; the lines without tags, in ASCII), sorted */
function parseSrt(text) {
    const out = [];
    String(text).replace(/^﻿/, '').replace(/\r/g, '').split(/\n\s*\n/).forEach((block) => {
        const lines = block.split('\n').filter((l) => l.trim() !== '');
        const i = lines.findIndex((l) => l.indexOf('-->') >= 0);
        if (i < 0) return;
        const parts = lines[i].split('-->');
        const st = srtTime(parts[0]), en = srtTime(parts[1]);
        if (st == null || en == null || en <= st) return;
        const t = lines.slice(i + 1).join('\n').replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '').trim();
        if (t) out.push({ s: st, e: en, t: ascii(t) });
    });
    out.sort((x, y) => x.s - y.s);
    return out;
}
const isText = (x) => !!x && (x.DeliveryMethod === 'External' || TEXT_SUBS.indexOf(String(x.Codec || '').toLowerCase()) >= 0) && x.DeliveryMethod !== 'Encode';

/** url with `key` set to `value` (replaced if there, case-insensitive) */
function setParam(u, key, value) {
    const i = u.indexOf('?');
    const base = i < 0 ? u : u.slice(0, i);
    const q = (i < 0 ? '' : u.slice(i + 1)).split('&').filter((p) => p && p.split('=')[0].toLowerCase() !== key.toLowerCase());
    q.push(key + '=' + encodeURIComponent(value));
    return base + '?' + q.join('&');
}

/** a stream's address for the log: its path and what it asks the server for, without the token */
function describeUrl(u) {
    const i = u.indexOf('?');
    const path = (i < 0 ? u : u.slice(0, i)).replace(/^https?:\/\/[^/]+/, '');
    const keep = ['VideoCodec', 'AudioCodec', 'MaxWidth', 'MaxHeight', 'VideoBitrate', 'AudioBitrate', 'MaxAudioChannels', 'TranscodeReasons', 'SubtitleMethod'];
    const q = (i < 0 ? '' : u.slice(i + 1)).split('&').filter((p) => keep.indexOf(p.split('=')[0]) >= 0);
    return path + (q.length ? ' ' + decodeURIComponent(q.join(' ')) : '');
}

function createPlayback(o) {
    const log = o.log || (() => {});
    const now = o.now || Date.now;
    const api = o.api;           // (method, path, body) -> Promise<json>
    const sink = o.sink;
    const bitrate = o.bitrate || 8000000;
    const account = () => o.account();
    let streamId = 0;
    const q = { ids: [], index: 0 };
    let cur = null;              // the item playing: see begin()
    let volume = 100, muted = false;
    let progressTimer = null;
    const st = { state: 'idle', error: null, at: now(), phase: null, phaseAt: null };
    /** what a starting stream waits for, for the page: 'item', 'server' (PlaybackInfo), 'stream' (the head of the
     *  server's answer: a heavy transcode starts slowly), 'player' */
    function phase(p) { st.phase = p; st.phaseAt = now(); if (p !== 'stream') st.serverSays = null; }

    /** the newest transcode log of the server, its error lines (or its last ones); null when there is none to read
     *  (the logs are an administrator's: another account gets a sentence saying so) */
    async function serverLog() {
        const lines = await serverLogLines(/transcode/i);
        if (!Array.isArray(lines)) return lines;
        const bad = lines.filter((l) => /error|fail|invalid|unsupported|not supported|could not|cannot|impossible|no such|conversion/i.test(l));
        return (bad.length ? bad.slice(-4) : lines.slice(-3)).map((l) => l.slice(0, 300)).join('\n');
    }
    /** the lines of the server's newest log whose name matches; a sentence when they cannot be read (an
     *  administrator's), null when there is none */
    async function serverLogLines(nameRe) {
        let list;
        try { list = await api('GET', 'System/Logs'); }
        catch (e) { return e.code === 'EAUTH' ? 'its log needs an administrator account to be read from here' : null; }
        const items = (Array.isArray(list) ? list : (list && list.Items) || []).filter((x) => x && nameRe.test(x.Name || ''));
        items.sort((a, b) => Date.parse(b.DateModified || 0) - Date.parse(a.DateModified || 0));
        if (!items[0] || !o.apiText) return null;
        let r = null;
        for (const p of ['System/Logs/' + encodeURIComponent(items[0].Name), 'System/Logs/Log?name=' + encodeURIComponent(items[0].Name)]) {
            try { r = await o.apiText(p); } catch (e) { r = null; }
            if (r && r.status === 200 && r.text) break;
            r = null;
        }
        return r ? r.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : null;
    }
    /** a command came and no film followed (cast during a film on the phone, 0.3.0): what the server's own log says
     *  about our session in the last minute, in our log */
    async function castLog(sessionId) {
        const lines = await serverLogLines(/^embyserver/i);
        if (!Array.isArray(lines)) { if (lines) log('server log: ' + lines); return; }
        const ours = lines.slice(-400).filter((l) => (sessionId && l.indexOf(sessionId) >= 0) || /BMW iDrive|PlayMediaSource|\/Playing|Sessions\/[0-9a-f]+\/(Command|Playing)/i.test(l)).slice(-6);
        if (!ours.length) log('server log: nothing about this session');
        ours.forEach((l) => log('server log: ' + l.slice(0, 260)));
    }

    function status() {
        return Object.assign({}, st, {
            serverSays: st.serverSays || null,
            item: cur ? cur.info : null, pos: cur ? position() : null, dur: cur && cur.info ? cur.info.seconds : null,
            posAt: cur ? cur.tAt || null : null,
            subs: cur && cur.subs ? { key: cur.subs.key, count: cur.subs.count, lang: cur.subs.lang, error: cur.subs.error || null } : null,
            paused: cur ? cur.paused : false, playMethod: cur ? cur.playMethod : null, volume, muted,
            queue: { index: q.index, length: q.ids.length }, player: cur ? cur.player : null,
            audioIndex: cur ? cur.audioIndex : null, subtitleIndex: cur ? cur.subtitleIndex : null,
        });
    }
    function set(state, error) { st.state = state; st.error = error || null; st.at = now(); if (state !== 'loading') st.phase = null; }
    function position(c) {
        c = c || cur;
        if (!c) return 0;
        const p = c.start + (c.t || 0);
        return c.info && c.info.seconds ? Math.min(p, c.info.seconds) : p;
    }

    /* ---------- reports ---------- */
    function body(c, extra) {
        return Object.assign({
            ItemId: c.id, MediaSourceId: c.mediaSourceId, PlaySessionId: c.playSessionId,
            PositionTicks: Math.round(position(c) * TICKS), IsPaused: !!c.paused, IsMuted: muted, VolumeLevel: volume,
            CanSeek: true, PlayMethod: c.playMethod, AudioStreamIndex: c.audioIndex, SubtitleStreamIndex: c.subtitleIndex,
            PlaylistIndex: q.index, PlaylistLength: q.ids.length, RepeatMode: 'RepeatNone',
            QueueableMediaTypes: ['Video', 'Audio'],
            NowPlayingQueue: q.ids.map((id, i) => ({ Id: id, PlaylistItemId: 'playlistItem' + i })),
        }, extra || {});
    }
    function report(what, extra, c) {
        c = c || cur;
        if (!c || !c.playSessionId) return Promise.resolve();
        const path = what === 'start' ? 'Sessions/Playing' : what === 'stop' ? 'Sessions/Playing/Stopped' : 'Sessions/Playing/Progress';
        const b = body(c, what === 'progress' ? extra : null);
        return api('POST', path, b).catch((e) => log('report ' + what + ': ' + e.message));
    }
    function progressLoop() {
        clearInterval(progressTimer);
        progressTimer = setInterval(() => { if (cur && cur.reported) report('progress', { EventName: 'timeupdate' }); }, PROGRESS_MS);
    }

    /* ---------- the stream ---------- */
    async function playbackInfo(c, startSec) {
        const acc = account();
        const qs = ['UserId=' + encodeURIComponent(acc.userId), 'StartTimeTicks=' + Math.round(startSec * TICKS), 'IsPlayback=true',
            'AutoOpenLiveStream=true', 'MaxStreamingBitrate=' + bitrate];
        if (c.audioIndex != null) qs.push('AudioStreamIndex=' + c.audioIndex);
        if (c.subtitleIndex != null) qs.push('SubtitleStreamIndex=' + c.subtitleIndex);
        if (c.mediaSourceId) qs.push('MediaSourceId=' + encodeURIComponent(c.mediaSourceId));
        const info = await api('POST', 'Items/' + encodeURIComponent(c.id) + '/PlaybackInfo?' + qs.join('&'), {
            DeviceProfile: deviceProfile(bitrate), StartTimeTicks: Math.round(startSec * TICKS), IsPlayback: true, AutoOpenLiveStream: true,
            MaxStreamingBitrate: bitrate, AudioStreamIndex: c.audioIndex, SubtitleStreamIndex: c.subtitleIndex, MediaSourceId: c.mediaSourceId,
            UserId: acc.userId,
        });
        if (info && info.ErrorCode) throw new Error('the server will not play it: ' + info.ErrorCode);
        const srcs = (info && info.MediaSources) || [];
        const src = srcs.filter((s) => s.Id === c.mediaSourceId)[0] || srcs[0];
        if (!src) throw new Error('the server offers no media source');
        let u = src.TranscodingUrl;
        let method = 'Transcode';
        if (!u) {
            // no transcode offered (it fits as it is): the server's stream endpoint, remuxed into MPEG-TS
            u = '/' + (c.type === 'Audio' ? 'Audio' : 'Videos') + '/' + encodeURIComponent(c.id) + '/stream.ts?MediaSourceId=' + encodeURIComponent(src.Id) +
                '&PlaySessionId=' + encodeURIComponent(info.PlaySessionId || '') + '&DeviceId=' + encodeURIComponent(o.device.id) +
                '&api_key=' + encodeURIComponent(acc.token) + '&VideoCodec=h264&AudioCodec=aac,ac3&MaxAudioChannels=6';
            method = 'DirectStream';
        }
        u = setParam(u, 'StartTimeTicks', Math.round(startSec * TICKS));
        const subs = (src.MediaStreams || []).filter((x) => x.Type === 'Subtitle');
        return { url: acc.server + (u[0] === '/' ? '' : '/') + u, playSessionId: info.PlaySessionId || null, mediaSourceId: src.Id,
            playMethod: method, reasons: src.TranscodeReasons || null, subs,
            defaultSub: src.DefaultSubtitleStreamIndex != null ? src.DefaultSubtitleStreamIndex : -1 };
    }

    /** the subtitle stream `index` of the current media source, or null */
    function subStream(c, index) {
        if (index == null || index < 0) return null;
        return (c.subStreams || []).filter((x) => x.Index === index)[0] || null;
    }
    /** the chosen text subtitles (as SubRip, from the server), parsed, for the app to draw; none: cleared */
    function loadSubs(c) {
        const x = subStream(c, c.subtitleIndex);
        if (!x || !isText(x)) {
            c.subs = null;
            if (o.onSubs) o.onSubs(null, []);
            return;
        }
        const key = c.id + ':' + c.mediaSourceId + ':' + x.Index;
        if (c.subs && c.subs.key === key && !c.subs.error) return;
        c.subs = { key, count: 0, lang: x.DisplayTitle || x.Language || null, error: null };
        // the server converts any text format to SubRip at its .srt address
        let u = x.DeliveryUrl || ('/Videos/' + encodeURIComponent(c.id) + '/' + encodeURIComponent(c.mediaSourceId) + '/Subtitles/' + x.Index + '/0/Stream.srt');
        u = u.replace(/^https?:\/\/[^/]+/, '').replace(/\/Stream\.\w+/, '/Stream.srt');
        const fetch = o.apiText ? o.apiText(u.replace(/^\//, '')) : Promise.reject(new Error('no text API'));
        fetch.then((r) => {
            if (cur !== c || !c.subs || c.subs.key !== key) return;
            if (r.status !== 200) throw new Error('HTTP ' + r.status);
            const cues = parseSrt(r.text);
            c.subs.count = cues.length;
            log('subtitles: ' + (c.subs.lang || x.Index) + ', ' + cues.length + ' lines');
            if (o.onSubs) o.onSubs(key, cues);
        }).catch((e) => {
            if (cur !== c || !c.subs || c.subs.key !== key) return;
            c.subs.error = e.message;
            log('subtitles: ' + e.message);
        });
    }

    /** the transcode behind a stream we leave: stopped on the server */
    function stopEncoding(playSessionId) {
        if (!playSessionId) return Promise.resolve();
        return api('DELETE', 'Videos/ActiveEncodings?DeviceId=' + encodeURIComponent(o.device.id) + '&PlaySessionId=' + encodeURIComponent(playSessionId))
            .catch((e) => log('stop encoding: ' + e.message));
    }

    /** a new stream of cur from startSec (the start, a seek, another track, after a lost connection) */
    async function openStream(startSec, why) {
        const c = cur;
        const id = ++streamId;
        const had = !!c.streamId;
        if (had) closeStream(c);
        c.start = startSec; c.t = 0; c.streamId = id; c.ended = false; c.player = null;
        set('loading');
        phase('server');
        let s;
        try {
            // the stream left (a seek): its transcode ends first, so the server starts the new one from the position
            if (had) await stopEncoding(c.playSessionId);
            if (cur !== c || c.streamId !== id) return;
            s = await playbackInfo(c, startSec);
            if (cur !== c || c.streamId !== id) return;
            if (!had && s.playSessionId !== c.playSessionId) stopEncoding(c.playSessionId);
            Object.assign(c, { playSessionId: s.playSessionId, mediaSourceId: s.mediaSourceId, playMethod: s.playMethod, reasons: s.reasons, subStreams: s.subs });
            if (c.subtitleIndex == null) c.subtitleIndex = s.defaultSub;
            loadSubs(c);
            log('stream ' + id + ' (' + why + '): ' + s.playMethod + (s.reasons ? ' (' + [].concat(s.reasons).join(', ') + ')' : '') + ' from ' + Math.round(startSec) + ' s');
            log('stream ' + id + ': ' + describeUrl(s.url));
            const acc = account();
            phase('stream');
            const asked = now();
            // no first bytes after 20 s: what the server's transcoder says (its newest log), in our log and on the page
            const look = setTimeout(() => {
                if (cur !== c || c.streamId !== id || st.phase !== 'stream') return;
                serverLog().then((t) => {
                    if (!t || cur !== c || c.streamId !== id) return;
                    st.serverSays = t;
                    t.split('\n').forEach((l) => log('server transcoder: ' + l));
                });
            }, o.serverLogAfterMs || 20000);
            let r;
            // a transcode the server finds heavy (4K, HDR) can take long to send its first bytes
            try { r = await o.nx.stream({ url: s.url, headers: { 'X-Emby-Token': acc.token, Accept: '*/*' }, timeoutMs: 90000 }); }
            catch (e) { if (e.code === 'ETIMEDOUT' && st.serverSays) e.message += ' (the server\'s transcoder: ' + st.serverSays.split('\n').pop() + ')'; throw e; }
            finally { clearTimeout(look); }
            if (cur !== c || c.streamId !== id) { r.abort(); return; }
            log('stream ' + id + ': HTTP ' + r.status + ' ' + (r.headers['content-type'] || '') + ' after ' + ((now() - asked) / 1000).toFixed(1) + ' s');
            if (r.status < 200 || r.status >= 300) {
                r.res.resume();
                // the transcoder failed: what it says (an administrator's log)
                const says = r.status >= 500 ? await serverLog().catch(() => null) : null;
                if (says) { st.serverSays = says; says.split('\n').forEach((l) => log('server transcoder: ' + l)); }
                throw new Error('the server\'s stream: HTTP ' + r.status + (says ? ' (' + says.split('\n').pop() + ')' : ''));
            }
            phase('player');
            c.stream = r;
            sink.start(id);
            if (c.paused) sink.ctl(id, 'pause');
            sink.ctl(id, 'volume ' + (muted ? 0 : volume / 100));
            let aborted = false;
            r.res.on('aborted', () => { aborted = true; });
            r.res.on('data', (d) => {
                if (c.stream !== r) return;
                if (!sink.data(id, d)) { r.res.pause(); sink.drain(id, () => { if (c.stream === r) r.res.resume(); }); }
            });
            r.res.on('end', () => { if (c.stream === r) { c.httpDone = aborted ? 'aborted' : 'end'; sink.end(id); } });
            r.res.on('error', (e) => { if (c.stream === r) { c.httpDone = 'error: ' + e.message; sink.end(id); } });
            c.httpDone = null;
            if (!c.reported) { c.reported = true; report('start'); progressLoop(); }
            else report('progress', { EventName: 'timeupdate' });
        } catch (e) {
            if (cur !== c || c.streamId !== id) return;
            log('stream: ' + e.message);
            set('error', e.message);
            if (e.code === 'EAUTH' && o.onAuth) o.onAuth(e);
        }
    }
    function closeStream(c) {
        const r = c.stream;
        c.stream = null;
        if (r) r.abort();
        if (c.streamId) sink.stop(c.streamId);
    }

    /** ends the current item: its stream, the player, the report */
    function finish(why) {
        const c = cur;
        if (!c) return;
        cur = null;
        clearInterval(progressTimer);
        closeStream(c);
        if (c.reported) report('stop', null, c);
        stopEncoding(c.playSessionId);
        log('stopped ' + (c.info && c.info.title || c.id) + ' at ' + Math.round(position(c)) + ' s (' + why + ')');
    }

    async function begin(index, startSec, opts) {
        finish('another item');
        const id = q.ids[index];
        if (!id) { set('idle'); return; }
        q.index = index;
        const c = { id, start: startSec || 0, t: 0, paused: false, reported: false, retries: 0, info: null, type: null,
            audioIndex: opts && opts.audioIndex != null ? opts.audioIndex : null,
            subtitleIndex: opts && opts.subtitleIndex != null ? opts.subtitleIndex : null,
            mediaSourceId: opts && opts.mediaSourceId || null, playSessionId: null, playMethod: null, stream: null, streamId: 0 };
        cur = c;
        set('loading');
        phase('item');
        try {
            const acc = account();
            const item = await api('GET', 'Users/' + encodeURIComponent(acc.userId) + '/Items/' + encodeURIComponent(id));
            if (cur !== c) return;
            c.info = o.describe ? o.describe(item) : { id, title: item && item.Name };
            c.type = item && item.MediaType;
        } catch (e) {
            if (cur !== c) return;
            log('item ' + id + ': ' + e.message);
        }
        await openStream(c.start, 'start');
    }

    /* ---------- the phone's commands ---------- */
    function play(d) {
        const ids = d.ids || [];
        if (!ids.length) return;
        const cmd = d.command || 'PlayNow';
        if (cmd === 'PlayNext' && cur) { q.ids.splice(q.index + 1, 0, ...ids); return; }
        if (cmd === 'PlayLast' && cur) { q.ids.push(...ids); return; }
        q.ids = ids.slice();
        const start = Math.min(Math.max(0, Number(d.startIndex) || 0), ids.length - 1);
        begin(start, d.start || 0, { audioIndex: d.audioIndex, subtitleIndex: d.subtitleIndex, mediaSourceId: d.mediaSourceId });
    }
    function pause(on) {
        if (!cur || cur.paused === on) return;
        cur.paused = on;
        if (cur.streamId) sink.ctl(cur.streamId, on ? 'pause' : 'resume');
        report('progress', { EventName: on ? 'pause' : 'unpause' });
    }
    function seek(sec) {
        if (!cur) return;
        const dur = cur.info && cur.info.seconds;
        sec = Math.max(0, dur ? Math.min(sec, dur - 1) : sec);
        cur.retries = 0;
        openStream(sec, 'seek');
    }
    function playstate(d) {
        const c = d.command;
        if (c === 'Stop') { finish('stopped from the phone'); set('idle'); }
        else if (c === 'Pause') pause(true);
        else if (c === 'Unpause') pause(false);
        else if (c === 'PlayPause') pause(!(cur && cur.paused));
        else if (c === 'Seek' && d.seek != null) seek(d.seek);
        else if (c === 'Rewind') seek(position() - 10);
        else if (c === 'FastForward') seek(position() + 30);
        else if (c === 'NextTrack') { if (q.index + 1 < q.ids.length) begin(q.index + 1, 0); }
        else if (c === 'PreviousTrack') { if (position() > 5 || q.index === 0) seek(0); else begin(q.index - 1, 0); }
    }
    function setVolume(v) {
        volume = Math.max(0, Math.min(100, Math.round(v)));
        if (cur && cur.streamId) sink.ctl(cur.streamId, 'volume ' + (muted ? 0 : volume / 100));
        report('progress', { EventName: 'volumechange' });
    }
    function command(d) {
        const a = d.args || {};
        switch (d.name) {
        case 'SetVolume': setVolume(Number(a.Volume)); break;
        case 'VolumeUp': setVolume(volume + 5); break;
        case 'VolumeDown': setVolume(volume - 5); break;
        case 'Mute': muted = true; setVolume(volume); break;
        case 'Unmute': muted = false; setVolume(volume); break;
        case 'ToggleMute': muted = !muted; setVolume(volume); break;
        case 'SetAudioStreamIndex': if (cur) { cur.audioIndex = Number(a.Index); seek(position()); } break;
        case 'SetSubtitleStreamIndex': if (cur) {
            const was = subStream(cur, cur.subtitleIndex);
            cur.subtitleIndex = Number(a.Index) >= 0 ? Number(a.Index) : -1;
            const next = subStream(cur, cur.subtitleIndex);
            // text subtitles are ours to draw: only a burned-in one (before or now) needs a new stream
            if ((was && !isText(was)) || (next && !isText(next))) seek(position());
            else { loadSubs(cur); report('progress', { EventName: 'subtitletrackchange' }); }
        } break;
        default: break;
        }
    }

    /* ---------- the player ---------- */
    function onPlayer(id, ev) {
        const c = cur;
        if (!c || c.streamId !== id || !ev) return;
        if (ev.ev === 'tick') {
            c.t = ev.t || 0;
            c.tAt = now();
            c.player = Object.assign({}, c.player, { state: ev.state, shown: ev.shown, late: ev.late, decerr: ev.decerr, aplayed: ev.aplayed,
                alate: ev.alate, aunread: ev.aunread, adev: ev.adev, buffered: ev.buffered, kbytes: ev.kbytes });
            if (st.state !== 'error') set(ev.state === 'starting' ? 'loading' : ev.state);
            if (ev.state !== 'starting') st.phase = null;
            if (ev.state === 'playing' && c.t > 60) c.retries = 0;   // it played on: a later loss gets its retries again
        } else if (ev.ev === 'open' || ev.ev === 'decoder' || ev.ev === 'audio') {
            c.player = Object.assign({}, c.player, { [ev.ev]: ev });
        } else if (ev.ev === 'error') {
            c.player = Object.assign({}, c.player, { error: ev.error });
            log('player: ' + ev.error);
        } else if (ev.ev === 'end' || ev.ev === 'exit') {
            if (c.ended) return;
            c.ended = true;
            if (ev.ev === 'end') c.t = ev.t || c.t;
            const dur = c.info && c.info.seconds;
            const atEnd = c.httpDone === 'end' && (!dur || position() >= dur - 15);
            if (atEnd) {
                log('ended: ' + (c.info && c.info.title || c.id));
                if (q.index + 1 < q.ids.length) begin(q.index + 1, 0);
                else { finish('the end'); set('idle'); }
                return;
            }
            // the connection or the player went before the end: again from where it was
            const why = ev.ev === 'exit' ? 'the player ended (' + (ev.signal || 'code ' + ev.code) + ')' : 'the stream ended early (' + (c.httpDone || 'player') + ')';
            if (c.retries < RETRIES) {
                c.retries++;
                log(why + ': again from ' + Math.round(position()) + ' s (' + c.retries + '/' + RETRIES + ')');
                openStream(position(), 'resume');
            } else {
                log(why + ': giving up');
                const err = (c.player && c.player.error) || why;
                finish('failed');
                set('error', err);
            }
        }
    }

    function stop() { finish('stopped'); set('idle'); }

    return { play, playstate, command, onPlayer, stop, status, castLog, position: () => position() };
}

module.exports = { createPlayback, deviceProfile, setParam, describeUrl, parseSrt, ascii, TICKS };
