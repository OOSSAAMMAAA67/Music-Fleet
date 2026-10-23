const fs = require("fs");
const path = require("path");
const config = require("../config");
const { canonicalTrackKey, catalogMetadata } = require("./trackIdentity");

const DATA_DIR = path.join(__dirname, "..", "data");
const USERS_DIR = path.join(DATA_DIR, "favorites");

function ensureDirs(dataDir = DATA_DIR, usersDir = USERS_DIR) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(usersDir, { recursive: true });
}

function now() { return new Date().toISOString(); }

function safeTrack(track = {}) {
    return {
        ...catalogMetadata(track),
        title: String(track.title || "غير معروف").slice(0, 220),
        url: String(track.url || track.webpage_url || "").slice(0, 1000),
        author: String(track.author || track.uploader || "غير معروف").slice(0, 160),
        duration: Number(track.duration || 0) || 0,
        thumbnail: String(track.thumbnail || "").slice(0, 1000),
        source: String(track.source || "youtube").slice(0, 40),
        provider: String(track.provider || "").slice(0, 40),
        linkedProvider: String(track.linkedProvider || "").slice(0, 40),
        linkedOriginalUrl: String(track.linkedOriginalUrl || "").slice(0, 1000),
        linkedResolvedUrl: String(track.linkedResolvedUrl || "").slice(0, 1000),
        linkedThumbnail: String(track.linkedThumbnail || "").slice(0, 1000),
        linkedTitle: String(track.linkedTitle || "").slice(0, 320),
        mediaTitle: String(track.mediaTitle || "").slice(0, 240),
        mediaArtist: String(track.mediaArtist || "").slice(0, 200),
        album: String(track.album || "").slice(0, 240),
        albumArtist: String(track.albumArtist || "").slice(0, 200),
        releaseYear: Number(track.releaseYear || 0) || 0,
        savedAt: track.savedAt || now(),
    };
}

function keyFor(track = {}) {
    return canonicalTrackKey(track);
}

function safeUserId(user) {
    const id = String(typeof user === "string" ? user : (user?.id || "")).trim();
    if (!/^\d{5,32}$/.test(id)) throw new Error("Missing or invalid user id");
    return id;
}

class FavoritesStore {
    constructor(options = {}) {
        this.dataDir = path.resolve(options.dataDir || DATA_DIR);
        this.usersDir = path.join(this.dataDir, "favorites");
        this.legacyPath = path.join(this.dataDir, "favorites.json");
        this.migrationMarker = path.join(this.usersDir, ".v2-migrated");
        ensureDirs(this.dataDir, this.usersDir);
        this.cache = new Map();
        this.dirty = new Set();
        this.saveTimers = new Map();
        this.saveFailures = new Map();
        this.shuttingDown = false;
        this.maxCachedUsers = Math.max(16, Number(options.maxCachedUsers ?? config.FAVORITES_CACHE_USERS ?? 128));
        this.saveDelayMs = Math.max(50, Number(options.saveDelayMs ?? config.FAVORITES_SAVE_DEBOUNCE_MS ?? 250));
        this.retryDelayMs = Math.max(1, Math.min(60_000, Number(options.retryDelayMs) || 250));
        this.maxRetryDelayMs = Math.max(this.retryDelayMs, Math.min(60_000, Number(options.maxRetryDelayMs) || 30_000));
        this._migrateLegacyOnce();
    }

    _file(userId) {
        const id = String(userId);
        // Two-level sharding avoids a single Windows directory accumulating
        // hundreds of thousands of files while keeping one durable file/user.
        return path.join(this.usersDir, id.slice(0, 2), id.slice(2, 4) || '00', `${id}.json`);
    }

    _legacyFlatFile(userId) {
        return path.join(this.usersDir, `${userId}.json`);
    }

    _emptyUser(userId, user = null) {
        return {
            version: 2,
            userId,
            tag: typeof user === "string" ? "Unknown" : (user?.tag || user?.username || "Unknown"),
            createdAt: now(),
            updatedAt: now(),
            tracks: [],
        };
    }

    _migrateLegacyOnce() {
        if (fs.existsSync(this.migrationMarker) || !fs.existsSync(this.legacyPath)) return;
        try {
            const raw = fs.readFileSync(this.legacyPath, "utf8");
            const legacy = raw.trim() ? JSON.parse(raw) : null;
            const users = legacy?.users && typeof legacy.users === "object" ? legacy.users : {};
            let migrated = 0;

            for (const [userId, legacyUser] of Object.entries(users)) {
                if (!/^\d{5,32}$/.test(String(userId))) continue;
                const target = this._file(userId);
                if (fs.existsSync(target) || fs.existsSync(`${target}.previous`)) continue;
                const record = {
                    version: 2,
                    userId: String(userId),
                    tag: String(legacyUser?.tag || "Unknown").slice(0, 100),
                    createdAt: legacyUser?.createdAt || now(),
                    updatedAt: legacyUser?.updatedAt || now(),
                    tracks: Array.isArray(legacyUser?.tracks) ? legacyUser.tracks.map(safeTrack) : [],
                };
                this._writeRecordAtomic(record);
                migrated++;
            }

            fs.writeFileSync(this.migrationMarker, JSON.stringify({ migratedAt: now(), users: migrated }), "utf8");
            if (migrated > 0) console.log(`[Favorites] migrated ${migrated} legacy users to per-user storage.`);
        } catch (err) {
            console.error("[Favorites] legacy migration skipped:", err.message || err);
        }
    }

