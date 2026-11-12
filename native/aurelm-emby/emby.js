'use strict';
/**
 * emby.js - the head unit as an Emby cast target ("remote control" client), as Emby's apps and Kodi's
 * Emby add-on are: signed in as the owner's Emby user, connected to the server's WebSocket, it shows in
 * the cast menu of Emby's phone app. A film sent to it arrives as a `Play` message (item ids, start
 * position); pause, seek and stop as `Playstate`; volume and messages as `GeneralCommand`.
 *
 *   const c = createClient({ nx, device: { id, name }, version, log, now });
 *   await c.signIn(serverText, user, password)  -> account { server, userId, token, userName, serverName, serverId }
 *   c.run(account)          keeps connected (reconnects), until c.stop()
 *   c.on('status', s) / c.on('play', p) / c.on('playstate', p) / c.on('command', p) / c.on('signed-out', why)
 *   c.status()
 *   c.call(method, path, body)  the API as the signed-in user (playback.js)
 *
 * Only the access token is kept, never the password. Everything goes through `nx` (netx.js): the uplink's
 * DNS and Mozilla's certificates.
 */
const { EventEmitter } = require('events');
const ws = require('./ws');

const CLIENT = 'BMW iDrive';
// what the cast menu offers to send to us (Kodi's Emby add-on announces the same kinds)
const COMMANDS = ['Play', 'Playstate', 'PlayNext', 'PlayMediaSource', 'SetVolume', 'VolumeUp', 'VolumeDown', 'Mute', 'Unmute',
    'ToggleMute', 'SetAudioStreamIndex', 'SetSubtitleStreamIndex', 'DisplayMessage', 'Pause', 'Unpause'];
const TICKS = 10000000;   // Emby's ticks per second
// the general commands playback.js handles; any other one is logged as not handled
const KNOWN = ['SetVolume', 'VolumeUp', 'VolumeDown', 'Mute', 'Unmute', 'ToggleMute', 'SetAudioStreamIndex', 'SetSubtitleStreamIndex', 'DisplayMessage'];
// the server's messages that are news for others, not commands for us
const QUIET = ['UserDataChanged', 'LibraryChanged', 'RefreshProgress', 'ScheduledTaskEnded', 'PackageInstalling', 'PackageInstallationCompleted',
    'ServerRestarting', 'ServerShuttingDown', 'RestartRequired', 'SessionEnded', 'PlaybackStart', 'PlaybackStopped', 'TimerCreated', 'SeriesTimerCreated',
    'TimerCancelled', 'SeriesTimerCancelled', 'UserUpdated', 'UserConfigurationUpdated'];

