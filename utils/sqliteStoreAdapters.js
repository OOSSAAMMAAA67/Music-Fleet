'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, Records, storageError, MAX_LEGACY_BYTES } = require('./sqliteDatabase');
const { storageLimit } = require('./storageLimits');

function optionsWithDefaults(options = {}) {
    const config = require('../config');
    return { ...options, dataDir: options.dataDir || process.env.DATA_DIR || config.DATA_DIR || path.join(__dirname, '..', 'data') };
}
class AsyncStore {
    constructor(kind, options = {}, service = null) { this.kind = kind; this.options = optionsWithDefaults(options); this.service = service; this.dataDir = path.resolve(this.options.dataDir); }
    _service() { return this.service || require('./sharedStorage').getSharedStorage(this.options); }
    _call(method, args) { return this._service().request(this.kind, method, args); }
    flushAll() { return this._service().flush(); }
}
const methods = {
    favorites: ['count', 'has'],
    history: ['record', 'list', 'count', 'remove', 'clear'],
    playlists: ['list', 'get', 'create', 'rename', 'delete', 'add', 'remove', 'read', 'write'],
    platform: ['read', 'list', 'save', 'remove', 'setSettings', 'recordSignal', 'recordDownload', 'removeDownload', 'setFeedback', 'recordPlay', 'updatePlay', 'stats'],
};
function createAsyncStore(kind, options, service) {
    const adapter = new AsyncStore(kind, options, service);
    for (const method of methods[kind]) adapter[method] = (...args) => adapter._call(method, args);
    return adapter;
}
function readJson(filename) {
    let text;
    try {
        const size = fs.statSync(filename).size;
        if (size > MAX_LEGACY_BYTES) throw storageError('Legacy favorites file exceeds the bounded migration size; migrate it offline.', 'STORAGE_MIGRATION_SIZE');
        text = fs.readFileSync(filename, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    try { return JSON.parse(text); }
    catch (cause) { throw storageError('Favorites record is corrupt; existing data has been preserved.', 'FAVORITES_STORE_CORRUPT', cause); }
}
function firstExistingJson(filenames) {
    for (const filename of filenames) { const value = readJson(filename); if (value !== undefined) return value; }
    return undefined;
}
class SQLiteFavoritesStore {
    constructor(options = {}, service = null) {
        this.options = optionsWithDefaults(options); this.dataDir = path.resolve(this.options.dataDir); this.service = service;
        this.filename = path.join(this.dataDir, 'favorites.sqlite'); this.db = null;
        // API compatibility: SQLite commits each mutation immediately and needs
        // no dirty-user cache or debounce timers.
        this.cache = new Map(); this.dirty = new Set(); this.saveTimers = new Map();
    }
    _service() { return this.service || require('./sharedStorage').getSharedStorage(this.options); }
    _open() {
        const owner = this._service(); owner.assertAvailable();
        if (owner.favorites !== this) return owner.favorites._open();
        return this._connect();
    }
    _connect() {
        if (!this.db) { this.db = openDatabase(this.filename, { synchronous: true }); this.records = new Records(this.db); }
        return this;
    }
    _file(id) { return path.join(this.dataDir, 'favorites', id.slice(0, 2), id.slice(2, 4) || '00', `${id}.json`); }
    _loadUser(user) {
        const { safeTrack, safeUserId } = require('./favoritesStore');
        const id = safeUserId(user), connection = this._open();
        let value = connection.records.get('favorites', id);
        if (!value) {
            const sharded = this._file(id);
            let legacy = firstExistingJson([sharded, `${sharded}.previous`, path.join(this.dataDir, 'favorites', `${id}.json`)]);
            if (legacy !== undefined && (!legacy || !Array.isArray(legacy.tracks) || legacy.userId != null && legacy.userId !== id || legacy.version != null && legacy.version !== 2)) throw storageError('Favorites record is corrupt; existing data has been preserved.', 'FAVORITES_STORE_CORRUPT');
            if (legacy === undefined) {
                const all = readJson(path.join(this.dataDir, 'favorites.json'));
                if (all !== undefined && (!all?.users || typeof all.users !== 'object' || Array.isArray(all.users))) throw storageError('Legacy favorites record is corrupt; existing data has been preserved.', 'FAVORITES_STORE_CORRUPT');
                legacy = all && Object.hasOwn(all.users, id) ? all.users[id] : undefined;
                if (legacy !== undefined && (!legacy || !Array.isArray(legacy.tracks))) throw storageError('Legacy favorites user is corrupt; existing data has been preserved.', 'FAVORITES_STORE_CORRUPT');
            }
            const stamp = new Date().toISOString();
            value = { version: 2, userId: id, tag: String(legacy?.tag || 'Unknown').slice(0, 100),
                createdAt: legacy?.createdAt || stamp, updatedAt: legacy?.updatedAt || stamp, tracks: (legacy?.tracks || []).map(safeTrack) };
            connection.records.set('favorites', id, value);
        }
        if (value.version !== 2 || value.userId !== id || !Array.isArray(value.tracks)) throw storageError('Favorites record is corrupt; existing data has been preserved.', 'FAVORITES_STORE_CORRUPT');
        if (typeof user !== 'string') value.tag = String(user?.tag || user?.username || value.tag || 'Unknown').slice(0, 100);
        return value;
    }
    _mutate(user, work) {
        const connection = this._open(); connection.db.exec('BEGIN IMMEDIATE');
        try {
            const value = this._loadUser(user), result = work(value);
            value.updatedAt = new Date().toISOString(); connection.records.set('favorites', value.userId, value);
            connection.db.exec('COMMIT'); return result;
        } catch (error) { connection.db.exec('ROLLBACK'); throw error; }
    }
    list(userId) { return structuredClone(this._loadUser(String(userId)).tracks); }
    count(userId) { return this._loadUser(String(userId)).tracks.length; }
    countAsync(userId) {
        const id = require('./favoritesStore').safeUserId(userId);
        // Import/validate a new user once using the legacy-compatible API; large
        // badge polls then validate/count in the worker, away from voice timers.
        const owner = this._service();
        owner.assertAvailable();
        return owner.request('favorites', 'count', [id]).then(count => count == null ? this.count(id) : count);
    }
    hasAsync(userId, value) {
        const id = require('./favoritesStore').safeUserId(userId);
        const owner = this._service(); owner.assertAvailable();
        return owner.request('favorites', 'has', [id, value]).then(found => found == null ? this.has(id, value) : found);
    }
    has(userId, value) {
        const keyFor = require('./favoritesStore').keyFor, key = keyFor(typeof value === 'string' ? { url: value } : value || {});
        return key ? this._loadUser(String(userId)).tracks.some(track => keyFor(track) === key) : false;
    }
    get(userId, index) { const tracks = this._loadUser(String(userId)).tracks, i = Number(index); return Number.isInteger(i) && i >= 0 && i < tracks.length ? structuredClone(tracks[i]) : null; }
    add(user, track) {
        const { safeTrack, keyFor } = require('./favoritesStore'), t = safeTrack(track), stamp = new Date().toISOString();
        return this._mutate(user, value => {
            if (!t.url && !t.title) return { ok: false, reason: 'invalid' };
            const key = keyFor(t), index = value.tracks.findIndex(x => keyFor(x) === key), duplicate = index >= 0;
            if (duplicate) { const [old] = value.tracks.splice(index, 1); value.tracks.unshift({ ...old, ...t, savedAt: old.savedAt || t.savedAt, refreshedAt: stamp }); }
            else value.tracks.unshift(t);
            const limit = storageLimit('FAVORITES_MAX_PER_USER');
            if (limit > 0 && value.tracks.length > limit) value.tracks.length = limit;
            return { ok: true, duplicate, track: structuredClone(value.tracks[0]), index: 0, total: value.tracks.length };
        });
    }
    remove(user, index) { return this._mutate(user, value => { const i = Number(index); return Number.isInteger(i) && i >= 0 && i < value.tracks.length ? value.tracks.splice(i, 1)[0] : null; }); }
    clear(user) { return this._mutate(user, value => { const size = value.tracks.length; value.tracks = []; return size; }); }
    saveNow(userId) { require('./favoritesStore').safeUserId(userId); this._open(); return true; }
    flushAll() { this._open(); return true; }
    _close() { if (this.db) { this.db.close(); this.db = null; this.records = null; } }
}
module.exports = {
    methods, createAsyncStore, SQLiteFavoritesStore,
    createSqliteFavoritesStore: options => new SQLiteFavoritesStore(options),
    createSqliteHistoryStore: options => createAsyncStore('history', options),
    createSqlitePlaylistsStore: options => createAsyncStore('playlists', options),
    createSqlitePlatformStore: options => createAsyncStore('platform', options),
};
