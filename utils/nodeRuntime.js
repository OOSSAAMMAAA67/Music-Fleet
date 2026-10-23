'use strict';
const MINIMUM_NODE = '22.16.0';

function inspectRuntime({ version = process.versions.node, loadSqlite = () => require('node:sqlite') } = {}) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version));
    const major = Number(match?.[1]), minor = Number(match?.[2]);
    if (!match || !(major === 22 && minor >= 16 || major >= 24)) {
        throw Object.assign(new Error(`Node 22.16+ or 24+ is required; current ${version}.`), { code: 'NODE_VERSION_UNSUPPORTED' });
    }
    let sqlite;
    try { sqlite = loadSqlite(); }
    catch (cause) { throw Object.assign(new Error('This Node runtime has no SQLite support. Use Node 22.16+ or 24+ with node:sqlite enabled.', { cause }), { code: 'NODE_SQLITE_UNAVAILABLE' }); }
    if (typeof sqlite?.DatabaseSync !== 'function' || typeof sqlite?.backup !== 'function') {
        throw Object.assign(new Error('The SQLite database and backup APIs are required. Update Node 22 or 24 to its current patch release.'), { code: 'NODE_SQLITE_UNAVAILABLE' });
    }
    return { node: String(version).replace(/^v/, ''), platform: process.platform, arch: process.arch, minimumNode: MINIMUM_NODE, sqlite: true, backup: true };
}

function assertSupportedRuntime(options) { return inspectRuntime(options); }
module.exports = { MINIMUM_NODE, inspectRuntime, assertSupportedRuntime };
