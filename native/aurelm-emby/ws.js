'use strict';
/**
 * ws.js - a small WebSocket client (RFC 6455) for the Emby server's /embywebsocket: text frames, ping/pong,
 * close. Node 8 has none built in, and the tool carries no npm modules.
 *
 *   const ws = connect({ url: 'wss://host/embywebsocket?...', connect: (opts) => socket, headers: {...} });
 *   ws.on('open' | 'message' (text) | 'close' (code, why) | 'error' (err))
 *   ws.send(text); ws.ping(); ws.close();
 *
 * `connect(opts)` makes the socket (net or tls), so the caller chooses the address (the uplink's DNS) and
 * the certificates; the handshake and the frames are done here.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MAX_FRAME = 4 * 1024 * 1024;   // Emby's messages are small JSON; anything larger is refused

function frame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ''), 'utf8');
    const len = data.length;
    const head = len < 126 ? 2 : len < 65536 ? 4 : 10;
    const buf = Buffer.alloc(head + 4 + len);
    buf[0] = 0x80 | opcode;
    if (len < 126) buf[1] = 0x80 | len;
    else if (len < 65536) { buf[1] = 0x80 | 126; buf.writeUInt16BE(len, 2); }
    else { buf[1] = 0x80 | 127; buf.writeUInt32BE(0, 2); buf.writeUInt32BE(len, 6); }
    const mask = crypto.randomBytes(4);
    mask.copy(buf, head);
    for (let i = 0; i < len; i++) buf[head + 4 + i] = data[i] ^ mask[i & 3];
    return buf;
}

/** parses complete frames off `buf`; returns { frames: [{ fin, opcode, payload }], rest } or throws */
function parseFrames(buf) {
    const frames = [];
    let off = 0;
    for (;;) {
        if (buf.length - off < 2) break;
        const b0 = buf[off], b1 = buf[off + 1];
        let len = b1 & 0x7f, p = off + 2;
        if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
        else if (len === 127) {
            if (buf.length - p < 8) break;
            if (buf.readUInt32BE(p) !== 0) throw new Error('frame too large');
            len = buf.readUInt32BE(p + 4); p += 8;
        }
        if (len > MAX_FRAME) throw new Error('frame too large');
        const masked = (b1 & 0x80) !== 0;
        let mask = null;
        if (masked) { if (buf.length - p < 4) break; mask = buf.slice(p, p + 4); p += 4; }
        if (buf.length - p < len) break;
        let payload = Buffer.from(buf.slice(p, p + len));
        if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
        frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
        off = p + len;
    }
    return { frames, rest: buf.slice(off) };
}

function connect(o) {
    const ws = new EventEmitter();
    const u = require('url').parse(o.url);
    const key = crypto.randomBytes(16).toString('base64');
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    let sock = null, open = false, closed = false, buf = Buffer.alloc(0), parts = [], timer = null;

    function finish(code, why) {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        try { sock.destroy(); } catch (e) { /* gone */ }
        ws.emit('close', code, why);
    }
    ws.send = (text) => { if (open && !closed) sock.write(frame(1, text)); };
    ws.ping = () => { if (open && !closed) sock.write(frame(9, '')); };
    ws.close = () => {
        if (closed) return;
        if (open) { try { sock.write(frame(8, Buffer.from([0x03, 0xe8]))); } catch (e) { /* gone */ } }
        finish(1000, 'closed by us');
    };
    ws.isOpen = () => open && !closed;

    try { sock = o.connect({ host: u.hostname, port: Number(u.port) || (u.protocol === 'wss:' ? 443 : 80), tls: u.protocol === 'wss:' }); }
    catch (e) { setImmediate(() => { ws.emit('error', e); finish(1006, e.message); }); return ws; }
    timer = setTimeout(() => { ws.emit('error', new Error('no answer to the WebSocket handshake')); finish(1006, 'timeout'); }, o.timeoutMs || 15000);
    sock.on('error', (e) => { ws.emit('error', e); finish(1006, e.code || e.message); });
    sock.on('close', () => finish(1006, 'connection lost'));
    sock.on(o.readyEvent || 'connect', () => {
        const hdr = Object.assign({
            Host: u.host, Upgrade: 'websocket', Connection: 'Upgrade',
            'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        }, o.headers || {});
        sock.write('GET ' + (u.path || '/') + ' HTTP/1.1\r\n' + Object.keys(hdr).map((k) => k + ': ' + hdr[k]).join('\r\n') + '\r\n\r\n');
    });
    sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!open) {
            const end = buf.indexOf('\r\n\r\n');
            if (end < 0) { if (buf.length > 16384) finish(1002, 'bad handshake'); return; }
            const head = buf.slice(0, end).toString('latin1').split('\r\n');
            buf = buf.slice(end + 4);
            const status = /^HTTP\/1\.1 (\d+)/.exec(head[0]);
            const h = {};
            head.slice(1).forEach((l) => { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); });
            if (!status || status[1] !== '101' || h['sec-websocket-accept'] !== accept) {
                ws.emit('error', new Error('the server refused the WebSocket: ' + (head[0] || '?')));
                finish(1002, head[0] || 'bad handshake');
                return;
            }
            open = true;
            clearTimeout(timer);
            ws.emit('open');
        }
        let res;
        try { res = parseFrames(buf); } catch (e) { ws.emit('error', e); finish(1009, e.message); return; }
        buf = res.rest;
        res.frames.forEach((f) => {
            if (closed) return;
            if (f.opcode === 9) { sock.write(frame(10, f.payload)); return; }
            if (f.opcode === 10) { ws.emit('pong'); return; }
            if (f.opcode === 8) {
                const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
                try { sock.write(frame(8, f.payload.slice(0, 2))); } catch (e) { /* gone */ }
                finish(code, f.payload.slice(2).toString('utf8') || 'closed by the server');
                return;
            }
            if (f.opcode === 1 || f.opcode === 2 || f.opcode === 0) {
                parts.push(f.payload);
                if (!f.fin) return;
                const text = Buffer.concat(parts).toString('utf8');
                parts = [];
                ws.emit('message', text);
            }
        });
    });
    return ws;
}

module.exports = { connect, frame, parseFrames };
