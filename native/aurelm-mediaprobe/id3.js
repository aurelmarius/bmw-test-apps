'use strict';
/**
 * id3.js - an ID3v2.3 tag for the front of an MP3: title, artist, album and a front cover. The BMW media engine reads
 * them when it plays the file (playFile on source 1046), and the HMI's media screen and the instrument cluster show
 * them (Media Probe 0.1.2 in the car: "Probe MP3", "Media Probe", the cover, the progress).
 *
 *   const tag = id3({ title, artist, album, cover: { mime: 'image/png' | 'image/jpeg', data: Buffer } });
 *   fs.writeFileSync(file, Buffer.concat([tag, mp3Frames]));
 */

function syncsafe(n) {
    return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}
function frame(id, body) {
    const h = Buffer.alloc(10);
    h.write(id, 0, 'latin1');
    h.writeUInt32BE(body.length, 4);   // v2.3: a plain 32-bit size
    return Buffer.concat([h, body]);
}
/** a text frame in UTF-16 with a BOM (encoding 1): any script */
function text(id, s) {
    const str = Buffer.from('﻿' + String(s), 'utf16le');
    return frame(id, Buffer.concat([Buffer.from([1]), str, Buffer.from([0, 0])]));
}

function id3(o) {
    const frames = [];
    if (o.title) frames.push(text('TIT2', o.title));
    if (o.artist) frames.push(text('TPE1', o.artist));
    if (o.album) frames.push(text('TALB', o.album));
    if (o.cover && o.cover.data) {
        // APIC: encoding 0, the MIME type, picture type 3 (front cover), an empty description, the picture
        frames.push(frame('APIC', Buffer.concat([Buffer.from([0]), Buffer.from(o.cover.mime || 'image/jpeg', 'latin1'), Buffer.from([0, 3, 0]), o.cover.data])));
    }
    const body = Buffer.concat(frames);
    return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), syncsafe(body.length), body]);
}

module.exports = { id3 };
