'use strict';
/**
 * ma.js - Music Assistant from the car: its REST API (browsing, the queue) and a Sendspin player (the sound, what
 * plays, its artwork), both through the server's own address (https://<server>, e.g. mass.sandu.casa: the car is
 * never at home, and Music Assistant streams to remote players only over Sendspin, through its authenticated proxy
 * /sendspin). Runs in client.js (the tool's internet uid); everything goes through `nx` (netx.js: mgu-uplink's DNS,
 * our CA list).
 *
 * Found with a probe against Music Assistant 2.10.9 (2026-11-13):
 *   - POST /api {command, args} with "Authorization: Bearer <token>"; POST /auth/login {provider_id: builtin,
 *     credentials: {username, password}} gives a token, and auth/token/create a long-lived one (a year), kept here
 *   - /sendspin wants {"type":"auth","token"} as its first message ("auth_ok"), then the Sendspin protocol as a
 *     legacy unencrypted client (TLS is the connection's): no pairing, no approval
 *   - the server sends 30 s of sound at once, then in real time (aiosendspin's player role: 30 s at most, whatever
 *     the client's buffer): the car rides out a 30 s gap in the mobile network
 *   - the Sendspin client becomes a Music Assistant player of its own (a "universal player", e.g. upd5c11c0f), found
 *     by its output_protocols' output_protocol_id, our client_id; its queue_id is its player_id
 *   - artwork comes as PNG in the size asked for; /imageproxy/<proxy_id>?size=80|160|256|512&fmt=png for the rest
 *
 *   const ma = createMa({ nx, log, device: { id, name }, sink: { format(f), audio(buf), clear(), volume(v) }, onStatus, onArt })
 *   ma.login(server, user, password) / ma.withToken(server, token) -> account { server, token, userName }
 *   ma.run(account) / ma.stop()
 *   ma.api(command, args) -> the answer
 *   ma.home() / ma.row(provider, itemId) / ma.library(kind, offset) / ma.search(q) / ma.open(uri)
 *   ma.play(uri, option) / ma.control(cmd, arg)
 *   ma.image(proxyId, size) -> PNG Buffer
 *   ma.status()
 */
const { EventEmitter } = require('events');
const ws = require('./ws');

const LEAD_US = 1000000;         // sound handed to the player this far before it is due: the player writes it on time
                                 // (each chunk carries when it is due; 0.1.1 let the device set the pace)
const LATE_US = 150000;          // sound later than this is dropped (after a stall)

/** a monotonic clock in microseconds */
// CLOCK_MONOTONIC (libuv's hrtime), as ma-player's: the times handed to the player are in this clock
function nowUs() { const d = process.hrtime(); return d[0] * 1e6 + Math.floor(d[1] / 1000); }

/** samples (48 kHz) in an Opus packet, from its TOC byte (RFC 6716 3.1); 0: not known */
function opusSamples(p) {
    if (!p || !p.length) return 0;
    const toc = p[0], cfg = toc >> 3, c = toc & 3;
    const size = cfg < 12 ? [480, 960, 1920, 2880][cfg & 3] : cfg < 16 ? [480, 960][cfg & 1] : [120, 240, 480, 960][cfg & 3];
    const n = c === 0 ? 1 : c < 3 ? 2 : (p.length > 1 ? p[1] & 0x3f : 0);
    return size * n;
}

