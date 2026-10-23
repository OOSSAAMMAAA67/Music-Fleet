'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalTrackKey } = require('./trackIdentity');

// Shared across instances: constructing another service/store in the same
// process must not create a second writer for the same user file.
const locks = new Map();
const COLLECTIONS = ['albums', 'artists', 'videos', 'mixes', 'profiles', 'uploads', 'purchases', 'downloads'];
const MAX_ITEMS = 2000;
const MAX_EVENTS = 50000;
const MAX_FEEDBACK = 2000;
const MAX_SIGNALS = 50000;
const { storageLimit, retain, recent } = require('./storageLimits');
const KNOWN_KINDS = new Set(['track', 'album', 'artist', 'video', 'mix', 'playlist', 'profile', 'upload', 'purchase']);
const STRING_FIELDS = {
    id: 300, title: 320, author: 200, provider: 40, source: 40, isrc: 20, album: 250,
    albumId: 300, releaseId: 300, releaseGroupId: 300, artistId: 300, subtitle: 300, reason: 400, description: 2000,
    url: 2000, providerUrl: 2000, previewUrl: 2000, thumbnail: 2000, genre: 100,
    releaseDate: 40, releaseYear: 12, language: 40, copyright: 600,
    linkedProvider: 40, linkedOriginalUrl: 2000, linkedResolvedUrl: 2000,
    linkedThumbnail: 2000, linkedTitle: 320, mediaTitle: 320, mediaArtist: 200,
    albumArtist: 200, quality: 80, mime: 100, uploadedAt: 50, purchaseDate: 50,
    displayName: 100, website: 2000, bio: 2000, savedAt: 50,
    seed: 2200,
};

