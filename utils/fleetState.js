'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function nonempty(value, field) {
    if (typeof value !== 'string' || !value.trim() || value.length > 150 || /[\r\n\0]/.test(value)) {
        throw new Error(`Fleet state ${field} is invalid.`);
    }
    return value.trim();
}
function normalizePin(pin) {
    if (!pin || typeof pin !== 'object') throw new Error('Fleet state pin is invalid.');
    return { botKey: nonempty(pin.botKey, 'bot key'), guildId: nonempty(pin.guildId, 'guild ID'),
        voiceChannelId: nonempty(pin.voiceChannelId, 'voice channel ID'),
        textChannelId: pin.textChannelId == null ? null : nonempty(pin.textChannelId, 'text channel ID') };
}
function normalizeState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.pins)
        || !Array.isArray(value.owners) || !value.prefixes || typeof value.prefixes !== 'object' || Array.isArray(value.prefixes)) {
        throw new Error('Fleet state is corrupt or invalid. Preserve the file before repairing it.');
    }
    const pins = value.pins.map(normalizePin);
    const identities = new Set();
    const rooms = new Set();
    for (const pin of pins) {
        const key = `${pin.botKey}\0${pin.guildId}`;
        const room = `${pin.guildId}\0${pin.voiceChannelId}`;
        if (identities.has(key) || rooms.has(room)) throw new Error('Fleet state contains duplicate pins.');
        identities.add(key); rooms.add(room);
    }
    const owners = [...new Set(value.owners.map(id => nonempty(id, 'owner ID')))];
    const prefixes = {};
    for (const [id, prefix] of Object.entries(value.prefixes)) {
        const guildId = nonempty(id, 'guild ID');
        if (typeof prefix !== 'string' || !prefix.length || prefix.length > 20 || /[\r\n\0]/.test(prefix)) throw new Error('Fleet state prefix is invalid.');
        Object.defineProperty(prefixes, guildId, { value: prefix, enumerable: true, configurable: true, writable: true });
    }
    return { version: 1, pins, owners, prefixes };
}
const copy = value => JSON.parse(JSON.stringify(value));

class FleetState {
    constructor(options = {}) {
        this.filePath = path.resolve(typeof options === 'string' ? options : options.filePath || path.join(__dirname, '..', 'data', 'fleet-state.json'));
        this._snapshot = { version: 1, pins: [], owners: [], prefixes: {} };
        this._tail = Promise.resolve();
        this._writeError = null;
        try { this._snapshot = normalizeState(JSON.parse(fs.readFileSync(this.filePath, 'utf8'))); }
        catch (error) {
            if (error.code === 'ENOENT') return;
            throw new Error('Fleet state is corrupt or invalid. Preserve the file before repairing it.');
        }
    }
    getPins() { return copy(this._snapshot.pins); }
    listOwners() { return [...this._snapshot.owners]; }
    getPrefixes() { return { ...this._snapshot.prefixes }; }

    _change(update) {
        const operation = this._tail.then(async () => {
            const next = copy(this._snapshot);
            const result = update(next);
            const normalized = normalizeState(next);
            const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
            let handle;
            try {
                await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
                handle = await fsp.open(temporary, 'wx', 0o600);
                await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
                await handle.sync();
                await handle.close(); handle = null;
                await fsp.rename(temporary, this.filePath);
                this._snapshot = normalized;
                this._writeError = null;
                return result;
            } catch (error) {
                await handle?.close().catch(() => {});
                await fsp.unlink(temporary).catch(() => {});
                this._writeError = error;
                throw error;
            }
        });
        this._tail = operation.catch(() => {});
        return operation;
    }
    setPin(value) {
        const pin = normalizePin(value);
        return this._change(snapshot => {
            const occupied = snapshot.pins.find(item => item.guildId === pin.guildId && item.voiceChannelId === pin.voiceChannelId && item.botKey !== pin.botKey);
            if (occupied) throw new Error('Voice room is already assigned to another fleet bot.');
            const index = snapshot.pins.findIndex(item => item.botKey === pin.botKey && item.guildId === pin.guildId);
            if (index === -1) snapshot.pins.push(pin); else snapshot.pins[index] = pin;
            return { ...pin };
        });
    }
    removePin(key, guildId) {
        return this._change(snapshot => {
            const before = snapshot.pins.length;
            snapshot.pins = snapshot.pins.filter(pin => pin.botKey !== String(key) || pin.guildId !== String(guildId));
            return before !== snapshot.pins.length;
        });
    }
    addOwner(id) {
        const owner = nonempty(String(id ?? ''), 'owner ID');
        return this._change(snapshot => { if (!snapshot.owners.includes(owner)) snapshot.owners.push(owner); return owner; });
    }
    removeOwner(id) {
        return this._change(snapshot => { const before = snapshot.owners.length; snapshot.owners = snapshot.owners.filter(owner => owner !== String(id)); return before !== snapshot.owners.length; });
    }
    setPrefix(guildId, prefix) {
        const id = nonempty(String(guildId ?? ''), 'guild ID');
        return this._change(snapshot => {
            if (prefix == null) delete snapshot.prefixes[id];
            else Object.defineProperty(snapshot.prefixes, id, { value: prefix, enumerable: true, configurable: true, writable: true });
            return prefix;
        });
    }
    async flush() { await this._tail; if (this._writeError) throw this._writeError; }
}

module.exports = { FleetState };
