'use strict';
const path = require('node:path');
const rootDirectory = path.resolve(__dirname, '..');
if (require('node:fs').existsSync(path.join(rootDirectory, '.env'))) process.loadEnvFile(path.join(rootDirectory, '.env'));
const { migrateLegacyStorage } = require('../utils/sqliteMigration');
const { closeSharedStorage } = require('../utils/sharedStorage');

async function main() {
    const args = process.argv.slice(2); let dataDir, maxLegacyMb = 256;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--help') {
            console.log('Stop the fleet before offline migration.\nUsage: node scripts/fleet-storage-migrate.js [--data-dir DIR] [--max-legacy-mb 256]\nValid original JSON files are retained. Existing indexed users take precedence.');
            return;
        }
        if (args[i] === '--data-dir' && args[i + 1]) dataDir = args[++i];
        else if (args[i] === '--max-legacy-mb' && args[i + 1]) maxLegacyMb = Number(args[++i]);
        else throw new TypeError(`Unsupported migration argument: ${args[i]}`);
    }
    if (!Number.isInteger(maxLegacyMb) || maxLegacyMb < 1 || maxLegacyMb > 2048) throw new TypeError('--max-legacy-mb must be an integer from 1 to 2048.');
    const config = require('../config');
    const root = path.resolve(dataDir || process.env.DATA_DIR || config.DATA_DIR || path.join(__dirname, '..', 'data'));
    const result = await migrateLegacyStorage(root, { maxLegacyBytes: maxLegacyMb * 1024 * 1024 });
    console.log('SQLite migration complete; originals retained.'); console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(`Migration failed: ${error.message}`); process.exitCode = 1; }).finally(() => closeSharedStorage().catch(error => { console.error(`Storage close failed: ${error.message}`); process.exitCode = 1; }));
