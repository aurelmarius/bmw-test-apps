'use strict';
/**
 * tone.js - a test tone into SmartXbar's CarLife input (source 287), for the probe's "287" test: started by the
 * service as root, it becomes nobody with the groups mgu_alsa and audio itself (Node gives a spawned child no
 * supplementary groups; the smartx sound plugin refuses root and the tools' uids: Emby's player, 0.2.1), then plays
 * the file again and again with the unit's aplay, if it has one.
 *
 *   node tone.js <file.wav> [device]       one JSON line per event on stdout: {"ev":"playing"} | {"ev":"error",...}
 */
const fs = require('fs');
const cp = require('child_process');

const DEVICE = 'plug:smartx:CarLifeMedia_CF_48_STEREO';   // emby-player's default (native/emby-player/src/player.cpp)
const say = (o) => { try { process.stdout.write(JSON.stringify(o) + '\n'); } catch (e) { /* gone */ } };

function which(name) {
    const dirs = (process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':');
    for (const d of dirs) { try { fs.accessSync(d + '/' + name, fs.constants.X_OK); return d + '/' + name; } catch (e) { /* next */ } }
    return null;
}

function main(argv) {
    const file = argv[0], dev = argv[1] || DEVICE;
    const aplay = which('aplay');
    if (!aplay) { say({ ev: 'error', error: 'no aplay on this unit: the route is made, but no sound plays' }); process.exit(2); }
    if (process.getuid && process.getuid() === 0) {
        const groups = [];
        ['mgu_alsa', 'audio'].forEach((g) => { try { process.setgroups(groups.concat([g])); groups.push(g); } catch (e) { /* no such group */ } });
        try { process.setgroups(groups); process.setgid('nobody'); process.setuid('nobody'); }
        catch (e) { say({ ev: 'error', error: 'dropping root: ' + e.message }); process.exit(2); }
        say({ ev: 'user', uid: process.getuid(), groups: groups });
    }
    let child = null, stopping = false;
    const play = () => {
        if (stopping) return;
        child = cp.spawn(aplay, ['-q', '-D', dev, file], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d) => { err += d; });
        child.on('exit', (code) => {
            if (stopping) return;
            if (code !== 0) { say({ ev: 'error', error: 'aplay ' + code + ': ' + err.trim().split('\n').pop() }); process.exit(1); }
            play();
        });
    };
    say({ ev: 'playing', aplay, device: dev });
    play();
    const end = () => { stopping = true; if (child) { try { child.kill('SIGTERM'); } catch (e) { /* gone */ } } setTimeout(() => process.exit(0), 100); };
    process.on('SIGTERM', end);
    process.on('SIGINT', end);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { DEVICE, which };
