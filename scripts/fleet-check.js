'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
try {
    require('../utils/nodeRuntime').assertSupportedRuntime();
    const config = require('../config');
    require('../utils/fleetRuntime').validateRuntimeConfiguration(config);
    const definitions = require('../utils/fleetConfig').loadBotDefinitions(config, { baseDir: root });
    const owners = [process.env.OWNER_ID || config.OWNER_ID, ...(config.OWNER_IDS || [])].filter(Boolean);
    if (!owners.length || owners.some(id => !/^\d{5,32}$/.test(String(id)))) throw new Error('Configure valid OWNER_ID/OWNER_IDS.');
    console.log(JSON.stringify({ ok: true, bots: definitions.length, primaryKey: definitions[0].key, rootOwners: owners.length, storage: process.env.STORAGE_BACKEND || config.STORAGE_BACKEND || 'sqlite', audioPipeline: require('../utils/fleetRuntime').chooseAudioPipeline(definitions.length, config) }, null, 2));
} catch (error) { console.error('[Fleet config]', error.message); process.exitCode = 1; }
