'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { backup } = require('node:sqlite');
const { openDatabase, Records, checksum, storageError, MAX_LEGACY_BYTES } = require('./sqliteDatabase');
const { HistoryStore, compactTrack: historyTrack } = require('./historyStore');
const { PlaylistsStore } = require('./playlistsStore');
const { PlatformStore, sanitizeItem, userIdOf } = require('./platformStore');
const { canonicalTrackKey } = require('./trackIdentity');
const { methods } = require('./sqliteStoreAdapters');
const { storageLimit, retain, recent } = require('./storageLimits');
const COLLECTIONS = ['albums', 'artists', 'videos', 'mixes', 'profiles', 'uploads', 'purchases', 'downloads'];
const dataDir = path.resolve(workerData.dataDir);
const maxLegacyBytes = Math.max(1024, Math.min(2 * 1024 * 1024 * 1024, Number(workerData.maxLegacyBytes) || MAX_LEGACY_BYTES));
const db = openDatabase(path.join(dataDir, 'shared.sqlite'), { events: true });
const records = new Records(db);
let favoritesDb = null, favoriteRecords = null;
const favoriteCache = new Map();
function loadFavorites(id) {
    id = userIdOf(id);
    if (!favoritesDb) { favoritesDb = openDatabase(path.join(dataDir, 'favorites.sqlite')); favoriteRecords = new Records(favoritesDb); }
    const row = favoriteRecords.read.get('favorites', id);
    if (!row) { favoriteCache.delete(id); return null; }
    const old = favoriteCache.get(id);
    // Both original serialized bytes and checksum must match. External changes
    // or checksum corruption therefore cannot be hidden by the parsed cache.
    if (old && old.text === row.record && old.digest === row.checksum) {
        favoriteCache.delete(id); favoriteCache.set(id, old); return old;
    }
    const value = require('./sqliteDatabase').decode(row, 'favorites', id);
    if (value.version !== 2 || value.userId !== id || !Array.isArray(value.tracks)) throw storageError('Favorites record is corrupt; existing data has been preserved.', 'FAVORITES_STORE_CORRUPT');
    const entry = { text: row.record, digest: row.checksum, value, keys: null };
    favoriteCache.set(id, entry);
    const maximum = Math.max(1, Number(require('../config').FAVORITES_CACHE_USERS) || 128);
    while (favoriteCache.size > maximum) favoriteCache.delete(favoriteCache.keys().next().value);
    return entry;
}
function countFavorites(id) { const record = loadFavorites(id); return record ? record.value.tracks.length : null; }
function hasFavorite(id, value) {
    const record = loadFavorites(id); if (!record) return null;
    const keyFor = require('./favoritesStore').keyFor;
    const key = keyFor(typeof value === 'string' ? { url: value } : value || {});
    if (!key) return false;
    record.keys ||= new Set(record.value.tracks.map(track => keyFor(track)));
    return record.keys.has(key);
}
const readPlatformState = db.prepare('SELECT revision,updated_at,checksum FROM platform_state WHERE user_id=?');
const writePlatformState = db.prepare('INSERT INTO platform_state(user_id,revision,updated_at,checksum) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,checksum=excluded.checksum');
const eventById = db.prepare('SELECT * FROM play_events WHERE user_id=? AND id=?');
const eventList = db.prepare('SELECT * FROM play_events WHERE user_id=? ORDER BY seq');
const recentEvents = db.prepare('SELECT * FROM play_events WHERE user_id=? ORDER BY seq DESC LIMIT ?');
const eventMonth = db.prepare('SELECT * FROM play_events WHERE user_id=? AND month=? ORDER BY seq');
const eventMonths = db.prepare('SELECT DISTINCT month FROM play_events WHERE user_id=? ORDER BY month DESC');
const eventCount = db.prepare('SELECT count(*) AS n FROM play_events WHERE user_id=?');
const insertEvent = db.prepare('INSERT INTO play_events(user_id,id,at,month,track,checksum,seconds,completed,ended_at) VALUES(?,?,?,?,?,?,?,?,?)');
const updateEvent = db.prepare('UPDATE play_events SET seconds=?,completed=?,ended_at=?,checksum=? WHERE user_id=? AND id=?');
const pruneEvents = db.prepare('DELETE FROM play_events WHERE user_id=? AND seq IN (SELECT seq FROM play_events WHERE user_id=? ORDER BY seq DESC LIMIT -1 OFFSET ?)');

