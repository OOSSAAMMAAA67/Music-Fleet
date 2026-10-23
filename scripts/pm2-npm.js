'use strict';
// Invoke npm's JS entry with the same Node selected by the Windows launcher.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pathEntry = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH');
const pathValue = pathEntry?.[1] || '';
const directories = [path.dirname(process.execPath), ...pathValue.split(path.delimiter).filter(Boolean)];
const npmCli = directories.map(directory => path.join(directory.replace(/^"|"$/g, ''), 'node_modules', 'npm', 'bin', 'npm-cli.js')).find(filename => fs.existsSync(filename));
if (!npmCli) {
    console.error('Install npm with Node.js or place its installation directory on PATH.'); process.exitCode = 1;
} else {
    const env = { ...process.env, [pathEntry?.[0] || 'PATH']: path.dirname(process.execPath) + path.delimiter + pathValue };
    const child = spawnSync(process.execPath, [npmCli, ...process.argv.slice(2)], { windowsHide: true, stdio: 'inherit', env });
    if (child.error) console.error(child.error.message);
    process.exitCode = child.status == null ? 1 : child.status;
}