    _writeRecordAtomic(record) {
        ensureDirs(this.dataDir, this.usersDir);
        const target = this._file(record.userId);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
        try {
            fs.writeFileSync(tmp, JSON.stringify(record), "utf8");
            try {
                fs.renameSync(tmp, target);
            } catch (err) {
                if (!["EPERM", "EACCES", "EEXIST"].includes(err.code) || !fs.existsSync(target)) throw err;
                const backup = `${target}.previous`;
                // Some Windows filesystems reject an overwrite. Preserve the original
                // under a discoverable name if the process stops between renames.
                fs.rmSync(backup, { force: true });
                fs.renameSync(target, backup);
                try {
                    fs.renameSync(tmp, target);
                    fs.rmSync(backup, { force: true });
                } catch (replacementError) {
                    try { fs.renameSync(backup, target); } catch (restoreError) {
                        console.error('[Favorites] restore failed; backup remains at', backup, restoreError);
                    }
                    throw replacementError;
                }
            }
            fs.rmSync(`${target}.previous`, { force: true });
        } finally {
            try { fs.rmSync(tmp, { force: true }); } catch (_) {}
        }
    }

    _touch(userId, record) {
        if (this.cache.has(userId)) this.cache.delete(userId);
        this.cache.set(userId, record);
        this._evictIfNeeded();
        return record;
    }

    _evictIfNeeded() {
        while (this.cache.size > this.maxCachedUsers) {
            const oldestId = this.cache.keys().next().value;
            if (!oldestId) break;
            if (this.dirty.has(oldestId)) {
                // Never evict the only in-memory copy of unsaved changes when a
                // transient disk/permission error prevents the atomic write.
                if (!this.saveNow(oldestId)) {
                    const record = this.cache.get(oldestId);
                    this.cache.delete(oldestId);
                    if (record) this.cache.set(oldestId, record);
                    break;
                }
            }
            const timer = this.saveTimers.get(oldestId);
            if (timer) clearTimeout(timer);
            this.saveTimers.delete(oldestId);
            this.saveFailures.delete(oldestId);
            this.cache.delete(oldestId);
        }
    }

    _loadUser(user) {
        const userId = safeUserId(user);
        const cached = this.cache.get(userId);
        if (cached) {
            if (typeof user !== "string") cached.tag = user?.tag || user?.username || cached.tag || "Unknown";
            return this._touch(userId, cached);
        }

        let record = null;
        const file = this._file(userId);
        const previous = `${file}.previous`;
        const legacyFlat = this._legacyFlatFile(userId);
        try {
            const sourceFile = fs.existsSync(file) ? file : (fs.existsSync(previous) ? previous : (fs.existsSync(legacyFlat) ? legacyFlat : null));
            if (sourceFile) {
                const raw = fs.readFileSync(sourceFile, "utf8");
                const parsed = raw.trim() ? JSON.parse(raw) : null;
                if (sourceFile === previous && (!parsed || parsed.version !== 2 || parsed.userId !== userId || !Array.isArray(parsed.tracks))) {
                    throw new Error('Invalid favorites recovery record; existing data has been preserved.');
                }
                if (parsed && Array.isArray(parsed.tracks)) {
                    record = {
                        version: 2,
                        userId,
                        tag: String(parsed.tag || "Unknown").slice(0, 100),
                        createdAt: parsed.createdAt || now(),
                        updatedAt: parsed.updatedAt || now(),
                        tracks: parsed.tracks.map(safeTrack),
                    };
                    // Transparently migrate old flat per-user files to the
                    // sharded layout after a successful atomic write.
                    if (sourceFile === legacyFlat && legacyFlat !== file) {
                        this._writeRecordAtomic(record);
                        try { fs.rmSync(legacyFlat, { force: true }); } catch (_) {}
                    }
                }
            }
        } catch (err) {
            console.error(`[Favorites] failed to load user ${userId}:`, err.message || err);
            throw err;
        }

        if (!record) record = this._emptyUser(userId, user);
        if (typeof user !== "string") record.tag = user?.tag || user?.username || record.tag || "Unknown";
        return this._touch(userId, record);
    }

    _scheduleSave(userId, delayMs) {
        if (this.shuttingDown || this.saveTimers.has(userId)) return;
        const timer = setTimeout(() => {
            this.saveTimers.delete(userId);
            if (this.dirty.has(userId) && this.saveNow(userId)) this._evictIfNeeded();
        }, delayMs);
        timer.unref?.();
        this.saveTimers.set(userId, timer);
    }

