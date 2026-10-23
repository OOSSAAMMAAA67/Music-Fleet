'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalTrackKey, catalogMetadata } = require('./trackIdentity');

const ROOT = path.join(__dirname, '..', 'data');
const { storageLimit, retain } = require('./storageLimits');
function userIdOf(user) {
    const id = String(typeof user === 'string' ? user : user?.id || '');
    if (!/^\d{5,32}$/.test(id)) throw new TypeError('Invalid Discord user ID');
    return id;
}
function compactTrack(t) {
    const url = String(t?.url || '').slice(0, 1000);
    if (!/^https?:\/\//i.test(url)) return null;
    return {
        ...catalogMetadata(t),
        title: String(t?.title || 'Unknown').slice(0, 220), url,
        author: String(t?.author || 'Unknown').slice(0, 160),
        thumbnail: String(t?.thumbnail || '').slice(0, 1000),
        duration: Math.max(0, Number(t?.duration || 0) || 0),
        source: String(t?.source || 'ytdlp').slice(0, 40),
        provider: String(t?.provider || '').slice(0, 40),
        linkedProvider: String(t?.linkedProvider || '').slice(0, 40),
        linkedOriginalUrl: String(t?.linkedOriginalUrl || '').slice(0, 1000),
        linkedResolvedUrl: String(t?.linkedResolvedUrl || '').slice(0, 1000),
        linkedThumbnail: String(t?.linkedThumbnail || '').slice(0, 1000),
        linkedTitle: String(t?.linkedTitle || '').slice(0, 320),
        mediaTitle: String(t?.mediaTitle || '').slice(0, 240),
        mediaArtist: String(t?.mediaArtist || '').slice(0, 200),
        album: String(t?.album || '').slice(0, 240),
        albumArtist: String(t?.albumArtist || '').slice(0, 200),
        releaseYear: Number(t?.releaseYear || 0) || 0,
        playedAt: t?.playedAt || new Date().toISOString(),
    };
}
function identity(track) {
    return canonicalTrackKey(track);
}

class HistoryStore {
    constructor({ dataDir = ROOT, maxCachedUsers = 256, maxTracks = storageLimit('HISTORY_MAX_TRACKS', 5000) } = {}) {
        this.dataDir = path.resolve(dataDir);
        this.maxTracks = storageLimit('HISTORY_MAX_TRACKS', 5000, maxTracks);
        this.cache = new Map();
        this.locks = new Map();
        this.maxCachedUsers = Math.max(8, maxCachedUsers);
    }
    _file(id) { return path.join(this.dataDir, 'history', id.slice(0, 2), id.slice(2, 4), `${id}.json`); }
    _touch(id, tracks) {
        this.cache.delete(id);
        this.cache.set(id, tracks);
        while (this.cache.size > this.maxCachedUsers) this.cache.delete(this.cache.keys().next().value);
        return tracks;
    }
    async _load(id) {
        if (this.cache.has(id)) return this._touch(id, this.cache.get(id));
        let tracks = [];
        try {
            const parsed = JSON.parse(await fs.readFile(this._file(id), 'utf8'));
            if (Array.isArray(parsed.tracks)) tracks = retain(parsed.tracks.map(compactTrack).filter(Boolean), this.maxTracks);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.warn('[History] read failed:', id, err.message);
                throw err;
            }
        }
        return this._touch(id, tracks);
    }
    _serialize(id, work) {
        const prior = this.locks.get(id) || Promise.resolve();
        const next = prior.catch(() => {}).then(work);
        this.locks.set(id, next);
        next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id); }).catch(() => {});
        return next;
    }
    async _save(id, tracks) {
        const target = this._file(id);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const tmp = `${target}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
        await fs.writeFile(tmp, JSON.stringify({ version: 1, userId: id, tracks }), { flag: 'wx' });
        try {
            try { await fs.rename(tmp, target); }
            catch (err) {
                if (!['EEXIST', 'EPERM', 'EACCES'].includes(err.code)) throw err;
                const backup = `${target}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.bak`;
                await fs.rename(target, backup);
                try { await fs.rename(tmp, target); await fs.rm(backup, { force: true }); }
                catch (replacementError) { await fs.rename(backup, target).catch(() => {}); throw replacementError; }
            }
        } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
    }
    record(user, track) {
        const id = userIdOf(user);
        const entry = compactTrack({ ...track, playedAt: new Date().toISOString() });
        if (!entry) return Promise.resolve(null);
        return this._serialize(id, async () => {
            const existing = await this._load(id);
            const key = identity(entry);
            const tracks = retain([entry, ...existing.filter(t => identity(t) !== key)], this.maxTracks);
            await this._save(id, tracks);
            this._touch(id, tracks);
            return { ...entry };
        });
    }
    list(user) {
        const id = userIdOf(user);
        return this._serialize(id, async () => (await this._load(id)).map(t => ({ ...t })));
    }
    count(user) {
        const id = userIdOf(user);
        // Avoid cloning thousands of history records just to render the live
        // Web Player badge once per state poll.
        return this._serialize(id, async () => (await this._load(id)).length);
    }
    remove(user, index) {
        const id = userIdOf(user);
        return this._serialize(id, async () => {
            const tracks = [...await this._load(id)];
            const i = Number(index);
            if (!Number.isInteger(i) || i < 0 || i >= tracks.length) throw new Error('History track not found.');
            const [removed] = tracks.splice(i, 1);
            await this._save(id, tracks);
            this._touch(id, tracks);
            return removed;
        });
    }
    clear(user) {
        const id = userIdOf(user);
        return this._serialize(id, async () => {
            const count = (await this._load(id)).length;
            await this._save(id, []);
            this._touch(id, []);
            return count;
        });
    }
    async flushAll() { await Promise.allSettled([...this.locks.values()]); }
}
const backend = process.env.STORAGE_BACKEND || require('../config').STORAGE_BACKEND || 'sqlite';
const history = backend === 'json' ? new HistoryStore({ dataDir: process.env.DATA_DIR || require('../config').DATA_DIR || ROOT }) : require('./sqliteStoreAdapters').createSqliteHistoryStore();
module.exports = history;
module.exports.HistoryStore = HistoryStore;
module.exports.compactTrack = compactTrack;
