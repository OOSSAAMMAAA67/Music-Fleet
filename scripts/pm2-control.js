'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const allowed = new Set(['start', 'restart', 'stop', 'delete', 'status', 'logs', 'save', 'resurrect']);
function main(action = process.argv[2]) {
    if (!allowed.has(action)) throw new Error('Usage: node scripts/pm2-control.js start|restart|stop|delete|status|logs|save|resurrect');
    const { checkPm2, loadEnvironment } = require('./pm2-preflight'); loadEnvironment();
    // An explicit project home prevents commands affecting unrelated PM2 apps.
    const configuredHome = process.env.PM2_HOME;
    if (configuredHome && !path.isAbsolute(configuredHome)) throw new Error('PM2_HOME must be an absolute directory.');
    process.env.PM2_HOME = configuredHome || path.join(root, '.pm2');
    fs.mkdirSync(process.env.PM2_HOME, { recursive: true });
    const report = checkPm2();
    if (action === 'start' || action === 'restart') {
        for (const script of ['dependency-preflight.js', 'fleet-check.js']) {
            const check = spawnSync(report.interpreter, [path.join(__dirname, script)], { cwd: root, env: process.env, windowsHide: true, stdio: 'inherit' });
            if (check.error || check.status !== 0) throw new Error('Fleet validation failed. Fix the preceding error before starting PM2.');
        }
    }
    const configActions = new Set(['start', 'restart', 'stop', 'delete']);
    const args = [path.join(path.dirname(require.resolve('pm2/package.json')), 'bin', 'pm2'), action];
    if (configActions.has(action)) args.push(path.join(root, 'ecosystem.config.cjs'));
    if (action === 'restart') args.push('--update-env');
    const child = spawnSync(report.interpreter, args, { cwd: root, env: process.env, windowsHide: true, stdio: 'inherit' });
    if (child.error) throw child.error;
    process.exitCode = child.status == null ? 1 : child.status;
}
if (require.main === module) {
    try { main(); } catch (error) { console.error('[PM2] ' + error.message); process.exitCode = 1; }
}
module.exports = { main };