/** "emby.example.com:8920/emby/" -> ['https://emby.example.com:8920/emby', 'http://...'] (the ones to try) */
function candidates(text) {
    let s = String(text || '').trim().replace(/\/+$/, '');
    if (!s) return [];
    if (/^https?:\/\//i.test(s)) return [s.replace(/^HTTP/i, (m) => m.toLowerCase())];
    return ['https://' + s, 'http://' + s];
}

function authHeader(device, version, userId) {
    const q = (v) => String(v).replace(/"/g, '');
    return 'Emby ' + (userId ? 'UserId="' + q(userId) + '", ' : '') + 'Client="' + CLIENT + '", Device="' + q(device.name) +
        '", DeviceId="' + q(device.id) + '", Version="' + q(version) + '"';
}

/** a short description of an item and its streams, for the screen and the log */
function describe(item) {
    if (!item) return null;
    const src = (item.MediaSources || [])[0] || {};
    const streams = src.MediaStreams || item.MediaStreams || [];
    const v = streams.filter((s) => s.Type === 'Video')[0];
    const a = streams.filter((s) => s.Type === 'Audio' && s.IsDefault)[0] || streams.filter((s) => s.Type === 'Audio')[0];
    const title = item.Type === 'Episode' && item.SeriesName
        ? item.SeriesName + ' ' + (item.ParentIndexNumber != null ? 'S' + item.ParentIndexNumber : '') + (item.IndexNumber != null ? 'E' + item.IndexNumber : '') + ' - ' + item.Name
        : item.Name + (item.ProductionYear ? ' (' + item.ProductionYear + ')' : '');
    return {
        id: item.Id, title, type: item.Type,
        // the cluster card's two lines: the film (or the series), then the episode (or the year)
        name: item.Type === 'Episode' && item.SeriesName ? item.SeriesName : item.Name,
        sub: item.Type === 'Episode' && item.SeriesName
            ? ((item.ParentIndexNumber != null ? 'S' + item.ParentIndexNumber : '') + (item.IndexNumber != null ? 'E' + item.IndexNumber : '') + ' ' + (item.Name || '')).trim()
            : item.ProductionYear ? String(item.ProductionYear) : null,
        seriesId: item.SeriesId || null,
        seconds: item.RunTimeTicks ? Math.round(item.RunTimeTicks / TICKS) : null,
        container: src.Container || item.Container || null,
        bitrate: src.Bitrate || null,
        video: v ? { codec: v.Codec, w: v.Width, h: v.Height, profile: v.Profile || null, level: v.Level || null, hdr: v.VideoRange || null } : null,
        audio: a ? { codec: a.Codec, channels: a.Channels, language: a.Language || null } : null,
    };
}

function createClient(o) {
    const ev = new EventEmitter();
    const log = o.log || (() => {});
    const now = o.now || Date.now;
    const nx = o.nx;
    const version = o.version || '0.0.0';
    let account = null, sock = null, running = false, retry = null, keep = null, refresh = null, backoff = 5000;
    const st = { state: 'signed-out', error: null, server: null, sessionId: null, connectedAt: null, since: now(), reconnects: 0, lastMessage: null };

    function set(state, error) {
        st.state = state; st.error = error || null; st.since = now();
        ev.emit('status', status());
    }
    function status() { return JSON.parse(JSON.stringify(st)); }

    function headers(acc) {
        const h = { Accept: 'application/json', Authorization: authHeader(o.device, version, acc && acc.userId) };
        if (acc && acc.token) h['X-Emby-Token'] = acc.token;
        return h;
    }
    async function api(acc, method, path, body, base) {
        const r = await nx.request({ method, url: (base || acc.server) + '/' + path.replace(/^\//, ''), headers: headers(acc), body });
        if (r.status === 401 || r.status === 403) { const e = new Error('the server refused the sign-in (' + r.status + ')'); e.code = 'EAUTH'; throw e; }
        if (r.status < 200 || r.status >= 300) throw new Error(method + ' ' + path.split('?')[0] + ': HTTP ' + r.status);
        const t = r.body.toString('utf8');
        if (!t) return null;
        try { return JSON.parse(t); } catch (e) { throw new Error(method + ' ' + path.split('?')[0] + ': not JSON (is this an Emby server?)'); }
    }

    /** signs in; resolves the account to keep (no password in it) or rejects with a readable error */
    async function signIn(serverText, user, password) {
        const tries = candidates(serverText);
        if (!tries.length) throw new Error('enter the server\'s address');
        if (!user) throw new Error('enter the user name');
        let lastErr = null;
        for (let i = 0; i < tries.length; i++) {
            const base = tries[i];
            let info;
            try { info = await api(null, 'GET', 'System/Info/Public', undefined, base); }
            catch (e) { lastErr = e; log('sign-in: ' + base + ': ' + e.message); continue; }
            if (!info || !info.Id) { lastErr = new Error(base + ' is not an Emby server'); continue; }
            let auth;
            try { auth = await api(null, 'POST', 'Users/AuthenticateByName', { Username: user, Pw: password || '' }, base); }
            catch (e) {
                if (e.code === 'EAUTH') throw new Error('wrong user name or password');
                throw e;
            }
            if (!auth || !auth.AccessToken || !auth.User) throw new Error('the server gave no access token');
            log('signed in to ' + (info.ServerName || base) + ' ' + (info.Version || '') + ' as ' + auth.User.Name);
            return { server: base, userId: auth.User.Id, token: auth.AccessToken, userName: auth.User.Name,
                serverName: info.ServerName || null, serverId: info.Id, serverVersion: info.Version || null, at: now() };
        }
        throw lastErr || new Error('the server does not answer');
    }

    async function itemInfo(id) {
        try { return describe(await api(account, 'GET', 'Users/' + encodeURIComponent(account.userId) + '/Items/' + encodeURIComponent(id))); }
        catch (e) { log('item ' + id + ': ' + e.message); return { id, title: null, error: e.message }; }
    }

    async function onMessage(text) {
        let m;
        try { m = JSON.parse(text); } catch (e) { return; }
        const type = m.MessageType, d = m.Data || {};
        if (type === 'ForceKeepAlive') { schedule(Number(d) || 60); return; }
        if (type === 'KeepAlive' || type === 'Sessions' || type === 'ScheduledTasksInfo' || type === 'ActivityLogEntry') return;
        st.lastMessage = { type, at: now() };
        if (type === 'Play') {
            await play(d, 'Play');
        } else if (type === 'Playstate') {
            log('Playstate ' + d.Command + (d.SeekPositionTicks != null ? ' ' + Math.round(d.SeekPositionTicks / TICKS) + ' s' : ''));
            ev.emit('playstate', { command: d.Command, seek: d.SeekPositionTicks != null ? d.SeekPositionTicks / TICKS : null, at: now() });
        } else if (type === 'GeneralCommand' && /^PlayMediaSource$/i.test(d.Name || '')) {
            // the phone hands over what it plays (cast chosen during a film): the film, its source, where it was
            // (0.2.5 left it out: nothing played until another film was chosen)
            const a = d.Arguments || {};
            log('GeneralCommand PlayMediaSource ' + JSON.stringify(a).slice(0, 200));
            await play({ ItemIds: a.ItemIds ? String(a.ItemIds).split(',') : [a.ItemId || a.Id].filter(Boolean), PlayCommand: 'PlayNow',
                StartPositionTicks: a.StartPositionTicks, MediaSourceId: a.MediaSourceId, AudioStreamIndex: a.AudioStreamIndex,
                SubtitleStreamIndex: a.SubtitleStreamIndex, StartIndex: a.StartIndex }, 'PlayMediaSource');
        } else if (type === 'GeneralCommand') {
            log('GeneralCommand ' + d.Name + (KNOWN.indexOf(d.Name) < 0 ? ' (not handled) ' + JSON.stringify(d.Arguments || {}).slice(0, 160) : ''));
            ev.emit('command', { name: d.Name, args: d.Arguments || {}, at: now() });
        } else if (QUIET.indexOf(type) < 0) {
            log('message ' + type + ' (not handled) ' + JSON.stringify(d).slice(0, 160));
        }
    }
    /** a Play (or a PlayMediaSource made one): its numbers may come as text */
    async function play(d, how) {
        const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
        const ids = (d.ItemIds || []).map(String).filter(Boolean);
        const startTicks = num(d.StartPositionTicks) || 0;
        log(how + ' ' + (d.PlayCommand || '') + ' ' + ids.join(',') + (startTicks ? ' from ' + Math.round(startTicks / TICKS) + ' s' : ''));
        if (!ids.length) return;
        const startIndex = num(d.StartIndex) || 0;
        const first = ids[startIndex] || ids[0];
        const item = first ? await itemInfo(first) : null;
        ev.emit('play', { command: d.PlayCommand || 'PlayNow', ids, start: startTicks / TICKS, startIndex, mediaSourceId: d.MediaSourceId || null,
            audioIndex: num(d.AudioStreamIndex), subtitleIndex: num(d.SubtitleStreamIndex), from: d.ControllingUserId || null, item, at: now() });
    }

    function schedule(seconds) {
        clearInterval(keep);
        // Emby's clients answer ForceKeepAlive with a KeepAlive at half the interval
        keep = setInterval(() => { if (sock && sock.isOpen()) { sock.send(JSON.stringify({ MessageType: 'KeepAlive' })); sock.ping(); } },
            Math.max(5, seconds / 2) * 1000);
    }

    async function connectOnce() {
        if (!running) return;
        if (!nx.online()) { set('offline', 'no internet: mgu-uplink is not online'); return later(); }
        set('connecting');
        try {
            const info = await api(account, 'GET', 'System/Info');
            st.server = { name: info && info.ServerName, version: info && info.Version };
        } catch (e) {
            if (e.code === 'EAUTH') { signedOut('the server no longer accepts the sign-in: sign in again'); return; }
            set('error', e.message); return later();
        }
        if (!running) return;
        const u = account.server.replace(/^http/, 'ws') + '/embywebsocket?api_key=' + encodeURIComponent(account.token) + '&deviceId=' + encodeURIComponent(o.device.id);
        const s = ws.connect({ url: u, connect: (a) => nx.socket(a), readyEvent: /^wss:/.test(u) ? 'secureConnect' : 'connect' });
        sock = s;
        s.on('error', (e) => log('websocket: ' + e.message));
        s.on('message', (t) => { onMessage(t).catch((e) => log('message: ' + e.message)); });
        s.on('close', (code, why) => {
            if (sock !== s) return;
            sock = null;
            clearInterval(keep); clearInterval(refresh);
            if (!running) return;
            st.reconnects++;
            set('error', 'the connection to the server ended (' + why + ')');
            later();
        });
        s.on('open', async () => {
            backoff = 5000;
            schedule(60);
            try {
                await announce();
                st.connectedAt = now();
                set('connected');
                log('connected to ' + ((st.server && st.server.name) || account.server) + ', session ' + st.sessionId);
                // the cast menu lists the sessions active lately (Emby's apps ask for the last ~16 minutes), and only
                // an HTTP request marks a session active, not the WebSocket: 0.2.3 dropped out of the menu 10 minutes
                // after connecting. So the cast settings again every 4 minutes (they also come back after a server restart).
                clearInterval(refresh);
                refresh = setInterval(() => {
                    if (sock !== s || !s.isOpen()) return;
                    announce().catch((e) => {
                        if (e.code === 'EAUTH') { signedOut('the server no longer accepts the sign-in: sign in again'); return; }
                        log('cast settings again: ' + e.message);
                    });
                }, o.refreshMs || 240000);
            } catch (e) {
                if (e.code === 'EAUTH') { signedOut('the server no longer accepts the sign-in: sign in again'); return; }
                log('capabilities: ' + e.message);
                set('error', 'connected, but the server refused the cast settings: ' + e.message);
            }
        });
    }
    /** the cast settings (remote control, our commands) and our session's id */
    async function announce() {
        await api(account, 'POST', 'Sessions/Capabilities/Full', {
            PlayableMediaTypes: ['Video', 'Audio'], QueueableMediaTypes: ['Video', 'Audio'], SupportedCommands: COMMANDS,
            SupportsMediaControl: true, SupportsRemoteControl: true, SupportsSync: false,
        });
        const sessions = await api(account, 'GET', 'Sessions?DeviceId=' + encodeURIComponent(o.device.id));
        const id = (sessions && sessions[0] && sessions[0].Id) || null;
        if (st.sessionId && id && id !== st.sessionId) log('the server gave us a new session: ' + id);
        st.sessionId = id;
        st.announcedAt = now();
    }
    function later() {
        if (!running) return;
        clearTimeout(retry);
        retry = setTimeout(() => { connectOnce().catch((e) => { set('error', e.message); later(); }); }, backoff);
        backoff = Math.min(60000, backoff * 2);
    }
    function signedOut(why) {
        stop();
        set('signed-out', why);
        ev.emit('signed-out', why);
    }

    function run(acc) {
        stop();
        account = acc;
        running = true;
        backoff = 5000;
        connectOnce().catch((e) => { set('error', e.message); later(); });
    }
    function stop() {
        running = false;
        clearTimeout(retry); clearInterval(keep); clearInterval(refresh);
        if (sock) { const s = sock; sock = null; s.close(); }
        st.sessionId = null;
    }
    /** tells the server we leave (the token is dropped), then stops */
    async function signOut() {
        const acc = account;
        stop();
        if (acc) { try { await api(acc, 'POST', 'Sessions/Logout'); } catch (e) { log('sign-out: ' + e.message); } }
        account = null;
        set('signed-out');
    }

    /** the server's API as the signed-in user (playback.js): rejects with code EAUTH when the token is refused */
    function call(method, path, body) {
        if (!account) return Promise.reject(new Error('not signed in'));
        return api(account, method, path, body);
    }
    /** a GET whose answer is text (a server log): resolves { status, text } */
    async function callText(path) {
        if (!account) throw new Error('not signed in');
        const r = await nx.request({ method: 'GET', url: account.server + '/' + path.replace(/^\//, ''), headers: headers(account), maxBytes: 4 * 1024 * 1024 });
        return { status: r.status, text: r.body.toString('utf8') };
    }

    /**
     * an item's poster as PNG (the server converts it: Format=png), at most 300 px, 1 MiB; an episode without one of
     * its own: the series'. Resolves the bytes, or rejects with why.
     */
    async function poster(id, seriesId) {
        if (!account) throw new Error('not signed in');
        let why = 'none';
        for (const x of [id, seriesId].filter(Boolean)) {
            const r = await nx.request({ method: 'GET', headers: headers(account), maxBytes: 1024 * 1024, timeoutMs: 20000,
                url: account.server + '/Items/' + encodeURIComponent(x) + '/Images/Primary?MaxWidth=300&MaxHeight=300&Format=png&Quality=90' });
            if (r.status === 200 && r.body.length > 8 && r.body.readUInt32BE(0) === 0x89504e47) return r.body;
            why = r.status === 200 ? 'not a PNG' : 'HTTP ' + r.status;
        }
        throw new Error(why);
    }

    return Object.assign(ev, { signIn, run, stop, signOut, status, describe, call, callText, poster, account: () => account, device: o.device });
}

module.exports = { createClient, candidates, authHeader, describe, COMMANDS, CLIENT };