function userIdOf(user) {
    const id = String(typeof user === 'string' ? user : user?.id || '').trim();
    if (!/^\d{5,32}$/.test(id)) throw new TypeError('Invalid user ID.');
    return id;
}
function normalized(value) {
    return String(value || '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}
function itemKey(item) {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    return String(item.id || '') || canonicalTrackKey(item);
}
function trackKey(item) {
    // The same recording can arrive via catalog metadata and a resolved video.
    // Prefer original linked identity; otherwise compare provider IDs and then
    // semantic title/artist when ranking. Store events remain distinct.
    if (item?.linkedOriginalUrl) return canonicalTrackKey(item);
    return item?.id || canonicalTrackKey(item);
}
function collectionOf(kind) {
    const value = String(kind || '').toLowerCase();
    const plural = COLLECTIONS.includes(value) ? value : value === 'mix' ? 'mixes' : `${value}s`;
    if (!COLLECTIONS.includes(plural)) throw new TypeError('Unsupported platform collection.');
    return plural;
}
function safeDate(value, fallback) {
    const ms = typeof value === 'number' ? value : Date.parse(String(value || ''));
    if (!Number.isFinite(ms) || ms < 0 || ms > Date.UTC(2201, 0, 1)) {
        if (fallback != null) return new Date(fallback).toISOString();
        throw new TypeError('Invalid play event date.');
    }
    return new Date(ms).toISOString();
}
function sanitizeItem(value, expectedKind, depth = 0) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('A library item is required.');
    const kind = String(value.kind || expectedKind || 'track');
    if (!KNOWN_KINDS.has(kind)) throw new TypeError('Unsupported library item kind.');
    const item = { kind };
    for (const [key, limit] of Object.entries(STRING_FIELDS)) {
        if (value[key] != null && value[key] !== '') item[key] = String(value[key]).trim().slice(0, limit);
    }
    if (item.isrc) {
        const normalizedIsrc = item.isrc.replace(/[^a-z\d]/gi, '').toUpperCase();
        if (/^[A-Z]{2}[A-Z\d]{3}\d{7}$/.test(normalizedIsrc)) item.isrc = normalizedIsrc;
        else delete item.isrc;
    }
    if (!item.title) throw new TypeError('A library item title is required.');
    for (const field of ['url', 'providerUrl', 'previewUrl', 'thumbnail', 'website', 'linkedOriginalUrl', 'linkedResolvedUrl', 'linkedThumbnail']) {
        const uploadArtwork = ['thumbnail', 'linkedThumbnail'].includes(field)
            && /^\/api\/platform\/upload\/art\?id=[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/.test(item[field] || '');
        if (item[field] && !/^https?:\/\//i.test(item[field]) && !uploadArtwork) throw new TypeError(`Invalid ${field} URL.`);
    }
    if (!itemKey(item) || itemKey(item) === '::') throw new TypeError('A library item identity is required.');
    if (value.duration != null) item.duration = Math.min(86400, Math.max(0, Number(value.duration) || 0));
    for (const key of ['explicit', 'previewOnly', 'metadataOnly', 'importedExternal', 'verifiedHiRes', 'providerNewRelease', 'videoPlaylist']) {
        if (typeof value[key] === 'boolean') item[key] = value[key];
    }
    for (const key of ['sampleRate', 'bitDepth', 'bitrate', 'trackNumber', 'discNumber', 'count', 'size']) {
        if (Number.isFinite(Number(value[key])) && value[key] != null) item[key] = Math.max(0, Number(value[key]));
    }
    if (Array.isArray(value.genres)) item.genres = [...new Set(value.genres.map(x => String(x).trim().slice(0, 100)).filter(Boolean))].slice(0, 20);
    if (['arrivals', 'discovery', 'mix', 'track-radio', 'artist-radio', 'monthly', 'video-playlist'].includes(value.artworkType)) item.artworkType = value.artworkType;
    if (Array.isArray(value.artworkImages)) item.artworkImages = [...new Set(value.artworkImages.filter(x => typeof x === 'string' && /^https?:\/\//i.test(x)).map(x => x.slice(0, 2000)))].slice(0, 4);
    if (Number.isInteger(value.mixIndex) && value.mixIndex >= 1 && value.mixIndex <= 6) item.mixIndex = value.mixIndex;
    if (Array.isArray(value.tracks) && depth < 2) item.tracks = retain(value.tracks, storageLimit('PLAYLIST_MAX_TRACKS', 500)).map(t => sanitizeItem(t, 'track', depth + 1));
    if (value.provenance && typeof value.provenance === 'object') {
        item.provenance = {};
        for (const key of ['provider', 'endpoint', 'artworkSource', 'retrievedAt']) if (value.provenance[key]) item.provenance[key] = String(value.provenance[key]).slice(0, 2000);
    }
    return item;
}
function emptyRecord(id, time) {
    const stamp = new Date(time).toISOString();
    return {
        version: 1, userId: id, revision: 0, createdAt: stamp, updatedAt: stamp,
        collections: Object.fromEntries(COLLECTIONS.map(k => [k, []])),
        settings: { preferredGenres: [], excludedGenres: [], explicit: true, autoplay: true, motionArtwork: true, discovery: 0.45, country: 'US' },
        feedback: [], events: [], signals: [],
    };
}
function clone(value) { return structuredClone(value); }
function settingsPatch(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Settings must be an object.');
    const result = {};
    for (const field of ['preferredGenres', 'excludedGenres']) {
        if (value[field] == null) continue;
        if (!Array.isArray(value[field]) || value[field].length > 30) throw new TypeError(`Invalid ${field}.`);
        result[field] = [...new Set(value[field].map(x => String(x).trim().slice(0, 100)).filter(Boolean))];
    }
    for (const field of ['explicit', 'autoplay', 'motionArtwork']) {
        if (value[field] == null) continue;
        if (typeof value[field] !== 'boolean') throw new TypeError(`${field} setting must be a boolean.`);
        result[field] = value[field];
    }
    if (value.discovery != null) {
        const amount = Number(value.discovery);
        if (!Number.isFinite(amount) || amount < 0 || amount > 1) throw new TypeError('Discovery must be between 0 and 1.');
        result.discovery = amount;
    }
    if (value.country != null) {
        const country = String(value.country).toUpperCase();
        if (!/^[A-Z]{2}$/.test(country)) throw new TypeError('Country must use a two-letter code.');
        result.country = country;
    }
    return result;
}
function sanitizeSignal(value, now) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('A user interaction signal is required.');
    const type = String(value.type || '');
    if (!['search', 'album-open', 'artist-open', 'playlist-open', 'skip'].includes(type)) throw new TypeError('Unsupported user interaction signal.');
    const signal = { id: crypto.randomUUID(), type, at: safeDate(value.at, now) };
    if (type === 'search') {
        const query = String(value.query || '').normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 220);
        const kinds = ['all', 'tracks', 'albums', 'artists', 'videos'];
        const kind = String(value.kind || 'all');
        if (query.length < 2 || !kinds.includes(kind)) throw new TypeError('Invalid search intent signal.');
        signal.query = query; signal.kind = kind;
    } else if (type === 'skip') {
        const eventId = String(value.eventId || '').trim();
        if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(eventId)) throw new TypeError('Invalid skip event identity.');
        const item = sanitizeItem(value.item, 'track');
        if (!['track', 'video'].includes(item.kind)) throw new TypeError('A skip signal requires a track or video.');
        const listenedSeconds = Number(value.listenedSeconds);
        const duration = Number(value.duration ?? item.duration ?? 0);
        if (!Number.isFinite(listenedSeconds) || listenedSeconds < 0 || listenedSeconds > 86400
            || !Number.isFinite(duration) || duration < 0 || duration > 86400) throw new TypeError('Invalid skip progress.');
        signal.eventId = eventId; signal.item = item; signal.listenedSeconds = listenedSeconds; signal.duration = duration;
    } else {
        const expectedKind = type === 'album-open' ? 'album' : type === 'playlist-open' ? 'playlist' : 'artist';
        const item = sanitizeItem(value.item, expectedKind);
        if (item.kind !== expectedKind) throw new TypeError('The opened catalog item does not match its signal type.');
        signal.item = item;
    }
    return signal;
}
function corrupt(id, cause) {
    const error = new Error(`Platform library for user ${id} is corrupt; existing data has been preserved.`, { cause });
    error.code = 'PLATFORM_STORE_CORRUPT';
    return error;
}

class PlatformStore {
    constructor({ dataDir = path.join(__dirname, '..', 'data'), now = Date.now, maxEvents = storageLimit('PLATFORM_HISTORY_MAX_EVENTS', MAX_EVENTS) } = {}) {
        this.dataDir = path.resolve(dataDir);
        this.now = now;
        this.maxEvents = storageLimit('PLATFORM_HISTORY_MAX_EVENTS', MAX_EVENTS, maxEvents);
        this.maxItems = storageLimit('PLATFORM_COLLECTION_MAX_ITEMS', MAX_ITEMS);
        this.maxFeedback = storageLimit('PLATFORM_FEEDBACK_MAX_ITEMS', MAX_FEEDBACK);
        this.maxSignals = storageLimit('PLATFORM_INTERACTION_MAX_EVENTS', MAX_SIGNALS);
        this.pending = new Set();
    }
    file(user) {
        const id = userIdOf(user);
        return path.join(this.dataDir, 'platform', id.slice(0, 2), id.slice(2, 4), `${id}.json`);
    }
    _serialize(user, work) {
        const id = userIdOf(user), file = this.file(id);
        const prior = locks.get(file) || Promise.resolve();
        const next = prior.catch(() => {}).then(() => work(id));
        locks.set(file, next); this.pending.add(next);
        next.finally(() => { this.pending.delete(next); if (locks.get(file) === next) locks.delete(file); }).catch(() => {});
        return next;
    }
    async _read(id) {
        let text;
        try { text = await fs.readFile(this.file(id), 'utf8'); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            // A process can stop between the two Windows replacement renames.
            // The last valid file remains available under a deterministic name.
            try { text = await fs.readFile(`${this.file(id)}.previous`, 'utf8'); }
            catch (previousError) { if (previousError.code === 'ENOENT') return emptyRecord(id, this.now()); throw previousError; }
        }
        try {
            const parsed = JSON.parse(text);
            if (parsed.version !== 1 || parsed.userId !== id || !Number.isInteger(parsed.revision)
                || !parsed.collections || !Array.isArray(parsed.events) || !Array.isArray(parsed.feedback)
                || parsed.signals != null && !Array.isArray(parsed.signals)
                || !parsed.settings || COLLECTIONS.filter(k => k !== 'downloads').some(k => !Array.isArray(parsed.collections[k]))
                || parsed.collections.downloads != null && !Array.isArray(parsed.collections.downloads)) throw new Error('Invalid platform record schema.');
            // A checksum catches valid JSON truncated/replaced at field boundaries.
            const { checksum, ...record } = parsed;
            if (typeof checksum !== 'string' || checksum !== crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex')) throw new Error('Record checksum mismatch.');
            // Verify the original bytes before migrating a version-one record.
            record.collections.downloads ||= [];
            record.signals ||= [];
            return record;
        } catch (error) { throw corrupt(id, error); }
    }
    async _diskLock(id, work) {
        const target = this.file(id), lockFile = `${target}.lock`;
        await fs.mkdir(path.dirname(target), { recursive: true });
        const deadline = Date.now() + 5000;
        let handle;
        while (!handle) {
            try {
                handle = await fs.open(lockFile, 'wx', 0o600);
                await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
            } catch (error) {
                const existingLock = error.code === 'EEXIST' || (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code) && await fs.stat(lockFile).then(stat => stat.isFile(), () => false));
                if (!existingLock) { await handle?.close().catch(() => {}); throw error; }
                // Remove only a stale lock whose owning process is known to be
                // gone; age alone must never steal a busy Windows writer's lock.
                try {
                    const owner = JSON.parse(await fs.readFile(lockFile, 'utf8'));
                    if (Number.isInteger(owner.pid) && owner.pid > 0) {
                        try { process.kill(owner.pid, 0); }
                        catch (check) { if (check.code === 'ESRCH') await fs.rm(lockFile, { force: true }); }
                    }
                } catch (_) {}
                if (Date.now() > deadline) { const busy = new Error('Platform library is busy; retry shortly.'); busy.code = 'PLATFORM_STORE_BUSY'; throw busy; }
                await new Promise(resolve => setTimeout(resolve, 20));
            }
        }
        try { return await work(); }
        finally { await handle.close().catch(() => {}); await fs.rm(lockFile, { force: true }).catch(() => {}); }
    }
    async _write(id, record) {
        const target = this.file(id), nonce = crypto.randomBytes(8).toString('hex');
        const tmp = `${target}.${process.pid}.${nonce}.tmp`;
        const encoded = JSON.stringify({ ...record, checksum: crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex') });
        const handle = await fs.open(tmp, 'wx', 0o600);
        try { await handle.writeFile(encoded); await handle.sync(); }
        finally { await handle.close(); }
        try {
            try { await fs.rename(tmp, target); }
            catch (error) {
                if (!['EPERM', 'EACCES', 'EEXIST'].includes(error.code)) throw error;
                // Preserve the previous file while Windows refuses replacement.
                const backup = `${target}.previous`;
                await fs.rm(backup, { force: true });
                try { await fs.rename(target, backup); }
                catch (backupError) { if (backupError.code !== 'ENOENT') throw backupError; }
                try { await fs.rename(tmp, target); await fs.rm(backup, { force: true }); }
                catch (replacementError) { await fs.rename(backup, target).catch(() => {}); throw replacementError; }
            }
            await fs.rm(`${target}.previous`, { force: true });
            // Directory fsync is unsupported on some Windows filesystems.
            let directory;
            try { directory = await fs.open(path.dirname(target), 'r'); await directory.sync(); }
            catch (_) {} finally { await directory?.close().catch(() => {}); }
        } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
    }
    _update(user, mutate) {
        return this._serialize(user, id => this._diskLock(id, async () => {
            const record = await this._read(id);
            const result = await mutate(record);
            record.revision++; record.updatedAt = new Date(this.now()).toISOString();
            await this._write(id, record);
            return clone(result);
        }));
    }
    read(user, options = {}) { return this._serialize(user, async id => {
        const record = clone(await this._read(id));
        if (options.eventLimit != null) {
            const limit = storageLimit('eventLimit', 0, options.eventLimit);
            record.events = limit === 0 ? [] : recent(record.events, limit);
        }
        return record;
    }); }
    async list(user, kind) { const collection = collectionOf(kind); return (await this.read(user)).collections[collection]; }
    save(user, kind, value) {
        return Promise.resolve().then(() => {
            const collection = collectionOf(kind), item = sanitizeItem(value, collection === 'mixes' ? 'mix' : collection.slice(0, -1));
            if (collection === 'downloads') throw new TypeError('Downloads must come from a completed server transfer.');
            if (collection === 'purchases' && !(item.importedExternal && item.url)) throw new TypeError('Purchases must be imported external purchase links.');
            if (collection === 'profiles' && !item.url && !item.website) throw new TypeError('Profiles need a real imported profile link.');
            item.savedAt = new Date(this.now()).toISOString();
            return this._update(user, record => {
                const items = record.collections[collection], key = itemKey(item);
                const previous = items.find(x => itemKey(x) === key);
                const saved = { ...previous, ...item, savedAt: previous?.savedAt || item.savedAt };
                record.collections[collection] = retain([saved, ...items.filter(x => itemKey(x) !== key)], this.maxItems);
                return saved;
            });
        });
    }
    remove(user, kind, value) {
        return Promise.resolve().then(() => {
            const collection = collectionOf(kind), key = itemKey(value);
            if (!key) throw new TypeError('An item identity is required.');
            return this._update(user, record => {
                const before = record.collections[collection];
                record.collections[collection] = before.filter(x => itemKey(x) !== key);
                return { removed: before.length - record.collections[collection].length, id: key };
            });
        });
    }
    setSettings(user, value) {
        return Promise.resolve().then(() => {
            const patch = settingsPatch(value);
            return this._update(user, record => { record.settings = { ...record.settings, ...patch }; return record.settings; });
        });
    }
    recordSignal(user, value) {
        return Promise.resolve().then(() => {
            const signal = sanitizeSignal(value, this.now());
            return this._update(user, record => {
                record.signals ||= [];
                if (signal.type === 'skip') {
                    const prior = record.signals.find(item => item.type === 'skip' && item.eventId === signal.eventId);
                    if (prior) return prior;
                    signal.count = 1;
                    record.signals.push(signal);
                    record.signals = recent(record.signals, this.maxSignals);
                    return signal;
                }
                const identity = signal.type === 'search' ? `${signal.type}:${signal.kind}:${normalized(signal.query)}`
                    : `${signal.type}:${itemKey(signal.item)}`;
                const windowMs = signal.type === 'search' ? 6 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
                for (let index = record.signals.length - 1; index >= 0; index--) {
                    const prior = record.signals[index];
                    const priorIdentity = prior.type === 'search' ? `${prior.type}:${prior.kind}:${normalized(prior.query)}`
                        : `${prior.type}:${itemKey(prior.item)}`;
                    if (priorIdentity !== identity || this.now() - Date.parse(prior.at || '') > windowMs) continue;
                    const updated = { ...prior, at: signal.at, count: Math.min(1_000_000_000, (Number(prior.count) || 1) + 1) };
                    record.signals[index] = updated;
                    return updated;
                }
                signal.count = 1;
                record.signals.push(signal);
                record.signals = recent(record.signals, this.maxSignals);
                return signal;
            });
        });
    }
    recordDownload(user, value, details = {}) {
        return Promise.resolve().then(() => {
            const track = sanitizeItem(value, 'track'); delete track.tracks;
            const id = String(details.id || ''), bytes = Number(details.bytes), guildId = String(details.guildId || '');
            if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}(?::\d{1,4})?$/i.test(id) || !/^\d{5,32}$/.test(guildId)
                || !Number.isSafeInteger(bytes) || bytes <= 0) throw new TypeError('Invalid server transfer record.');
            const completedAt = safeDate(details.completedAt, this.now());
            const item = { ...track, kind: 'download', id, track, trackKey: canonicalTrackKey(track), guildId,
                filename: String(details.filename || '').slice(0, 260), mime: String(details.mime || '').slice(0, 100),
                quality: String(details.quality || 'Original source').slice(0, 100), bytes, size: bytes,
                completedAt, downloadedAt: completedAt, completion: 'server-transfer' };
            return this._update(user, record => {
                const old = record.collections.downloads.find(x => x.id === id); if (old) return old;
                record.collections.downloads = retain([item, ...record.collections.downloads], this.maxItems); return item;
            });
        });
    }
    removeDownload(user, id) { return this.remove(user, 'downloads', String(id || '')); }
    setFeedback(user, value, opinion, reason) {
        return Promise.resolve().then(() => {
            const item = sanitizeItem(value), key = itemKey(item);
            const aliases = { negative: 'dislike', positive: 'like', hide: 'hide-track', 'not-interested': 'hide-track', block: 'block-artist', reset: 'clear' };
            const feedback = aliases[opinion] || opinion;
            if (!['like', 'dislike', 'hide-track', 'block-artist', 'clear'].includes(feedback)) throw new TypeError('Unsupported feedback value.');
            return this._update(user, record => {
                record.feedback = record.feedback.filter(x => x.key !== key);
                if (feedback !== 'clear') record.feedback.unshift({ key, item, value: feedback, reason: String(reason || '').slice(0, 400), at: new Date(this.now()).toISOString() });
                record.feedback = retain(record.feedback, this.maxFeedback);
                return { item, value: feedback };
            });
        });
    }
    recordPlay(user, value, details = {}) {
        return Promise.resolve().then(() => {
            const item = sanitizeItem(value, 'track');
            if (!['track', 'video'].includes(item.kind)) throw new TypeError('A listening event requires a track or video.');
            delete item.tracks;
            const eventId = details.eventId == null ? crypto.randomUUID() : String(details.eventId).trim().slice(0, 200);
            if (!eventId) throw new TypeError('Invalid play event identity.');
            const at = safeDate(details.at ?? details.playedAt, this.now());
            const seconds = Number(details.listenedSeconds ?? details.seconds ?? 0);
            if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw new TypeError('Invalid listening seconds.');
            return this._update(user, record => {
                const old = record.events.find(x => x.id === eventId);
                if (old) return old;
                const event = { id: eventId, track: item, at, seconds, completed: details.completed === true };
                if (details.endedAt != null) event.endedAt = safeDate(details.endedAt);
                record.events.push(event);
                // Repeated titles and URLs are deliberately never deduplicated.
                if (this.maxEvents > 0 && record.events.length > this.maxEvents) record.events.splice(0, record.events.length - this.maxEvents);
                return event;
            });
        });
    }
    updatePlay(user, eventId, details = {}) {
        return this._update(user, record => {
            const event = record.events.find(x => x.id === String(eventId));
            if (!event) { const error = new Error('Listening event was not found.'); error.code = 'PLAY_EVENT_NOT_FOUND'; throw error; }
            if (details.listenedSeconds != null) {
                const seconds = Number(details.listenedSeconds);
                if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw new TypeError('Invalid listening seconds.');
                event.seconds = Math.max(event.seconds, seconds);
            }
            if (details.endedAt != null) event.endedAt = safeDate(details.endedAt);
            if (details.completed === true) event.completed = true;
            if (['completed', 'skip', 'manual-stop', 'replaced', 'disconnect', 'error', 'shutdown'].includes(details.endReason)) event.endReason = details.endReason;
            return event;
        });
    }
    async stats(user, month) {
        const selected = month || new Date(this.now()).toISOString().slice(0, 7);
        if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(selected) || Number(selected.slice(0, 4)) < 1970 || Number(selected.slice(0, 4)) > 2200) throw new TypeError('Invalid listening month; use YYYY-MM.');
        const record = await this.read(user), events = record.events.filter(x => x.at.slice(0, 7) === selected);
        const tracks = new Map(), artists = new Map();
        let totalSeconds = 0, catalogDurationSeconds = 0;
        for (const event of events) {
            totalSeconds += event.seconds; catalogDurationSeconds += Number(event.track.duration || 0);
            const key = trackKey(event.track), title = event.track.author || 'Unknown artist';
            const artistKey = normalized(title);
            const t = tracks.get(key) || { ...event.track, plays: 0, seconds: 0, lastPlayedAt: event.at };
            t.plays++; t.seconds += event.seconds;
            if (event.at > t.lastPlayedAt) t.lastPlayedAt = event.at;
            tracks.set(key, t);
            const a = artists.get(artistKey) || { kind: 'artist', id: event.track.artistId || '', title,
                thumbnail: record.collections.artists.find(x => normalized(x.title) === artistKey)?.thumbnail || '', plays: 0, seconds: 0 };
            a.plays++; a.seconds += event.seconds; artists.set(artistKey, a);
        }
        const rank = (a, b) => b.plays - a.plays || b.seconds - a.seconds || String(a.title).localeCompare(String(b.title));
        return {
            month: selected, totalPlays: events.length, totalSeconds, catalogDurationSeconds,
            measuredPlays: events.filter(x => x.seconds > 0).length,
            topArtists: [...artists.values()].sort(rank).slice(0, 50),
            topTracks: [...tracks.values()].sort(rank).slice(0, 100),
            availableMonths: [...new Set(record.events.map(x => x.at.slice(0, 7)))].sort().reverse(),
            retention: { maxEvents: this.maxEvents, storedEvents: record.events.length },
        };
    }
    async flushAll() { await Promise.allSettled([...this.pending]); }
}

const backend = process.env.STORAGE_BACKEND || require('../config').STORAGE_BACKEND || 'sqlite';
module.exports = backend === 'json' ? new PlatformStore({ dataDir: process.env.DATA_DIR || require('../config').DATA_DIR || path.join(__dirname, '..', 'data') }) : require('./sqliteStoreAdapters').createSqlitePlatformStore();
module.exports.PlatformStore = PlatformStore;
module.exports.createPlatformStore = options => new PlatformStore(options);
module.exports.userIdOf = userIdOf;
module.exports.itemKey = itemKey;
module.exports.sanitizeItem = sanitizeItem;