async function historyRecoveryFile(filename) {
    let directory;
    try { directory = await fs.opendir(path.dirname(filename)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const prefix = `${path.basename(filename)}.`; let latest = null;
    for await (const entry of directory) {
        if (!entry.isFile() || !entry.name.startsWith(prefix) || !/^\d+\.[a-f\d]{10}\.bak$/i.test(entry.name.slice(prefix.length))) continue;
        const candidate = path.join(path.dirname(filename), entry.name);
        let stat;
        try { stat = await fs.stat(candidate); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!latest || stat.mtimeMs > latest.time) latest = { file: candidate, time: stat.mtimeMs, size: stat.size };
    }
    if (latest && latest.size > maxLegacyBytes) throw storageError('Legacy history recovery file exceeds the migration size limit.', 'STORAGE_MIGRATION_SIZE');
    return latest?.file || null;
}

async function legacyJson(filename, store, id) {
    let text;
    for (const source of [filename, `${filename}.previous`]) {
        try {
            const stat = await fs.stat(source);
            if (stat.size > maxLegacyBytes) throw storageError('Legacy library exceeds the bounded migration size; use scripts/fleet-storage-migrate.js offline.', 'STORAGE_MIGRATION_SIZE');
            text = await fs.readFile(source, 'utf8'); break;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (text == null && store === 'history') {
        const recovery = await historyRecoveryFile(filename);
        if (recovery) text = await fs.readFile(recovery, 'utf8');
    }
    if (text == null) return undefined;
    try { return JSON.parse(text); }
    catch (cause) { throw storageError(`${store} library for user ${id} is corrupt; existing data has been preserved.`, `${store.toUpperCase()}_STORE_CORRUPT`, cause); }
}
function invalid(store, id) { return storageError(`${store} library for user ${id} is corrupt; existing data has been preserved.`, `${store.toUpperCase()}_STORE_CORRUPT`); }
function validateTracks(record, id) {
    if (record?.version !== 1 || record.userId !== id || !Array.isArray(record.tracks)) throw invalid('history', id);
    return record;
}
class IndexedHistory extends HistoryStore {
    constructor() { super({ dataDir }); }
    _touch(id, tracks) { return tracks; }
    async _load(id) {
        let record = records.get('history', id);
        if (!record) {
            const legacy = await legacyJson(this._file(id), 'history', id);
            if (legacy !== undefined) validateTracks(legacy, id);
            const tracks = retain((legacy?.tracks || []).map(historyTrack).filter(Boolean), this.maxTracks);
            record = { version: 1, userId: id, tracks }; records.set('history', id, record);
        }
        return validateTracks(record, id).tracks;
    }
    async _save(id, tracks) { records.set('history', id, { version: 1, userId: id, tracks }); }
}
function validatePlaylists(record, id) {
    if (record?.version !== 1 || record.userId !== id || !Array.isArray(record.playlists)
        || record.playlists.some(list => !list || typeof list.id !== 'string' || typeof list.name !== 'string' || !Array.isArray(list.tracks))) throw invalid('playlists', id);
    return record;
}
class IndexedPlaylists extends PlaylistsStore {
    constructor() { super(dataDir); }
    async read(user) {
        const id = this.id(user);
        let record = records.get('playlists', id);
        if (!record) {
            const legacy = await legacyJson(this.file(id), 'playlists', id);
            if (legacy !== undefined) validatePlaylists(legacy, id);
            record = { version: 1, userId: id, playlists: legacy?.playlists || [] }; records.set('playlists', id, record);
        }
        return validatePlaylists(record, id).playlists;
    }
    async write(user, lists) {
        const id = this.id(user), record = { version: 1, userId: id, playlists: lists };
        validatePlaylists(record, id); records.set('playlists', id, record);
    }
}
function safeDate(value, fallback) {
    const time = typeof value === 'number' ? value : Date.parse(String(value || ''));
    if (!Number.isFinite(time) || time < 0 || time > Date.UTC(2201, 0, 1)) {
        if (fallback != null) return new Date(fallback).toISOString();
        throw new TypeError('Invalid play event date.');
    }
    return new Date(time).toISOString();
}
function listeningSeconds(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw new TypeError('Invalid listening seconds.');
    return seconds;
}
function eventFromRow(row, id) {
    if (!row) return null;
    try {
        const event = { id: row.id, track: JSON.parse(row.track), at: row.at, seconds: row.seconds, completed: row.completed === 1 };
        if (row.ended_at != null) event.endedAt = row.ended_at;
        if (checksum(JSON.stringify(event)) !== row.checksum || row.month !== event.at.slice(0, 7)) throw new Error('Listening event checksum mismatch.');
        return event;
    } catch (cause) { throw storageError(`Listening event for user ${id} is corrupt; existing data has been preserved.`, 'PLATFORM_STORE_CORRUPT', cause); }
}
function putEvent(id, event) {
    const text = JSON.stringify(event.track);
    insertEvent.run(id, event.id, event.at, event.at.slice(0, 7), text, checksum(JSON.stringify(event)), event.seconds, event.completed ? 1 : 0, event.endedAt ?? null);
}
function validatePlatform(record, id) {
    if (record?.version !== 1 || record.userId !== id || !Number.isInteger(record.revision) || record.revision < 0
        || !record.collections || !record.settings || !Array.isArray(record.feedback) || !Array.isArray(record.events)
        || record.signals != null && !Array.isArray(record.signals)
        || COLLECTIONS.some(kind => !Array.isArray(record.collections[kind]))) throw invalid('platform', id);
    record.signals ||= [];
    return record;
}
function stateChecksum(id, revision, updatedAt) { return checksum(JSON.stringify({ userId: id, revision, updatedAt })); }
function putPlatformState(id, record) { writePlatformState.run(id, record.revision, record.updatedAt, stateChecksum(id, record.revision, record.updatedAt)); }
class IndexedPlatform extends PlatformStore {
    constructor() { super({ dataDir, maxEvents: workerData.maxEvents }); }
    async _diskLock(id, work) { return work(); }
    async _read(id) {
        let record = records.get('platform', id);
        if (!record) {
            // The original reader verifies schema and checksum before imports;
            // no legacy source is rewritten, renamed or deleted.
            const legacy = await legacyJson(this.file(id), 'platform', id);
            if (legacy !== undefined) {
                if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw invalid('platform', id);
                const { checksum: digest, ...original } = legacy;
                if (typeof digest !== 'string' || checksum(JSON.stringify(original)) !== digest) throw invalid('platform', id);
                original.collections ||= {}; original.collections.downloads ||= [];
                record = validatePlatform(original, id);
            } else record = await PlatformStore.prototype._read.call(this, id);
            const events = recent(record.events, this.maxEvents);
            record.events = [];
            records.set('platform', id, record);
            const seen = new Set();
            for (const value of events) {
                if (!value || !value.id || typeof value.id !== 'string' || value.id.length > 200 || seen.has(value.id)) throw invalid('platform', id);
                seen.add(value.id);
                const event = { id: value.id, track: sanitizeItem(value.track, 'track'), at: safeDate(value.at), seconds: listeningSeconds(value.seconds), completed: value.completed === true };
                if (!['track', 'video'].includes(event.track.kind)) throw invalid('platform', id);
                if (value.endedAt != null) event.endedAt = safeDate(value.endedAt);
                putEvent(id, event);
            }
        }
        validatePlatform(record, id);
        const state = readPlatformState.get(id);
        if (!state) putPlatformState(id, record);
        else {
            if (state.checksum !== stateChecksum(id, state.revision, state.updated_at)) throw invalid('platform', id);
            record.revision = state.revision; record.updatedAt = state.updated_at;
        }
        return record;
    }
    async _write(id, record) { records.set('platform', id, { ...record, events: [] }); putPlatformState(id, record); }
    async read(user, options = {}) {
        const id = userIdOf(user), record = await this._read(id);
        const limit = options.eventLimit == null ? null : storageLimit('eventLimit', 0, options.eventLimit);
        const rows = limit == null ? eventList.all(id) : limit === 0 ? [] : recentEvents.all(id, limit).reverse();
        record.events = rows.map(row => eventFromRow(row, id));
        return record;
    }
    _revision(id, record) { record.revision++; record.updatedAt = new Date(this.now()).toISOString(); putPlatformState(id, record); }
    async recordPlay(user, value, details = {}) {
        const id = userIdOf(user), item = sanitizeItem(value, 'track');
        if (!['track', 'video'].includes(item.kind)) throw new TypeError('A listening event requires a track or video.');
        delete item.tracks;
        const eventId = details.eventId == null ? crypto.randomUUID() : String(details.eventId).trim().slice(0, 200);
        if (!eventId) throw new TypeError('Invalid play event identity.');
        const at = safeDate(details.at ?? details.playedAt, this.now());
        const seconds = listeningSeconds(details.listenedSeconds ?? details.seconds ?? 0);
        const record = await this._read(id);
        let event = eventFromRow(eventById.get(id, eventId), id);
        if (!event) {
            event = { id: eventId, track: item, at, seconds, completed: details.completed === true };
            if (details.endedAt != null) event.endedAt = safeDate(details.endedAt);
            putEvent(id, event); if (this.maxEvents > 0) pruneEvents.run(id, id, this.maxEvents);
        }
        await this._revision(id, record); return event;
    }
    async updatePlay(user, eventId, details = {}) {
        const id = userIdOf(user), record = await this._read(id), event = eventFromRow(eventById.get(id, String(eventId)), id);
        if (!event) throw storageError('Listening event was not found.', 'PLAY_EVENT_NOT_FOUND');
        if (details.listenedSeconds != null) event.seconds = Math.max(event.seconds, listeningSeconds(details.listenedSeconds));
        if (details.endedAt != null) event.endedAt = safeDate(details.endedAt);
        if (details.completed === true) event.completed = true;
        updateEvent.run(event.seconds, event.completed ? 1 : 0, event.endedAt ?? null, checksum(JSON.stringify(event)), id, event.id);
        await this._revision(id, record); return event;
    }
    async stats(user, month) {
        const id = userIdOf(user), selected = month || new Date(this.now()).toISOString().slice(0, 7);
        if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(selected) || Number(selected.slice(0, 4)) < 1970 || Number(selected.slice(0, 4)) > 2200) throw new TypeError('Invalid listening month; use YYYY-MM.');
        const record = await this._read(id), events = eventMonth.all(id, selected).map(row => eventFromRow(row, id));
        const tracks = new Map(), artists = new Map(); let totalSeconds = 0, catalogDurationSeconds = 0;
        const normalized = value => String(value || '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
        for (const event of events) {
            totalSeconds += event.seconds; catalogDurationSeconds += Number(event.track.duration || 0);
            const key = event.track.linkedOriginalUrl ? canonicalTrackKey(event.track) : event.track.id || canonicalTrackKey(event.track);
            const title = event.track.author || 'Unknown artist', artistKey = normalized(title);
            const track = tracks.get(key) || { ...event.track, plays: 0, seconds: 0, lastPlayedAt: event.at };
            track.plays++; track.seconds += event.seconds; if (event.at > track.lastPlayedAt) track.lastPlayedAt = event.at; tracks.set(key, track);
            const artist = artists.get(artistKey) || { kind: 'artist', id: event.track.artistId || '', title,
                thumbnail: record.collections.artists.find(item => normalized(item.title) === artistKey)?.thumbnail || '', plays: 0, seconds: 0 };
            artist.plays++; artist.seconds += event.seconds; artists.set(artistKey, artist);
        }
        const rank = (a, b) => b.plays - a.plays || b.seconds - a.seconds || String(a.title).localeCompare(String(b.title));
        return { month: selected, totalPlays: events.length, totalSeconds, catalogDurationSeconds,
            measuredPlays: events.filter(event => event.seconds > 0).length,
            topArtists: [...artists.values()].sort(rank).slice(0, 50), topTracks: [...tracks.values()].sort(rank).slice(0, 100),
            availableMonths: eventMonths.all(id).map(row => row.month), retention: { maxEvents: this.maxEvents, storedEvents: eventCount.get(id).n } };
    }
}
const stores = { favorites: { count: countFavorites, has: hasFavorite }, history: new IndexedHistory(), playlists: new IndexedPlaylists(), platform: new IndexedPlatform() };
let chain = Promise.resolve();
async function dispatch(message) {
    const { store, method, args } = message;
    if (store == null) {
        if (method === 'backup') { await backup(db, args[0]); return true; }
        if (method === 'close') { favoritesDb?.close(); favoritesDb = null; favoriteRecords = null; favoriteCache.clear(); db.close(); return true; }
        throw storageError('Unsupported storage control operation.', 'STORAGE_OPERATION');
    }
    if (!stores[store] || !methods[store].includes(method)) throw storageError('Unsupported storage operation.', 'STORAGE_OPERATION');
    db.exec('BEGIN IMMEDIATE');
    try { const result = await stores[store][method](...args); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
}
parentPort.on('message', message => {
    chain = chain.catch(() => {}).then(async () => {
        try {
            const result = await dispatch(message); parentPort.postMessage({ id: message.id, result });
            if (message.store == null && message.method === 'close') parentPort.close();
        } catch (error) { parentPort.postMessage({ id: message.id, error: { name: error.name, message: error.message, code: error.code } }); }
    });
});
