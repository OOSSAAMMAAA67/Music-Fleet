'use strict';
// This module is an offline maintenance path. Its global JSON parse and
// synchronous bulk writes must not be run on a playback request handler.
const fs = require('node:fs/promises');
const path = require('node:path');
const { openDatabase, Records, storageError } = require('./sqliteDatabase');
const { getSharedStorage } = require('./sharedStorage');
const { safeTrack } = require('./favoritesStore');

async function readLegacy(filename, maxBytes) {
    let text;
    try {
        const stat = await fs.stat(filename);
        if (stat.size > maxBytes) throw storageError('Legacy file exceeds the chosen migration memory limit.', 'STORAGE_MIGRATION_SIZE');
        text = await fs.readFile(filename, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    try { return JSON.parse(text); }
    catch (cause) { throw storageError('Legacy library is corrupt; originals have been preserved.', 'STORAGE_MIGRATION_CORRUPT', cause); }
}
async function* files(directory) {
    let handle;
    try { handle = await fs.opendir(directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for await (const item of handle) {
        const filename = path.join(directory, item.name);
        if (item.isDirectory()) yield* files(filename);
        else if (item.isFile()) yield filename;
    }
}
async function firstFavorite(dataDir, id, maxBytes) {
    const sharded = path.join(dataDir, 'favorites', id.slice(0, 2), id.slice(2, 4) || '00', `${id}.json`);
    for (const filename of [sharded, `${sharded}.previous`, path.join(dataDir, 'favorites', `${id}.json`)]) {
        const value = await readLegacy(filename, maxBytes); if (value !== undefined) return value;
    }
    return undefined;
}
function importFavorite(records, id, value, global = false) {
    if (records.get('favorites', id)) return false;
    if (!value || !Array.isArray(value.tracks) || value.tracks.length > 10000
        || !global && (value.userId != null && value.userId !== id || value.version != null && value.version !== 2)) {
        throw storageError(`Legacy favorites for user ${id} has an invalid schema; originals have been preserved.`, 'FAVORITES_STORE_CORRUPT');
    }
    const stamp = new Date().toISOString();
    records.set('favorites', id, { version: 2, userId: id, tag: String(value.tag || 'Unknown').slice(0, 100),
        createdAt: value.createdAt || stamp, updatedAt: value.updatedAt || stamp, tracks: value.tracks.map(safeTrack) });
    return true;
}
async function migrateLegacyStorage(dataDir, { maxLegacyBytes = 256 * 1024 * 1024 } = {}) {
    const root = path.resolve(dataDir);
    const maxBytes = Number(maxLegacyBytes);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 2 * 1024 * 1024 * 1024) throw new TypeError('Migration limit must be between 1 KiB and 2 GiB.');
    const service = getSharedStorage({ dataDir: root, maxLegacyBytes: maxBytes });
    const favorites = openDatabase(path.join(root, 'favorites.sqlite'), { synchronous: true }), records = new Records(favorites);
    const result = { favoritesImported: 0, favoritesAlreadyIndexed: 0, historyFiles: 0, playlistFiles: 0, platformFiles: 0, originalsRetained: true };
    try {
        for await (const filename of files(path.join(root, 'favorites'))) {
            const match = /^(\d{5,32})\.json(?:\.previous)?$/.exec(path.basename(filename)); if (!match) continue;
            const id = match[1], value = await firstFavorite(root, id, maxBytes);
            favorites.exec('BEGIN IMMEDIATE');
            try {
                if (importFavorite(records, id, value)) result.favoritesImported++; else result.favoritesAlreadyIndexed++;
                favorites.exec('COMMIT');
            } catch (error) { favorites.exec('ROLLBACK'); throw error; }
        }
        // Parse the global legacy file once, then perform indexed inserts in
        // one atomic transaction. Existing per-user records take precedence.
        const all = await readLegacy(path.join(root, 'favorites.json'), maxBytes);
        if (all !== undefined) {
            if (!all?.users || typeof all.users !== 'object' || Array.isArray(all.users)) throw storageError('Legacy favorites has an invalid schema; originals have been preserved.', 'FAVORITES_STORE_CORRUPT');
            favorites.exec('BEGIN IMMEDIATE');
            try {
                for (const [id, value] of Object.entries(all.users)) {
                    if (!/^\d{5,32}$/.test(id)) continue;
                    if (importFavorite(records, id, value, true)) result.favoritesImported++; else result.favoritesAlreadyIndexed++;
                }
                favorites.exec('COMMIT');
            } catch (error) { favorites.exec('ROLLBACK'); throw error; }
        }
        for (const [kind, counter, method] of [['history', 'historyFiles', 'count'], ['playlists', 'playlistFiles', 'list'], ['platform', 'platformFiles', 'stats']]) {
            for await (const filename of files(path.join(root, kind))) {
                const match = /^(\d{5,32})\.json(?:\.previous|\.\d+\.[a-f\d]{10}\.bak)?$/i.exec(path.basename(filename)); if (!match) continue;
                await service[kind][method](match[1]); result[counter]++;
            }
        }
        return result;
    } finally { favorites.close(); await service.close(); }
}
module.exports = { migrateLegacyStorage };
