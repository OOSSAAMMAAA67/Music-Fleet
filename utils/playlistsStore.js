'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalTrackKey, catalogMetadata } = require('./trackIdentity');
const { storageLimit } = require('./storageLimits');

function compactTrack(track) {
    const url = String(track?.url || '');
    if (!/^https?:\/\//i.test(url)) throw new Error('A playable track is required.');
    return { ...catalogMetadata(track), title: String(track.title || 'Unknown').slice(0, 220),
        author: String(track.author || 'Unknown').slice(0, 160), url: url.slice(0, 1000),
        thumbnail: String(track.thumbnail || '').slice(0, 1000), duration: Number(track.duration || 0),
        source: String(track.source || 'ytdlp').slice(0, 40), provider: String(track.provider || '').slice(0, 40),
        linkedProvider: String(track.linkedProvider || '').slice(0, 40),
        linkedOriginalUrl: String(track.linkedOriginalUrl || '').slice(0, 1000),
        linkedResolvedUrl: String(track.linkedResolvedUrl || '').slice(0, 1000),
        linkedThumbnail: String(track.linkedThumbnail || '').slice(0, 1000),
        linkedTitle: String(track.linkedTitle || '').slice(0, 320),
        mediaTitle: String(track.mediaTitle || '').slice(0, 240), mediaArtist: String(track.mediaArtist || '').slice(0, 200),
        album: String(track.album || '').slice(0, 240), albumArtist: String(track.albumArtist || '').slice(0, 200),
        releaseYear: Number(track.releaseYear || 0) || 0 };
}

class PlaylistsStore {
    constructor(dataDir = path.join(__dirname, '..', 'data')) {
        this.dataDir = dataDir;
        this.maxPlaylists = storageLimit('PLAYLISTS_MAX_PER_USER', 500);
        this.maxTracks = storageLimit('PLAYLIST_MAX_TRACKS', 10000);
        this.locks = new Map();
    }
    id(user) {
        const value = String(typeof user === 'string' ? user : user?.id || '');
        if (!/^\d{5,32}$/.test(value)) throw new Error('Invalid user.');
        return value;
    }
    file(id) { return path.join(this.dataDir, 'playlists', id.slice(0, 2), id.slice(2, 4), `${id}.json`); }
    async read(id) {
        const file = this.file(id);
        let text, recovered = false;
        try {
            text = await fs.readFile(file, 'utf8');
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
            try { text = await fs.readFile(`${file}.previous`, 'utf8'); recovered = true; }
            catch (previousError) { if (previousError.code === 'ENOENT') return []; throw previousError; }
        }
        const data = JSON.parse(text);
        if (recovered && (data?.version !== 1 || data.userId !== id || !Array.isArray(data.playlists)
            || data.playlists.some(list => !list || typeof list.id !== 'string' || typeof list.name !== 'string' || !Array.isArray(list.tracks)))) {
            throw new Error('Invalid playlist recovery record; existing data has been preserved.');
        }
        return Array.isArray(data.playlists) ? data.playlists : [];
    }
    async write(id, lists) {
        const file = this.file(id);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        await fs.writeFile(tmp, JSON.stringify({ version: 1, userId: id, playlists: lists }), { flag: 'wx' });
        try {
            try { await fs.rename(tmp, file); }
            catch (err) {
                if (!['EPERM', 'EEXIST', 'EACCES'].includes(err.code)) throw err;
                const exists = await fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
                // A restarted process may be reading the only committed copy from
                // .previous. Never remove it to back up a target that is absent.
                if (!exists) throw err;
                const backup = `${file}.previous`;
                await fs.rm(backup, { force: true });
                await fs.rename(file, backup);
                try { await fs.rename(tmp, file); await fs.rm(backup, { force: true }); }
                catch (replacementError) { await fs.rename(backup, file).catch(() => {}); throw replacementError; }
            }
            await fs.rm(`${file}.previous`, { force: true });
        } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
    }
    update(user, mutate) {
        const id = this.id(user);
        const prior = this.locks.get(id) || Promise.resolve();
        const pending = prior.catch(() => {}).then(async () => {
            const lists = await this.read(id);
            const result = mutate(lists);
            await this.write(id, lists);
            return result;
        });
        this.locks.set(id, pending);
        pending.finally(() => { if (this.locks.get(id) === pending) this.locks.delete(id); }).catch(() => {});
        return pending;
    }
    async list(user) {
        const id = this.id(user);
        await (this.locks.get(id) || Promise.resolve()).catch(() => {});
        return (await this.read(id)).map(({ tracks, ...rest }) => ({ ...rest, count: tracks.length, thumbnail: tracks[0]?.thumbnail || '' }));
    }
    async get(user, playlistId) {
        const id = this.id(user);
        await (this.locks.get(id) || Promise.resolve()).catch(() => {});
        const list = (await this.read(id)).find(x => x.id === playlistId);
        return list ? { ...list, tracks: list.tracks.map(t => ({ ...t })) } : null;
    }
    create(user, name, options = {}) {
        const clean = String(name || '').trim().slice(0, 80);
        if (!clean) throw new Error('Enter a playlist name.');
        const sourceId = options?.sourceId == null ? '' : String(options.sourceId).trim();
        const sourceProviderUrl = options?.sourceProviderUrl == null ? '' : String(options.sourceProviderUrl).trim();
        if (options?.sourceId != null && (!sourceId || sourceId.length > 300 || !/^[a-z][a-z\d_-]{0,39}:playlist:[a-z\d._-]{1,220}$/i.test(sourceId))) {
            throw new TypeError('Invalid playlist source identity.');
        }
        if (options?.sourceProviderUrl != null) {
            let url;
            try { url = new URL(sourceProviderUrl); } catch (_) {}
            if (!url || !['http:', 'https:'].includes(url.protocol) || sourceProviderUrl.length > 2000) throw new TypeError('Invalid playlist source URL.');
        }
        return this.update(user, lists => {
            const existing = sourceId && lists.find(list => list.sourceId === sourceId);
            if (existing) return existing;
            if (this.maxPlaylists > 0 && lists.length >= this.maxPlaylists) throw new Error('Playlist limit reached.');
            if (options.tracks != null && !Array.isArray(options.tracks)) throw new TypeError('A playlist track list is required.');
            if (this.maxTracks > 0 && (options.tracks?.length || 0) > this.maxTracks) throw new Error('Playlist is full.');
            const seen = new Set(), tracks = [];
            for (const candidate of options.tracks || []) {
                const track = compactTrack(candidate), key = canonicalTrackKey(track);
                if (!seen.has(key)) { seen.add(key); tracks.push(track); }
            }
            const item = { id: crypto.randomUUID(), name: clean, createdAt: new Date().toISOString(), tracks,
                ...(sourceId ? { sourceId } : {}), ...(sourceProviderUrl ? { sourceProviderUrl } : {}) };
            lists.unshift(item);
            return item;
        });
    }
    rename(user, playlistId, name) {
        const clean = String(name || '').trim().slice(0, 80);
        if (!clean) throw new Error('Enter a playlist name.');
        return this.update(user, lists => {
            const item = lists.find(x => x.id === playlistId);
            if (!item) throw new Error('Playlist not found.');
            item.name = clean; return item;
        });
    }
    delete(user, playlistId) {
        return this.update(user, lists => {
            const index = lists.findIndex(x => x.id === playlistId);
            if (index < 0) throw new Error('Playlist not found.');
            lists.splice(index, 1); return true;
        });
    }
    add(user, playlistId, track) {
        const compact = compactTrack(track);
        return this.update(user, lists => {
            const item = lists.find(x => x.id === playlistId);
            if (!item) throw new Error('Playlist not found.');
            if (item.tracks.some(x => canonicalTrackKey(x) === canonicalTrackKey(track))) return item;
            if (this.maxTracks > 0 && item.tracks.length >= this.maxTracks) throw new Error('Playlist is full.');
            item.tracks.push(compact);
            return item;
        });
    }
    remove(user, playlistId, index) {
        return this.update(user, lists => {
            const item = lists.find(x => x.id === playlistId);
            if (!item) throw new Error('Playlist not found.');
            const i = Number(index);
            if (!Number.isInteger(i) || i < 0 || i >= item.tracks.length) throw new Error('Track not found.');
            item.tracks.splice(i, 1); return item;
        });
    }
    async flushAll() {
        await Promise.allSettled([...this.locks.values()]);
    }
}
const backend = process.env.STORAGE_BACKEND || require('../config').STORAGE_BACKEND || 'sqlite';
module.exports = backend === 'json' ? new PlaylistsStore(process.env.DATA_DIR || require('../config').DATA_DIR || path.join(__dirname, '..', 'data')) : require('./sqliteStoreAdapters').createSqlitePlaylistsStore();
module.exports.PlaylistsStore = PlaylistsStore;
