'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { backup } = require('node:sqlite');
const { SQLiteFavoritesStore, createAsyncStore } = require('./sqliteStoreAdapters');
const { storageError } = require('./sqliteDatabase');
const services = new Map();
const legacyKinds = ['favorites', 'history', 'playlists', 'platform'];
async function copyLegacyDirectory(source, destination) {
    let directory;
    try { directory = await fsp.opendir(source); }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    let copied = 0;
    for await (const entry of directory) {
        const from = path.join(source, entry.name), to = path.join(destination, entry.name);
        if (entry.isDirectory()) copied += await copyLegacyDirectory(from, to);
        else if (entry.isFile() && /^\d{5,32}\.json(?:\.previous|\.\d+\.[a-f\d]{10}\.bak)?$/i.test(entry.name)) {
            await fsp.mkdir(destination, { recursive: true });
            await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL); copied++;
        }
    }
    return copied;
}
async function copyLegacyFiles(source, destination) {
    let copied = 0;
    for (const kind of legacyKinds) copied += await copyLegacyDirectory(path.join(source, kind), path.join(destination, kind));
    try { await fsp.copyFile(path.join(source, 'favorites.json'), path.join(destination, 'favorites.json'), fs.constants.COPYFILE_EXCL); copied++; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return copied;
}
function canonicalDir(dataDir) {
    const resolved = path.resolve(dataDir); fs.mkdirSync(resolved, { recursive: true });
    const canonical = fs.realpathSync.native(resolved);
    return { directory: canonical, key: process.platform === 'win32' ? canonical.toLowerCase() : canonical };
}
class SharedStorage {
    constructor(options, directory) {
        this.dataDir = directory; this.options = { ...options, dataDir: directory };
        this.maxPending = Math.max(1, Math.min(10000, Math.floor(Number(options.maxPending) || 2048)));
        this.paths = { library: path.join(directory, 'shared.sqlite'), favorites: path.join(directory, 'favorites.sqlite') };
        this.pending = new Map(); this.nextId = 1; this.worker = null; this.closed = false; this.closing = false; this.maintenance = false; this.failure = null;
        this.favorites = new SQLiteFavoritesStore(this.options, this);
        this.history = createAsyncStore('history', this.options, this);
        this.playlists = createAsyncStore('playlists', this.options, this);
        this.platform = createAsyncStore('platform', this.options, this);
    }
    assertAvailable() {
        if (this.closed || this.closing) throw storageError('Shared storage is closed.', 'STORAGE_CLOSED');
        if (this.failure) throw this.failure;
        if (this.maintenance) throw storageError('Shared storage is making a consistent backup; retry shortly.', 'STORAGE_BUSY');
    }
    _worker() {
        if (this.worker) return this.worker;
        this.worker = new Worker(path.join(__dirname, 'sqliteStorageWorker.js'), { workerData: this.options });
        this.worker.on('message', message => {
            const entry = this.pending.get(message.id); if (!entry) return;
            this.pending.delete(message.id);
            if (message.error) {
                const error = message.error.name === 'TypeError' ? new TypeError(message.error.message) : new Error(message.error.message);
                if (message.error.code) error.code = message.error.code;
                entry.reject(error);
            } else entry.resolve(message.result);
            if (!this.pending.size) this.worker?.unref();
        });
        const fail = error => {
            this.failure = storageError(`Shared storage worker failed: ${error.message}`, 'STORAGE_WORKER_FAILED', error);
            for (const entry of this.pending.values()) entry.reject(this.failure);
            this.pending.clear(); this.worker?.unref();
        };
        this.worker.on('error', fail);
        this.worker.on('exit', code => { if (!this.closed && !this.closing) fail(new Error(`Worker exited with code ${code}.`)); });
        this.worker.unref(); return this.worker;
    }
    _send(store, method, args, internal = false) {
        try {
            if (!internal) this.assertAvailable();
            if (!internal && this.pending.size >= this.maxPending) throw storageError('Shared storage queue is full; retry shortly.', 'STORAGE_BUSY');
            const worker = this._worker(), id = this.nextId++; worker.ref();
            const promise = new Promise((resolve, reject) => {
                this.pending.set(id, { resolve, reject });
                try { worker.postMessage({ id, store, method, args }); }
                catch (error) { this.pending.delete(id); reject(error); if (!this.pending.size) worker.unref(); }
            });
            // The drain waits the actual accepted operation, including errors.
            const entry = this.pending.get(id); if (entry) entry.promise = promise;
            return promise;
        } catch (error) { return Promise.reject(error); }
    }
    request(store, method, args) { return this._send(store, method, args); }
    async flush() { this.assertAvailable(); await Promise.all([...this.pending.values()].map(entry => entry.promise)); }
    backup(destination) {
        try { this.assertAvailable(); } catch (error) { return Promise.reject(error); }
        this.maintenance = true;
        const operation = this._backup(destination);
        this.backupPromise = operation;
        operation.finally(() => { this.maintenance = false; this.backupPromise = null; }).catch(() => {});
        return operation;
    }
    async _backup(destination) {
        try {
            const target = path.resolve(destination);
            const canonical = canonicalDir(target);
            if (canonical.key === canonicalDir(this.dataDir).key) throw storageError('Backup must use another directory.', 'STORAGE_BACKUP_DESTINATION');
            const relative = path.relative(this.dataDir, canonical.directory).split(path.sep)[0].toLowerCase();
            if (legacyKinds.includes(relative)) throw storageError('Backup must be outside the legacy library directories.', 'STORAGE_BACKUP_DESTINATION');
            if ((await fsp.readdir(canonical.directory)).length) throw storageError('Backup destination must be an empty directory.', 'STORAGE_BACKUP_DESTINATION');
            const destinations = { library: path.join(canonical.directory, 'shared.sqlite'), favorites: path.join(canonical.directory, 'favorites.sqlite') };
            for (const filename of Object.values(destinations)) if (fs.existsSync(filename)) throw storageError('Backup destination already contains a database; choose an empty directory.', 'STORAGE_BACKUP_DESTINATION');
            await Promise.allSettled([...this.pending.values()].map(entry => entry.promise));
            // No accepted favorite/library mutations can interleave between the
            // two SQLite online backups while maintenance is held.
            this.favorites._connect();
            await this._send(null, 'backup', [destinations.library], true);
            await backup(this.favorites.db, destinations.favorites);
            // Unmigrated users still live in immutable legacy JSON. Copy those
            // originals as part of the same drained backup, never DB/WAL files.
            const legacyFiles = await copyLegacyFiles(this.dataDir, canonical.directory);
            const manifest = { version: 1, createdAt: new Date().toISOString(), databases: ['shared.sqlite', 'favorites.sqlite'], legacyFiles };
            await fsp.writeFile(path.join(canonical.directory, 'storage-backup.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
            return { dataDir: canonical.directory, ...destinations, createdAt: manifest.createdAt, legacyFiles };
        } catch (error) { throw error; }
    }
    async close() {
        if (this.closePromise) return this.closePromise;
        if (this.closed) return;
        this.closing = true;
        this.closePromise = (async () => {
            let error;
            // An accepted backup owns both handles until the consistent
            // snapshot has finished, even when shutdown was requested later.
            if (this.backupPromise) {
                try { await this.backupPromise; } catch (cause) { error = cause; }
            }
            const active = await Promise.allSettled([...this.pending.values()].map(entry => entry.promise));
            const rejected = active.filter(entry => entry.status === 'rejected');
            if (rejected.length) error = new AggregateError(rejected.map(entry => entry.reason), 'Shared storage operations failed during shutdown.');
            try { if (this.worker && !this.failure) await this._send(null, 'close', [], true); }
            catch (cause) { error ||= cause; }
            finally { this.favorites._close(); this.closed = true; if (this.worker) await this.worker.terminate(); this.worker = null; }
            if (error) throw error;
        })();
        return this.closePromise;
    }
}
function getSharedStorage(options = {}) {
    const config = require('../config');
    const dataDir = options.dataDir || process.env.DATA_DIR || config.DATA_DIR || path.join(__dirname, '..', 'data');
    const canonical = canonicalDir(dataDir);
    let service = services.get(canonical.key);
    if (!service || service.closed) { service = new SharedStorage(options, canonical.directory); services.set(canonical.key, service); }
    return service;
}
async function closeSharedStorage() {
    const results = await Promise.allSettled([...services.values()].map(service => service.close()));
    services.clear(); const failed = results.filter(result => result.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Could not cleanly close shared storage.');
}
function backupSharedStorage(destination) { return getSharedStorage().backup(destination); }
module.exports = { getSharedStorage, closeSharedStorage, backupSharedStorage };
