'use strict';
/**
 * client.js - the Emby client, a child of service.js running as the tool's internet uid (component.json
 * "uids": mgu-uplink routes it, never root). It holds no file of its own: the account comes from the
 * parent over IPC, and everything it learns goes back the same way.
 *
 *   parent -> { op: 'run', account } | { op: 'signin', id, server, user, password } | { op: 'signout' } | { op: 'stop' }
 *   child  -> { ev: 'status', status } | { ev: 'signin', id, ok, account | error } | { ev: 'play' | 'playstate' |
 *             'command', data } | { ev: 'signed-out', why } | { ev: 'log', line }
 */
const { createNet } = require('./netx');
const { createClient } = require('./emby');

const send = (m) => { try { if (process.connected) process.send(m); } catch (e) { /* the parent is gone */ } };
const log = (line) => send({ ev: 'log', line });

const nx = createNet({ leasePath: process.env.EMBY_LEASE || undefined, systemDns: process.env.EMBY_SYSTEM_DNS === '1' });
const device = { id: process.env.EMBY_DEVICE_ID || 'aurelm-emby-unknown', name: process.env.EMBY_DEVICE_NAME || 'BMW iDrive' };
const c = createClient({ nx, device, version: process.env.EMBY_VERSION || '0.0.0', log });

c.on('status', (status) => send({ ev: 'status', status }));
c.on('play', (data) => send({ ev: 'play', data }));
c.on('playstate', (data) => send({ ev: 'playstate', data }));
c.on('command', (data) => send({ ev: 'command', data }));
c.on('signed-out', (why) => send({ ev: 'signed-out', why }));

process.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.op === 'run') c.run(m.account);
    else if (m.op === 'stop') c.stop();
    else if (m.op === 'signout') c.signOut().then(() => send({ ev: 'signed-out', why: 'signed out' }));
    else if (m.op === 'signin') {
        c.signIn(m.server, m.user, m.password)
            .then((account) => send({ ev: 'signin', id: m.id, ok: true, account }))
            .catch((e) => send({ ev: 'signin', id: m.id, ok: false, error: e.message }));
    }
});
// the parent went: so do we
process.on('disconnect', () => { c.stop(); process.exit(0); });
send({ ev: 'ready', uid: process.getuid ? process.getuid() : null });
