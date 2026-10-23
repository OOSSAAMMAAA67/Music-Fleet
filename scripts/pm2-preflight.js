'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function loadEnvironment() {
    const file = path.join(root, '.env');
    if (fs.existsSync(file)) process.loadEnvFile(file);
}
function checkPm2() {
    loadEnvironment();
    require('../utils/nodeRuntime').assertSupportedRuntime();
    const { apps: [app] } = require('../ecosystem.config.cjs');
    if (!path.isAbsolute(app.interpreter)) throw new Error('MUSIC_NODE_EXECUTABLE must be an absolute path to node.exe.');
    const probe = spawnSync(app.interpreter, ['-e', 'require(process.argv[1]).assertSupportedRuntime(); console.log(process.version)', path.join(root, 'utils', 'nodeRuntime.js')], {
        encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    if (probe.error || probe.status !== 0) throw new Error('Selected Node interpreter is unavailable or unsupported: ' + (probe.error?.message || probe.stderr.trim()));
    const info = require('pm2/package.json');
    if (info.version !== '7.0.4') throw new Error('Install the locked PM2 7.0.4 dependency with npm ci before deployment.');
    if (app.instances !== 1 || app.exec_mode !== 'fork') throw new Error('This fleet needs exactly one PM2 fork process.');
    return { pm2: info.version, node: probe.stdout.trim(), interpreter: app.interpreter, cwd: app.cwd, killTimeout: app.kill_timeout };
}
if (require.main === module) {
    try { console.log(JSON.stringify(checkPm2(), null, 2)); }
    catch (error) { console.error('[PM2] ' + error.message); process.exitCode = 1; }
}
module.exports = { checkPm2, loadEnvironment };
