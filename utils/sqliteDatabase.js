'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const MAX_LEGACY_BYTES = 64 * 1024 * 1024;
function storageError(message, code, cause) { return Object.assign(new Error(message, { cause }), { code }); }
function checksum(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function decode(row, store, id) {
    if (!row) return null;
    try {
        if (checksum(row.record) !== row.checksum) throw new Error('Record checksum mismatch.');
        const record = JSON.parse(row.record);
        if (record.userId !== id) throw new Error('Record user does not match its index.');
        return record;
    } catch (cause) { throw storageError(`${store} library for user ${id} is corrupt; existing data has been preserved.`, `${store.toUpperCase()}_STORE_CORRUPT`, cause); }
}
function openDatabase(filename, { synchronous = false, events = false } = {}) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const db = new DatabaseSync(filename);
    try {
        // Only the worker may wait for another writer. Synchronous favorites
        // fail immediately on contention instead of stalling the audio loop.
        db.exec(`PRAGMA busy_timeout=${synchronous ? 0 : 5000}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;`);
        const version = db.prepare('PRAGMA user_version').get().user_version;
        if (version > 1) throw storageError('Storage database version is newer than this application.', 'STORAGE_VERSION');
        db.exec(`CREATE TABLE IF NOT EXISTS user_records (
            store TEXT NOT NULL, user_id TEXT NOT NULL, record TEXT NOT NULL, checksum TEXT NOT NULL,
            PRIMARY KEY(store,user_id)
        ) STRICT, WITHOUT ROWID;`);
        if (events) db.exec(`CREATE TABLE IF NOT EXISTS platform_state (
            user_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=0), updated_at TEXT NOT NULL, checksum TEXT NOT NULL
        ) STRICT, WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS play_events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, month TEXT NOT NULL,
            track TEXT NOT NULL, checksum TEXT NOT NULL,
            seconds REAL NOT NULL CHECK(seconds>=0 AND seconds<=86400),
            completed INTEGER NOT NULL CHECK(completed IN (0,1)), ended_at TEXT,
            UNIQUE(user_id,id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS play_events_user_seq ON play_events(user_id,seq);
        CREATE INDEX IF NOT EXISTS play_events_user_month ON play_events(user_id,month,seq);`);
        db.exec('PRAGMA user_version=1');
        const valid = db.prepare('PRAGMA quick_check').get();
        if (Object.values(valid)[0] !== 'ok') throw storageError('Storage database is corrupt; it has been preserved.', 'STORAGE_CORRUPT');
        return db;
    } catch (error) { db.close(); throw error; }
}
class Records {
    constructor(db) {
        this.read = db.prepare('SELECT record,checksum FROM user_records WHERE store=? AND user_id=?');
        this.put = db.prepare('INSERT INTO user_records(store,user_id,record,checksum) VALUES(?,?,?,?) ON CONFLICT(store,user_id) DO UPDATE SET record=excluded.record,checksum=excluded.checksum');
    }
    get(store, id) { return decode(this.read.get(store, id), store, id); }
    set(store, id, value) { const text = JSON.stringify(value); this.put.run(store, id, text, checksum(text)); }
}
module.exports = { openDatabase, Records, checksum, decode, storageError, MAX_LEGACY_BYTES };