    _markDirty(userId) {
        this.dirty.add(userId);
        this._scheduleSave(userId, this.saveDelayMs);
    }

    saveNow(userId) {
        const id = safeUserId(userId);
        const timer = this.saveTimers.get(id);
        if (timer) clearTimeout(timer);
        this.saveTimers.delete(id);
        const record = this.cache.get(id);
        if (!record) return true;
        record.updatedAt = now();
        try {
            this._writeRecordAtomic(record);
            this.dirty.delete(id);
            this.saveFailures.delete(id);
            return true;
        } catch (err) {
            console.error(`[Favorites] failed to save user ${id}:`, err.message || err);
            this.dirty.add(id);
            const failures = Math.min(30, (this.saveFailures.get(id) || 0) + 1);
            this.saveFailures.set(id, failures);
            // Keep one retry/user and serialize the current cached record when
            // it fires, including changes made while the disk was unavailable.
            this._scheduleSave(id, Math.min(this.maxRetryDelayMs, this.retryDelayMs * 2 ** (failures - 1)));
            return false;
        }
    }

    flushAll({ shutdown = false } = {}) {
        if (shutdown) this.shuttingDown = true;
        for (const timer of this.saveTimers.values()) clearTimeout(timer);
        this.saveTimers.clear();
        let saved = true;
        for (const userId of [...this.dirty]) if (!this.saveNow(userId)) saved = false;
        return saved;
    }

    list(userId) {
        const u = this._loadUser(String(userId));
        return u.tracks.map(t => ({ ...t }));
    }

    count(userId) {
        return this._loadUser(String(userId)).tracks.length;
    }

    has(userId, trackOrUrl) {
        const u = this._loadUser(String(userId));
        const target = typeof trackOrUrl === 'string' ? { url: trackOrUrl } : (trackOrUrl || {});
        const key = keyFor(target);
        if (!key) return false;
        return u.tracks.some(track => keyFor(track) === key);
    }

    add(user, track) {
        const u = this._loadUser(user);
        const t = safeTrack(track);
        if (!t.url && !t.title) return { ok: false, reason: "invalid" };

        const key = keyFor(t);
        const existingIndex = u.tracks.findIndex(x => keyFor(x) === key);
        if (existingIndex >= 0) {
            const [old] = u.tracks.splice(existingIndex, 1);
            u.tracks.unshift({ ...old, ...t, savedAt: old.savedAt || t.savedAt, refreshedAt: now() });
            u.updatedAt = now();
            this._markDirty(u.userId);
            return { ok: true, duplicate: true, track: { ...u.tracks[0] }, index: 0, total: u.tracks.length };
        }

        u.tracks.unshift(t);
        const max = Number(config.FAVORITES_MAX_PER_USER || 0);
        if (max > 0 && u.tracks.length > max) u.tracks.length = max;
        u.updatedAt = now();
        this._markDirty(u.userId);
        return { ok: true, duplicate: false, track: { ...t }, index: 0, total: u.tracks.length };
    }

    remove(user, index) {
        const u = this._loadUser(user);
        const i = Number(index);
        if (!Number.isInteger(i) || i < 0 || i >= u.tracks.length) return null;
        const [removed] = u.tracks.splice(i, 1);
        u.updatedAt = now();
        this._markDirty(u.userId);
        return removed ? { ...removed } : null;
    }

    clear(user) {
        const u = this._loadUser(user);
        const count = u.tracks.length;
        u.tracks = [];
        u.updatedAt = now();
        this._markDirty(u.userId);
        return count;
    }

    get(userId, index) {
        const u = this._loadUser(String(userId));
        const i = Number(index);
        if (!Number.isInteger(i) || i < 0 || i >= u.tracks.length) return null;
        return { ...u.tracks[i] };
    }
}

const backend = process.env.STORAGE_BACKEND || config.STORAGE_BACKEND || 'sqlite';
const store = backend === 'json' ? new FavoritesStore({ dataDir: process.env.DATA_DIR || config.DATA_DIR || DATA_DIR }) : require('./sqliteStoreAdapters').createSqliteFavoritesStore();

function installExitHandlers() {
    const save = () => { try { store.flushAll({ shutdown: true }); } catch (_) {} };
    process.once("beforeExit", save);
    // Do not call process.exit() here. index.js owns graceful shutdown and still
    // needs to flush history/playlists, stop the Web Player and tear down voice.
    // Calling exit from this store used to short-circuit those later handlers.
    process.once("SIGINT", save);
    process.once("SIGTERM", save);
}
if (backend === 'json') installExitHandlers();

module.exports = store;
module.exports.FavoritesStore = FavoritesStore;
module.exports.safeTrack = safeTrack;
module.exports.keyFor = keyFor;
module.exports.safeUserId = safeUserId;