/** "mass.sandu.casa", "https://mass.sandu.casa/", "http://192.168.0.241:8095" -> "https://mass.sandu.casa" ... */
function serverUrl(s) {
    let v = String(s || '').trim().replace(/\/+$/, '');
    if (!v) throw new Error('no server address');
    if (!/^https?:\/\//i.test(v)) v = (/^[\d.]+(:\d+)?$/.test(v) || /:\d+$/.test(v) && !/:443$/.test(v) ? 'http://' : 'https://') + v;
    return v.replace(/\/(api|sendspin)$/, '');
}

/** a media item as the app shows it */
function slim(x) {
    if (!x || typeof x !== 'object') return null;
    const img = x.image || (x.metadata && x.metadata.images && x.metadata.images[0]) || (x.album && x.album.image) || null;
    const artists = (x.artists || []).map((a) => a && a.name).filter(Boolean).join(', ');
    const type = x.media_type || x.type || '';
    let sub = artists;
    if (!sub && type === 'playlist') sub = x.owner || 'Playlist';
    if (!sub && type === 'radio') sub = 'Radio';
    if (!sub && type === 'album') sub = 'Album';
    if (!sub && type === 'artist') sub = 'Artist';
    if (!sub && x.subtitle) sub = x.subtitle;
    return {
        uri: x.uri, type, name: (x.name || x.title || '') + (x.version && type === 'track' ? ' (' + x.version + ')' : ''), sub: sub || '', img: img && img.proxy_id ? img.proxy_id : null,
        provider: x.provider, itemId: x.item_id, playable: x.is_playable !== false, duration: x.duration || null,
        year: x.year || null,
    };
}
const slimAll = (list) => (Array.isArray(list) ? list : (list && list.items) || []).map(slim).filter((x) => x && x.uri);

function createMa(o) {
    const { nx, log } = o;
    const device = o.device;
    const sink = o.sink;
    const ev = new EventEmitter();
    let account = null, stopped = true;
    const st = {
        conn: 'signed-out', error: null, playerId: null, playback: 'stopped', group: null,
        meta: null, controller: null, format: null, volume: 100, muted: false, artVer: 0, ahead: 0, reconnects: 0,
        connectedAt: null, lastAudioAt: null,
    };
    let art = null;   // the current artwork, PNG
    // the long-lived token's name on the server: this car's (sign-out revokes only it)
    const TOKEN_NAME = 'BMW iDrive ' + String(device.id).slice(-6);

    /* ---------------------------------------------------------------- REST */
    async function request(path, body, token, timeoutMs) {
        const r = await nx.request({ method: 'POST', url: account && !token ? account.server + path : path, body,
            headers: { Authorization: 'Bearer ' + (token || account.token), Accept: 'application/json' }, timeoutMs: timeoutMs || 20000 });
        const text = r.body.toString('utf8');
        if (r.status === 401 || r.status === 403) { const e = new Error('the server refused the token (' + r.status + ')'); e.code = 'EAUTH'; throw e; }
        let j = null;
        try { j = text ? JSON.parse(text) : null; } catch (e) { throw new Error('HTTP ' + r.status + ': ' + text.slice(0, 120)); }
        if (r.status >= 400) throw new Error((j && (j.error || j.details)) || 'HTTP ' + r.status);
        if (j && typeof j === 'object' && !Array.isArray(j) && j.error_code) throw new Error(j.details || j.error || 'error ' + j.error_code);
        return j;
    }
    function api(command, args, timeoutMs) {
        if (!account) return Promise.reject(new Error('not signed in'));
        return request('/api', { command, args: args || {} }, null, timeoutMs).catch((e) => {
            if (e.code === 'EAUTH') { log('the server refused the token: signed out'); ev.emit('signed-out', 'the server refused the sign-in (the token was revoked or expired)'); }
            throw e;
        });
    }

    async function withToken(server, token) {
        const s = serverUrl(server);
        const me = await request(s + '/api', { command: 'auth/me', args: {} }, token);
        if (!me || !me.user_id) throw new Error('the server did not take the token');
        const info = await nx.request({ method: 'GET', url: s + '/info', timeoutMs: 15000 }).then((r) => JSON.parse(r.body.toString('utf8'))).catch(() => ({}));
        return { server: s, token, userName: me.display_name || me.username, serverName: info.name || null, serverVersion: info.server_version || null };
    }
    async function login(server, user, password) {
        const s = serverUrl(server);
        const r = await nx.request({ method: 'POST', url: s + '/auth/login', timeoutMs: 20000,
            body: { provider_id: 'builtin', credentials: { username: user, password }, device_name: TOKEN_NAME } });
        let j = null;
        try { j = JSON.parse(r.body.toString('utf8')); } catch (e) { throw new Error('this is not a Music Assistant server (HTTP ' + r.status + ')'); }
        if (!j.success || !j.token) throw new Error(j.error || 'the server refused the sign-in');
        // a long-lived token (a year, no renewal): the login's own is short-lived
        const long = await request(s + '/api', { command: 'auth/token/create', args: { name: TOKEN_NAME } }, j.token);
        if (typeof long !== 'string') throw new Error('the server did not give a long-lived token');
        return withToken(s, long);
    }

    /* ---------------------------------------------------------------- browsing */
    let rowsCache = null;
    async function home() {
        if (rowsCache && Date.now() - rowsCache.at < 10 * 60000) return rowsCache.rows;
        const folders = await api('music/recommendations');
        const rows = (folders || []).filter((f) => f && f.item_id).map((f) => ({ provider: f.provider, itemId: f.item_id, name: f.name }));
        rowsCache = { at: Date.now(), rows };
        return rows;
    }
    async function row(provider, itemId) {
        return slimAll(await api('music/recommendations/items', { provider, item_id: itemId }, 30000));
    }
    const KINDS = { playlists: 'music/playlists/library_items', albums: 'music/albums/library_items', artists: 'music/artists/library_items',
        radios: 'music/radios/library_items', tracks: 'music/tracks/library_items', podcasts: 'music/podcasts/library_items' };
    async function library(kind, offset, limit) {
        const c = KINDS[kind];
        if (!c) throw new Error('no library ' + kind);
        return slimAll(await api(c, { limit: limit || 60, offset: offset || 0, order_by: kind === 'tracks' ? 'timestamp_added_desc' : 'sort_name' }));
    }
    async function search(q) {
        const r = await api('music/search', { search_query: q, limit: 12 }, 30000) || {};
        const out = [];
        [['tracks', 'Tracks'], ['artists', 'Artists'], ['albums', 'Albums'], ['playlists', 'Playlists'], ['radio', 'Radio'], ['podcasts', 'Podcasts']]
            .forEach((k) => { const l = slimAll(r[k[0]]); if (l.length) out.push({ name: k[1], items: l }); });
        return out;
    }
    /** an album / playlist / artist: the item and what is in it */
    async function open(uri) {
        const item = await api('music/item_by_uri', { uri });
        const s = slim(item);
        if (!s) throw new Error('nothing at ' + uri);
        let children = [];
        if (s.type === 'album') children = slimAll(await api('music/albums/album_tracks', { item_id: s.itemId, provider_instance_id_or_domain: s.provider }));
        else if (s.type === 'playlist') children = slimAll(await api('music/playlists/playlist_tracks', { item_id: s.itemId, provider_instance_id_or_domain: s.provider }, 30000));
        else if (s.type === 'podcast') children = slimAll(await api('music/podcasts/podcast_episodes', { item_id: s.itemId, provider_instance_id_or_domain: s.provider }, 30000));
        else if (s.type === 'artist') {
            const albums = slimAll(await api('music/artists/artist_albums', { item_id: s.itemId, provider_instance_id_or_domain: s.provider }).catch(() => []));
            const tracks = slimAll(await api('music/artists/top_tracks', { item_id: s.itemId, provider_instance_id_or_domain: s.provider }).catch(() => []));
            children = tracks.slice(0, 10).concat(albums);
        }
        return { item: s, children: children.slice(0, 300) };
    }

    /* ---------------------------------------------------------------- the queue */
    async function playerId() {
        if (st.playerId) return st.playerId;
        const players = await api('players/all', { return_unavailable: true });
        const mine = (players || []).filter((p) => (p.output_protocols || []).some((op) => op && op.output_protocol_id === device.id) || p.player_id === device.id);
        const p = mine.filter((x) => x.available)[0] || mine[0];
        if (p) { st.playerId = p.player_id; log('Music Assistant player: ' + p.player_id + ' (' + p.provider + ')'); }
        return st.playerId;
    }
    async function needPlayer() {
        for (let i = 0; i < 20; i++) {
            const id = await playerId().catch(() => null);
            if (id) return id;
            await new Promise((r) => setTimeout(r, 1000));
        }
        throw new Error('Music Assistant has no player for this car yet (Sendspin not connected)');
    }
    /** play an item now: option replace (default) | next | add */
    async function play(uri, option, startItem) {
        const q = await needPlayer();
        const args = { queue_id: q, media: [uri], option: option || 'replace' };
        if (startItem) args.start_item = startItem;
        await api('player_queues/play_media', args, 30000);
        return q;
    }
    async function control(cmd, arg) {
        const q = await needPlayer();
        switch (cmd) {
        case 'play_pause': case 'next': case 'previous': case 'play': case 'pause': case 'stop': case 'resume':
            return api('player_queues/' + cmd, { queue_id: q });
        case 'seek': return api('player_queues/seek', { queue_id: q, position: Math.max(0, Math.round(Number(arg) || 0)) });
        case 'skip': return api('player_queues/skip', { queue_id: q, seconds: Math.round(Number(arg) || 0) });
        case 'shuffle': return api('player_queues/shuffle', { queue_id: q, shuffle_enabled: !!arg });
        case 'repeat': return api('player_queues/repeat', { queue_id: q, repeat_mode: String(arg || 'off') });
        // Autoplay (Music Assistant's "infinite play": similar tracks added when the queue runs out); older servers
        // only know it as "don't stop the music"
        case 'autoplay': return api('player_queues/autoplay', { queue_id: q, autoplay_enabled: !!arg })
            .catch(() => api('player_queues/dont_stop_the_music', { queue_id: q, dont_stop_the_music_enabled: !!arg }));
        // Crossfade: Music Assistant mixes the end of a track into the next one in the stream it sends (Sendspin
        // always plays in flow mode), so the car needs nothing for it
        case 'crossfade': return api('player_queues/crossfade', { queue_id: q, crossfade_enabled: !!arg });
        case 'volume': return api('players/cmd/volume_set', { player_id: q, volume_level: Math.max(0, Math.min(100, Math.round(Number(arg) || 0))) });
        case 'play_index': return api('player_queues/play_index', { queue_id: q, index: arg });
        default: throw new Error('no command ' + cmd);
        }
    }
    async function queue() {
        const q = await needPlayer();
        const [qs, items] = await Promise.all([api('player_queues/get', { queue_id: q }), api('player_queues/items', { queue_id: q, limit: 50, offset: 0 })]);
        const cur = qs && qs.current_index != null ? qs.current_index : -1;
        const auto = qs ? (qs.autoplay_enabled != null ? qs.autoplay_enabled : qs.dont_stop_the_music_enabled) : null;
        return { index: cur, shuffle: qs && qs.shuffle_enabled, repeat: qs && qs.repeat_mode, autoplay: auto == null ? null : !!auto,
            crossfade: qs && qs.crossfade_enabled != null ? !!qs.crossfade_enabled : null,
            items: (items || []).map((it, i) => Object.assign(slim(it.media_item || it) || {}, { name: it.name || (it.media_item && it.media_item.name) || '', queueItemId: it.queue_item_id, index: i })) };
    }

    async function image(proxyId, size) {
        if (!/^[0-9a-f]{16,128}$/i.test(String(proxyId))) throw new Error('bad image id');
        const sz = [80, 160, 256, 512].indexOf(Number(size)) >= 0 ? Number(size) : 160;
        const r = await nx.request({ method: 'GET', url: account.server + '/imageproxy/' + proxyId + '?size=' + sz + '&fmt=png',
            headers: { Authorization: 'Bearer ' + account.token }, timeoutMs: 20000, maxBytes: 3 * 1024 * 1024 });
        if (r.status !== 200) throw new Error('image: HTTP ' + r.status);
        if (r.body.slice(1, 4).toString('latin1') !== 'PNG') throw new Error('image: not a PNG');
        return r.body;
    }

    /* ---------------------------------------------------------------- Sendspin */
    let sock = null, retry = null, timeTimer = null, pumpTimer = null, stateSent = false;
    let offset = null;                 // server µs - our µs, as the time exchanges measure it
    let clockOff = null;               // the one the sound goes by: follows offset by 5 ms a second at most (a
                                       // jump of the measure over a mobile network would be a gap or a cut in the
                                       // music), at once only for a jump over 200 ms (a new connection)
    const samples = [];                // [delay, offset] of the last time exchanges
    let queueA = [];                   // [{ t (our µs), ts (server µs), end (server µs), data }], in time order
    let lastEnd = 0;                   // server µs: where the last chunk queued ends (the server's clock: a new
                                       // offset does not move it)
    // counted since the stream started (the Status page): what came, what was dropped and why
    const stats = { chunks: 0, overlaps: 0, gaps: 0, late: 0, handed: 0, since: 0 };
    function chunkUs(data) {
        const f = st.format;
        if (!f) return 0;
        if (f.codec === 'opus') return Math.round(opusSamples(data) * 1e6 / 48000);
        if (f.codec === 'pcm') return Math.round(data.length / (f.channels * (f.bits / 8)) * 1e6 / f.rate);
        return 0;
    }
    function resetQueue() { queueA = []; lastEnd = 0; }
    function resetHeader() { hdr = null; hdrWait = []; }
    function setConn(c, err) { st.conn = c; st.error = err || null; emitStatus(); }
    let statusTimer = null;
    function emitStatus() { if (statusTimer) return; statusTimer = setTimeout(() => { statusTimer = null; ev.emit('status', status()); }, 100); }

    function sendJson(type, payload) { if (sock) sock.send(JSON.stringify({ payload, type })); }
    function hello() {
        sendJson('client/hello', {
            name: device.name, client_id: device.id, version: 1,
            // what Music Assistant shows under the player's name (else "Unknown Manufacturer / Unknown model")
            device_info: Object.assign({ manufacturer: 'BMW', product_name: 'iDrive 7' }, device.version ? { software_version: 'aurelm-music ' + device.version } : {}),
            supported_roles: ['player@v1', 'metadata@v1', 'artwork@v1', 'controller@v1'],
            'player@v1_support': {
                supported_formats: [
                    { codec: 'opus', channels: 2, sample_rate: 48000, bit_depth: 16 },
                    { codec: 'pcm', channels: 2, sample_rate: 48000, bit_depth: 16 },
                    { codec: 'pcm', channels: 2, sample_rate: 44100, bit_depth: 16 },
                ],
                buffer_capacity: 4 * 1024 * 1024, supported_commands: ['volume', 'mute'],
            },
            'artwork@v1_support': { channels: [{ source: 'album', format: 'png', width: 400, height: 400 }] },
            unpaired_access: { enabled: false },
        });
    }
    /*
     * The player's state, with the timing the server schedules by: the car is on a mobile network, so it asks for
     * 5 s of sound queued at all times (min_buffer_ms; the default, 1 s, is what a live source such as Spotify
     * through librespot gets: its stream stuttered and fell behind over the mobile network, while Apple Music,
     * a file the server sends 30 s ahead, played clean) and 2 s from a start or a seek to the first sound
     * (required_lead_time_ms). aiosendspin honours up to 30 s of each. `available` replaces the legacy `state`.
     */
    const MIN_BUFFER_MS = 5000, LEAD_TIME_MS = 2000;
    function sendState() {
        sendJson('client/state', { available: true, player: { state: 'synchronized', volume: st.volume, muted: st.muted, output_delay_ms: 0,
            required_lead_time_ms: LEAD_TIME_MS, min_buffer_ms: MIN_BUFFER_MS, supported_commands: ['volume', 'mute'] } });
    }
    function timeTick() { sendJson('client/time', { client_transmitted: nowUs() }); }
    function onTime(p) {
        const t4 = nowUs();
        const delay = (t4 - p.client_transmitted) - (p.server_transmitted - p.server_received);
        const off = ((p.server_received - p.client_transmitted) + (p.server_transmitted - t4)) / 2;
        samples.push([delay, off]);
        if (samples.length > 12) samples.shift();
        // the exchange with the least delay is the truest
        offset = samples.reduce((a, b) => (b[0] < a[0] ? b : a))[1];
        if (clockOff === null) clockOff = offset;
        if (!stateSent) {
            stateSent = true;
            sendState();
        }
    }
    function mergeMeta(m) {
        const cur = st.meta || {};
        const n = Object.assign({}, cur);
        ['title', 'artist', 'album', 'album_artist', 'year', 'track', 'repeat', 'shuffle'].forEach((k) => { if (k in m) n[k] = m[k]; });
        if ('progress' in m) {
            const p = m.progress;
            n.progressMs = p ? p.track_progress : null; n.durationMs = p ? p.track_duration : null; n.speed = p ? p.playback_speed : 0;
            n.progressAt = Date.now();
        }
        st.meta = n;
    }
    function onText(text) {
        let m;
        try { m = JSON.parse(text); } catch (e) { return; }
        const type = m.type, p = m.payload || {};
        if (type === 'auth_ok') { log('Sendspin: signed in'); hello(); return; }
        if (type === 'server/time') return onTime(p);
        if (type === 'server/hello') {
            st.connectedAt = Date.now(); setConn('connected');
            log('Sendspin: connected to ' + (p.name || '?') + ', roles ' + (p.active_roles || []).join(', '));
            timeTick(); setTimeout(timeTick, 150); setTimeout(timeTick, 300);
            setTimeout(() => playerId().catch(() => {}), 1500);
            return;
        }
        if (type === 'group/update') { if (p.playback_state) st.playback = p.playback_state; st.group = p.group_name || st.group; emitStatus(); return; }
        if (type === 'server/state') {
            if (p.metadata) mergeMeta(p.metadata);
            if (p.controller) { st.controller = p.controller; }
            emitStatus();
            return;
        }
        if (type === 'stream/start') {
            if (p.player) {
                const f = p.player;
                const key = [f.codec, f.sample_rate, f.channels, f.bit_depth].join(' ');
                if (!st.format || st.format.key !== key) {
                    if (st.format && st.format.codec !== f.codec) resetHeader();
                    st.format = { key, codec: f.codec, rate: f.sample_rate, channels: f.channels, bits: f.bit_depth };
                    log('Sendspin: stream ' + key);
                }
                resetQueue();
                Object.assign(stats, { chunks: 0, overlaps: 0, gaps: 0, late: 0, handed: 0, since: Date.now() });
                sink.format(st.format);
                sink.volume(st.muted ? 0 : st.volume / 100);
            }
            emitStatus();
            return;
        }
        if (type === 'stream/clear' || type === 'stream/end') {
            const roles = p.roles;
            if (!roles || roles.indexOf('player') >= 0 || roles.indexOf('player@v1') >= 0) {
                if (type === 'stream/clear' && p.from_timestamp != null && offset !== null) {
                    // only what is at or after from_timestamp goes; the rest plays on
                    queueA = queueA.filter((c) => c.ts < p.from_timestamp);
                    lastEnd = queueA.length ? queueA[queueA.length - 1].end : 0;
                    emitStatus();
                    return;
                }
                resetQueue(); hdrWait = [];
                sink.clear();
                if (type === 'stream/end') { st.format = null; }
            }
            if (type === 'stream/end' && (!roles || roles.some((r) => /^artwork/.test(r)))) { /* artwork kept until a new one */ }
            emitStatus();
            return;
        }
        if (type === 'server/command') {
            const c = p.player || {};
            if (c.command === 'volume' && c.volume != null) st.volume = c.volume;
            if (c.command === 'mute' && c.mute != null) st.muted = !!c.mute;
            sink.volume(st.muted ? 0 : st.volume / 100);
            sendState();
            emitStatus();
            return;
        }
        if (type === 'server/error') { log('Sendspin: server error ' + JSON.stringify(p).slice(0, 200)); return; }
    }
    function readTs(b) { return b.readInt32BE(1) * 4294967296 + b.readUInt32BE(5); }
    /*
     * An audio chunk's header: type (1) and timestamp (8), then the audio, as aiosendspin 10.2.1 (Music Assistant
     * 2.10.12) sends it to this client; the newer spec adds send_ahead (4 more bytes, 13 in all). 0.1.0-0.1.3 cut 13
     * and fed the decoder packets without their first 4 bytes: the metallic noise in the car. The length is found
     * on the first two chunks of a stream: the one where the audio's length (an Opus packet's TOC, or PCM bytes) is
     * the step between their timestamps, the first byte the same Opus TOC, and bytes 9-12 a plausible send_ahead
     * (under 10 min) in both: 13; else 9. For PCM: the one whose audio lasts exactly that step.
     */
    let hdr = null, hdrWait = [];
    function headerOf(a, b) {
        const f = st.format || {}, dt = readTs(b) - readTs(a);
        // bytes 9-12 as send_ahead: a lead under 10 min in both (an Opus TOC there, 0xfc for music, is far more)
        const lead = (x) => x.length > 13 ? x.readUInt32BE(9) : Infinity;
        const plausible = lead(a) < 600e6 && lead(b) < 600e6;
        if (f.codec === 'opus') {
            const fits = (h) => {
                if (a.length <= h || b.length <= h) return false;
                const d = opusSamples(a.slice(h)) * 1e6 / 48000;
                return !!d && Math.abs(d - dt) <= 2000 && a[h] === b[h];
            };
            // 13 first: with 13, byte 9 (send_ahead's top byte, often 0x00 or 0x01) can pass for a TOC too
            if (plausible && fits(13)) return 13;
            return 9;
        }
        // PCM: the header whose audio lasts exactly the step between the timestamps (4 bytes are one frame, ~21 µs)
        const bpf = (f.channels || 2) * ((f.bits || 16) / 8), rate = f.rate || 48000;
        for (const h of [9, 13]) {
            const bytes = a.length - h;
            if (bytes > 0 && bytes % bpf === 0 && Math.abs(bytes / bpf * 1e6 / rate - dt) <= 5) return h;
        }
        return plausible ? 13 : 9;
    }
    function onBinary(b) {
        const kind = b[0];
        if (kind === 4 && b.length >= 9) {
            if (offset === null || !st.format) return;
            if (hdr === null) {
                hdrWait.push(b);
                if (hdrWait.length < 2) return;
                hdr = headerOf(hdrWait[0], hdrWait[1]);
                st.audioHeader = hdr;
                log('Sendspin: audio chunks have a ' + hdr + '-byte header');
                const w = hdrWait; hdrWait = [];
                w.forEach(audioChunk);
                return;
            }
            return audioChunk(b);
        }
        if (kind >= 8 && kind <= 11) {
            if (kind !== 8) return;   // channel 0: the album's
            const png = b.slice(9);
            art = png.length > 8 ? Buffer.from(png) : null;
            st.artVer++;
            o.onArt && o.onArt(art, st.artVer);
            emitStatus();
        }
    }
    function audioChunk(b) {
        {
            if (b.length <= hdr) return;
            const ts = readTs(b), t = ts - clockOff, data = b.slice(hdr);
            const end = ts + chunkUs(data);
            stats.chunks++;
            st.lastAudioAt = Date.now();
            // a chunk over sound already queued (a catch-up, a resend): the first one stays, so one encoder's packets
            // go to the decoder in order
            if (lastEnd && ts < lastEnd - 2000) { stats.overlaps++; return; }
            if (lastEnd && ts > lastEnd + 2000) stats.gaps++;
            queueA.push({ t, ts, end, data });
            lastEnd = end;
        }
    }
    let lastPump = 0, lastEmit = 0;
    function pump() {
        const now = nowUs();
        if (offset !== null) {
            const d = offset - clockOff, step = Math.max(1, (now - (lastPump || now)) * 0.005);   // 5 ms a second
            if (clockOff === null || Math.abs(d) > 200000) clockOff = offset;
            else clockOff += Math.max(-step, Math.min(step, d));
        }
        lastPump = now;
        // the Status page's stream counts, fresh while music comes
        if (queueA.length && Date.now() - lastEmit > 1000) { lastEmit = Date.now(); emitStatus(); }
        if (!queueA.length) { st.ahead = 0; return; }
        let n = 0;
        // each chunk's time on our clock now (the server's time less the offset the sound goes by)
        while (queueA.length && queueA[0].ts - clockOff - now <= LEAD_US) {
            const c = queueA.shift(), t = c.ts - clockOff;
            if (now - t > LATE_US) { n++; continue; }
            sink.audio(c.data, t);
            stats.handed++;
        }
        if (n) { stats.late += n; log('Sendspin: dropped ' + n + ' late chunks'); }
        st.ahead = queueA.length ? Math.round((queueA[queueA.length - 1].ts - clockOff - now) / 1000) : 0;
    }

    function connect() {
        if (stopped || !account) return;
        clearTimeout(retry);
        const u = account.server.replace(/^http/i, 'ws') + '/sendspin';
        setConn('connecting');
        offset = null; clockOff = null; samples.length = 0; stateSent = false; resetQueue(); resetHeader();
        const s = ws.connect({ url: u, connect: (a) => nx.socket(a), readyEvent: /^wss:/.test(u) ? 'secureConnect' : 'connect' });
        sock = s;
        s.on('open', () => { s.send(JSON.stringify({ type: 'auth', token: account.token })); });
        s.on('message', (t) => { if (sock === s) onText(t); });
        s.on('binary', (b) => { if (sock === s) onBinary(b); });
        s.on('error', (e) => { if (sock === s) { st.error = e.message; log('Sendspin: ' + e.message); } });
        s.on('close', (code, why) => {
            if (sock !== s) return;
            sock = null;
            clearInterval(timeTimer);
            if (stopped) return;
            st.reconnects++;
            const wait = Math.min(30000, 2000 * Math.min(st.reconnects, 10));
            log('Sendspin: closed (' + code + (why ? ' ' + why : '') + '), again in ' + wait / 1000 + ' s; ' + Math.round(st.ahead / 1000) + ' s of sound still queued');
            setConn('reconnecting', why || String(code));
            if (code === 4001) { ev.emit('signed-out', 'the server refused the sign-in: ' + (why || '')); return; }
            retry = setTimeout(connect, wait);
        });
        clearInterval(timeTimer);
        timeTimer = setInterval(() => { if (sock && st.conn === 'connected') timeTick(); }, 5000);
    }

    function run(acc) {
        account = acc;
        stopped = false;
        st.reconnects = 0; st.playerId = null; rowsCache = null;
        clearInterval(pumpTimer);
        pumpTimer = setInterval(pump, 20);
        connect();
    }
    function stop() {
        stopped = true;
        clearTimeout(retry); clearInterval(timeTimer); clearInterval(pumpTimer);
        resetQueue();
        if (sock) { const s = sock; sock = null; try { s.close(); } catch (e) { /* gone */ } }
        sink.clear();
        st.conn = 'signed-out'; st.format = null;
        emitStatus();
    }
    function status() {
        return Object.assign({}, st, { meta: st.meta ? Object.assign({}, st.meta) : null, signedIn: !!account, server: account ? account.server : null,
            stream: Object.assign({}, stats) });
    }
    async function signOut() {
        const a = account;
        stop();
        account = null;
        // the long-lived token made at sign-in: revoked on the server (best effort)
        if (a) {
            try {
                const toks = await request(a.server + '/api', { command: 'auth/tokens', args: {} }, a.token);
                const mine = (toks || []).filter((t) => t && t.name === TOKEN_NAME);
                for (const t of mine) await request(a.server + '/api', { command: 'auth/token/revoke', args: { token_id: t.token_id } }, a.token).catch(() => {});
            } catch (e) { /* offline: it expires in a year */ }
        }
    }

    return Object.assign(ev, { login, withToken, run, stop, signOut, api, home, row, library, search, open, play, control, queue, image, status,
        art: () => art, account: () => account });
}

module.exports = { createMa, serverUrl, slim, nowUs, opusSamples, LEAD_US };
