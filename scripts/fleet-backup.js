'use strict';
// Run after stopping the fleet. Same-process service.backup() also supports
// online maintenance; an unrelated process cannot freeze the fleet's writes.
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
if (require('node:fs').existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const { backupSharedStorage, closeSharedStorage } = require('../utils/sharedStorage');
async function main() {
    const configured = process.argv[2];
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.resolve(configured || path.join(__dirname, '..', 'backups', stamp));
    const result = await backupSharedStorage(destination);
    const dataDir = require('../utils/dataPaths').dataDirectory();
    for (const name of ['fleet-state.json', 'fleet-state.json.previous', '.web-player.key']) {
        await fs.copyFile(path.join(dataDir, name), path.join(destination, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    // Local uploads are durable user content; include them when present.
    const uploads = path.join(dataDir, 'uploads');
    if (await fs.stat(uploads).then(s => s.isDirectory()).catch(error => { if (error.code === 'ENOENT') return false; throw error; })) await fs.cp(uploads, path.join(destination, 'uploads'), { recursive: true, errorOnExist: true, force: false });
    console.log('[Fleet backup]', result.dataDir);
}
main().catch(error => { console.error('[Fleet backup]', error.message); process.exitCode = 1; }).finally(() => closeSharedStorage());
