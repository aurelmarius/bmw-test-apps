'use strict';
// Removes every firewall rule the sign-in page put in, so the firewall is as the unit had it. Runs as the
// service's ExecStopPost (also after a crash or a kill) and as the tool's deactivate (an uninstall, before
// anything else goes). Never fails: a failing deactivate would refuse the removal.
try {
    const n = require('./nft').remove();
    if (n) console.log('aurelm-emby: removed ' + n + ' firewall rules');
} catch (e) {
    console.log('aurelm-emby cleanup: ' + (e && e.message));
}
process.exit(0);
