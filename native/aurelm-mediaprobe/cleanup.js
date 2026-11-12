'use strict';
// The files the 1046 tests played (the play folder: copies of the test files, a growing file, a named pipe) removed.
// Runs as the service's ExecStopPost (also after a crash or a kill) and as the tool's deactivate (an uninstall, before
// anything else goes). The SOME/IP changes (routes, button forwarding, CarLife's fields) are undone by the service
// itself as it ends; a route a crash left is disconnected at its next start (routes.js). Never fails: a failing
// deactivate would refuse the removal.
const fs = require('fs');
const path = require('path');
const dir = process.env.PROBE_PLAY || '/var/opt/aurelm-mediaprobe/play';
try {
    let n = 0;
    fs.readdirSync(dir).forEach((f) => { try { fs.unlinkSync(path.join(dir, f)); n++; } catch (e) { /* busy */ } });
    if (n) console.log('aurelm-mediaprobe: removed ' + n + ' played files');
} catch (e) { /* none */ }
process.exit(0);
