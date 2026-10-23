'use strict';

const { FleetState } = require('./fleetState');

function milliseconds(config, field, fallback) {
    const value = config[field] == null ? fallback : Number(config[field]);
    if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647) throw new Error(`${field} must be a non-negative duration in milliseconds.`);
    return Math.floor(value);
}
function identifier(value, field) {
    const text = String(value ?? '').trim();
    if (!text || text.length > 150 || /[\r\n\0]/.test(text)) throw new Error(`A valid ${field} is required.`);
    return text;
}
function snapshotQueue(queue) {
    if (!queue) return null;
    const snapshot = { tracks: Array.isArray(queue.tracks) ? queue.tracks.map(track => ({ ...track })) : [] };
    for (const field of ['currentIndex', 'volume', 'loop', 'loopQueue', 'shuffle', 'paused', 'playing']) snapshot[field] = queue[field];
    try { snapshot.seek = Number(queue.getElapsedPrecise?.() ?? queue.getElapsed?.() ?? queue.seekPosition ?? 0) || 0; }
    catch (_) { snapshot.seek = Number(queue.seekPosition || 0); }
    return snapshot;
}
function transientLoginError(error) {
    const signals = [];
    const seen = new Set();
    for (let current = error; current && signals.length < 6 && !seen.has(current); current = current.cause) {
        seen.add(current);
        signals.push({ code: String(current.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
            status: Number(current.status ?? current.statusCode ?? current.httpStatus ?? 0), message: String(current.message || '') });
    }
    if (signals.some(({ code, status, message }) =>
        ['4004', '4010', '4011', '4012', '4013', '4014', 'TOKENINVALID', 'INVALIDTOKEN', 'AUTHENTICATIONFAILED', 'DISALLOWEDINTENTS'].includes(code)
        || [401, 403].includes(status)
        || /invalid (?:bot )?(?:token|login)|token.{0,30}invalid|authentication failed|unauthori[sz]ed|disallowed.{0,30}intent|privileged.{0,30}intent/i.test(message))) return false;
    return signals.some(({ code, status, message }) =>
        ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAIAGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
        'UNDERRSOCKET', 'UNDERRCONNECTTIMEOUT', 'UNDERRHEADERSTIMEOUT', '1006', '4000', '4007', '4008', '4009'].includes(code)
        || status === 429 || (status >= 500 && status <= 599)
        || /timed?\s*out|timeout|socket|network|connection (?:reset|refused|closed)|DNS|temporar|service unavailable|rate.?limit|(?:HTTP|server response:)\s*(?:429|5\d\d)/i.test(message));
}

class FleetManager {
    constructor({ definitions, createClient, createPlayer, state, rootOwnerIds = [], config = {}, logger = console } = {}) {
        if (!Array.isArray(definitions) || !definitions.length) throw new Error('At least one fleet bot definition is required.');
        if (typeof createClient !== 'function' || typeof createPlayer !== 'function') throw new Error('Fleet client and player factories are required.');
        this.config = config;
        this.logger = logger;
        this.state = state || new FleetState();
        this.records = new Map();
        this.definitions = definitions.map((definition, index) => ({ ...definition, key: identifier(definition.key, 'bot key'), main: index === 0 }));
        if (new Set(this.definitions.map(definition => definition.key)).size !== this.definitions.length) throw new Error('Duplicate fleet bot key.');
        this._createClient = createClient;
        this._createPlayer = createPlayer;
        this._rootOwnerIds = new Set((Array.isArray(rootOwnerIds) ? rootOwnerIds : [rootOwnerIds]).filter(id => id != null && String(id).trim()).map(id => String(id).trim()));
        this.prefixes = new Map(Object.entries(this.state.getPrefixes()));
        this._botLocks = new Map();
        this._guildLocks = new Map();
        this._retries = new Map();
        this._loginRetries = new Map();
        this._roomReservations = new Map();
        this._distributionLocks = new Map();
        this._distributionReservations = new Set();
        this._waiters = new Map();
        this._loginActive = 0;
        this._loginQueue = [];
        this._loginTail = Promise.resolve();
        this._joinTail = Promise.resolve();
        this._nextLoginAt = 0;
        this._nextJoinAt = 0;
        this._closed = false;
        this._startPromise = null;
        this._closePromise = null;
        this._loginDelay = milliseconds(config, 'FLEET_LOGIN_DELAY_MS', 750);
        this._loginConcurrency = Number(config.FLEET_LOGIN_CONCURRENCY ?? 4);
        if (!Number.isSafeInteger(this._loginConcurrency) || this._loginConcurrency < 1) throw new Error('FLEET_LOGIN_CONCURRENCY must be a positive integer.');
        this._joinDelay = milliseconds(config, 'FLEET_JOIN_DELAY_MS', 250);
        this._retryBase = Math.max(1, milliseconds(config, 'FLEET_RESTORE_RETRY_BASE_MS', 2000));
        this._retryMax = Math.max(this._retryBase, milliseconds(config, 'FLEET_RESTORE_RETRY_MAX_MS', 60000));
        this._loginRetryBase = Math.max(1, milliseconds(config, 'FLEET_LOGIN_RETRY_BASE_MS', this._retryBase));
        this._loginRetryMax = Math.max(this._loginRetryBase, milliseconds(config, 'FLEET_LOGIN_RETRY_MAX_MS', this._retryMax));
        this._shutdownTimeout = Math.max(1, milliseconds(config, 'FLEET_SHUTDOWN_TIMEOUT_MS', 10000));
        for (const definition of this.definitions) {
            const record = { key: definition.key, definition, client: null, player: null, status: 'created', lastError: null, snapshots: new Map(), pinErrors: new Map() };
            this.records.set(record.key, record);
            try { this._buildRecord(record); }
            catch (error) { this._failure(record, error, 'failed'); }
        }
    }

    _sanitize(error) {
        let message = String(error?.message || error || 'Unknown fleet error');
        for (const definition of this.definitions) {
            if (definition.token) message = message.split(String(definition.token)).join('[redacted]');
        }
        return message.replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{15,}/g, '[redacted]').slice(0, 500);
    }
    safeError(error) { return this._sanitize(error); }
    get rootOwnerIds() { return [...this._rootOwnerIds]; }
    _failure(record, error, status = record.status) {
        record.status = status;
        record.lastError = this._sanitize(error);
        this.logger?.warn?.(`[Fleet] ${record.key}: ${record.lastError}`);
    }
    _buildRecord(record) {
        const client = this._createClient(record.definition);
        if (!client || typeof client.login !== 'function') throw new Error('Fleet client factory did not return a Discord client.');
        record.client = client;
        client.fleet = this;
        client.botKey = record.key;
        client.prefixes = this.prefixes;
        const player = this._createPlayer(record.definition, client);
        if (!player || typeof player.join !== 'function') throw new Error('Fleet player factory did not return a music player.');
        record.player = player;
        client.player = player;
        client.queues = player.queues;
        player.client = client;
        player.fleet = this;
        const onError = error => { if (record.client === client && !this._closed) this._failure(record, error); };
        client.on?.('error', onError);
        record.errorListener = onError;
        record.status = 'created';
    }
    _assertOpen() { if (this._closed) throw new Error('Fleet manager is closed.'); }
    _requireRecord(key) { const record = this.recordFor(key); if (!record) throw new Error('Unknown fleet bot.'); return record; }
    _ready(record) {
        if (!record?.client || this._closed || ['failed', 'closed', 'restarting'].includes(record.status)) return false;
        return typeof record.client.isReady === 'function' ? record.client.isReady() : record.status === 'ready';
    }
    _lock(locks, key, task) {
        const operation = (locks.get(key) || Promise.resolve()).catch(() => {}).then(task);
        const tail = operation.catch(() => {});
        locks.set(key, tail);
        tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
        return operation;
    }
    _withBot(record, task) { return this._lock(this._botLocks, record.key, task); }
    _withGuild(guildId, task) { return this._lock(this._guildLocks, guildId, task); }
    _wait(duration) {
        if (!duration || this._closed) return Promise.resolve();
        return new Promise(resolve => {
            const timer = setTimeout(() => { this._waiters.delete(timer); resolve(); }, duration);
            this._waiters.set(timer, resolve);
        });
    }
    _pace(kind, task) {
        const tailField = kind === 'login' ? '_loginTail' : '_joinTail';
        const atField = kind === 'login' ? '_nextLoginAt' : '_nextJoinAt';
        const delay = kind === 'login' ? this._loginDelay : this._joinDelay;
        // The lane serializes start times only. Adopting task() here would make
        // every later account wait for an earlier network/voice operation.
        return new Promise((resolve, reject) => {
            const start = this[tailField].catch(() => {}).then(async () => {
                await this._wait(Math.max(0, this[atField] - Date.now()));
                this._assertOpen();
                this[atField] = Date.now() + delay;
                Promise.resolve().then(() => { this._assertOpen(); return task(); }).then(resolve, reject);
            });
            this[tailField] = start.catch(reject);
        });
    }
    _acquireLoginSlot() {
        return new Promise((resolve, reject) => {
            const grant = () => {
                if (this._closed) { reject(new Error('Fleet manager is closed.')); return; }
                this._loginActive++;
                let released = false;
                resolve(() => {
                    if (released) return;
                    released = true;
                    this._loginActive--;
                    this._loginQueue.shift()?.grant();
                });
            };
            if (this._closed) reject(new Error('Fleet manager is closed.'));
            else if (this._loginActive < this._loginConcurrency) grant();
            else this._loginQueue.push({ grant, reject });
        });
    }
    async _runLogin(task) {
        const release = await this._acquireLoginSlot();
        try { return await this._pace('login', task); }
        finally { release(); }
    }
    _pin(key, guildId) { return this.state.getPins().find(pin => pin.botKey === key && pin.guildId === guildId) || null; }
    _refreshPrefixes() {
        this.prefixes.clear();
        for (const [guildId, prefix] of Object.entries(this.state.getPrefixes())) this.prefixes.set(guildId, prefix);
    }

    recordFor(value) {
        const input = String(value ?? '').trim();
        const key = /^<@!?(\d+)>$/.exec(input)?.[1] || input;
        return this.records.get(key) || [...this.records.values()].find(record => record.client?.user?.id === key) || null;
    }
    recordForClient(client) { return client ? [...this.records.values()].find(record => record.client === client) || null : null; }
    controlClient() {
        const primary = this.records.get(this.definitions[0].key);
        return (this._ready(primary) ? primary : [...this.records.values()].find(record => this._ready(record)))?.client || null;
    }
    isRootOwner(id) { return this._rootOwnerIds.has(String(id ?? '')); }
    isOwner(id) { return this.isRootOwner(id) || this.state.listOwners().includes(String(id ?? '')); }

    start() {
        this._assertOpen();
        if (this._startPromise) return this._startPromise;
        this._startPromise = (async () => {
            await Promise.all([...this.records.values()].map(record =>
                this._withBot(record, async () => {
                    if (this._closed) return;
                    if (!record.client || !record.player) {
                        await this._teardownRecord(record);
                        if (this._closed) return;
                        try { this._buildRecord(record); }
                        catch (error) { this._failure(record, error, 'failed'); return; }
                    }
                    await this._loginRecord(record);
                })));
            return this.status();
        })();
        return this._startPromise;
    }
    async _loginRecord(record) {
        const client = record.client;
        record.status = 'connecting';
        try {
            await this._runLogin(() => client.login(record.definition.token));
            if (record.client !== client || this._closed) {
                try { await this._bounded(client.destroy(), 'late client close'); } catch (_) {}
                return false;
            }
            this._clearLoginRetry(record.key);
            // clientReady normally calls onReady. Checking readiness here also
            // supports factories whose login promise resolves after that event.
            if (typeof client.isReady !== 'function' || client.isReady()) await this._readyRecord(record);
            return true;
        } catch (error) {
            if (!this._closed && record.client === client) {
                if (transientLoginError(error)) {
                    this._failure(record, error, 'retrying');
                    this._scheduleLoginRetry(record);
                } else {
                    this._clearLoginRetry(record.key);
                    this._failure(record, error, 'failed');
                }
            }
            return false;
        }
    }
    _clearLoginRetry(key) {
        const entry = this._loginRetries.get(key);
        if (entry?.timer) clearTimeout(entry.timer);
        this._loginRetries.delete(key);
    }
    _scheduleLoginRetry(record) {
        if (this._closed) return;
        const previous = this._loginRetries.get(record.key);
        if (previous?.timer) return;
        const attempts = Math.min(30, Number(previous?.attempts || 0) + 1);
        const delay = Math.min(this._loginRetryMax, this._loginRetryBase * (2 ** (attempts - 1)));
        const jittered = Math.min(this._loginRetryMax, Math.max(1, Math.floor(delay * (0.8 + Math.random() * 0.4))));
        const client = record.client;
        const entry = { attempts, timer: null };
        entry.timer = setTimeout(() => {
            entry.timer = null;
            if (this._closed || this._loginRetries.get(record.key) !== entry) return;
            void this._withBot(record, async () => {
                if (this._closed || this._loginRetries.get(record.key) !== entry || record.client !== client) return;
                if (this._ready(record)) await this._readyRecord(record);
                else await this._loginRecord(record);
            }).catch(error => {
                if (!this._closed) { this._failure(record, error, 'retrying'); this._scheduleLoginRetry(record); }
            });
        }, jittered);
        this._loginRetries.set(record.key, entry);
    }
    onReady(client) {
        const record = this.recordForClient(client);
        if (!record || this._closed) return Promise.resolve(false);
        return this._withBot(record, async () => {
            if (record.client !== client || this._closed) return false;
            await this._readyRecord(record);
            return true;
        });
    }
    async _readyRecord(record) {
        this._assertOpen();
        this._clearLoginRetry(record.key);
        record.status = 'ready'; record.lastError = null;
        this._refreshPrefixes();
        for (const pin of this.state.getPins().filter(item => item.botKey === record.key)) {
            await this._restorePin(record, pin.guildId);
        }
    }

    async _channels(record, guildId, voiceId, textId, { optionalText = false } = {}) {
        const client = record.client;
        let guild = client.guilds?.cache?.get(guildId);
        if (!guild && typeof client.guilds?.fetch === 'function') guild = await client.guilds.fetch(guildId);
        if (!guild) throw new Error('The selected bot cannot access that server.');
        const find = async channelId => {
            let channel = guild.channels?.cache?.get(channelId);
            if (!channel && typeof guild.channels?.fetch === 'function') channel = await guild.channels.fetch(channelId);
            if (!channel && typeof client.channels?.fetch === 'function') channel = await client.channels.fetch(channelId);
            if (!channel || channel.guild?.id !== guildId || (channel.client && channel.client !== client)) return null;
            return channel;
        };
        const voice = await find(voiceId);
        if (!voice || (typeof voice.isVoiceBased === 'function' && !voice.isVoiceBased())) throw new Error('The assigned voice channel is unavailable.');
        let text = null;
        try { text = textId ? await find(textId) : null; }
        catch (error) { if (!optionalText) throw error; }
        if (textId && !text && !optionalText) throw new Error('The assigned text channel is unavailable.');
        if (!text && optionalText) text = voice.isTextBased?.() || typeof voice.send === 'function' ? voice : guild.systemChannel || null;
        return { voice, text };
    }
    _prepareJoin(queue, voiceId) {
        if (!queue) return;
        if (queue._rejoinTimer) clearTimeout(queue._rejoinTimer);
        if (queue.leaveTimer) clearTimeout(queue.leaveTimer);
        queue._rejoinTimer = null; queue.leaveTimer = null;
        queue.lockedVoiceChannelId = voiceId;
        queue._intentionalDestroy = false;
    }
    async _join(record, pin) {
        const channels = await this._channels(record, pin.guildId, pin.voiceChannelId, pin.textChannelId, { optionalText: true });
        this._assertOpen();
        this._prepareJoin(record.player.getQueue?.(pin.guildId), pin.voiceChannelId);
        const queue = await this._pace('join', () => record.player.join(channels.voice, channels.text));
        if (!queue) throw new Error('The selected bot did not create a voice queue.');
        if (this._closed) {
            queue._intentionalDestroy = true;
            try { queue.connection?.destroy?.(); } catch (_) {}
            try { queue.player?.stop?.(true); } catch (_) {}
            try { record.player._cleanupResource?.(queue); } catch (_) {}
            throw new Error('Fleet manager is closed.');
        }
        this._prepareJoin(queue, pin.voiceChannelId);
        return queue;
    }
    _applySnapshot(queue, snapshot) {
        if (!snapshot) return;
        queue.tracks = snapshot.tracks.map(track => ({ ...track }));
        for (const field of ['currentIndex', 'volume', 'loop', 'loopQueue', 'shuffle', 'paused', 'playing']) {
            if (snapshot[field] !== undefined) queue[field] = snapshot[field];
        }
        queue.seekPosition = snapshot.seek;
    }
    async _resume(record, queue, snapshot) {
        if (!snapshot) return;
        this._applySnapshot(queue, snapshot);
        const track = queue.tracks[Number(queue.currentIndex || 0)];
        if (track && (snapshot.playing || snapshot.paused) && typeof record.player.play === 'function') {
            const resumed = await record.player.play(queue, track, snapshot.seek);
            if (resumed === false) throw new Error(this._sanitize(queue._lastPlayError || record.player.lastPlayError || 'The saved track could not resume.'));
            if (snapshot.paused) { queue.player?.pause?.(); queue.paused = true; }
        }
    }

    place(key, guildId, voiceId, textId = null, { requireUnassigned = false } = {}) {
        const record = this._requireRecord(key);
        const guild = identifier(guildId, 'guild ID');
        const voice = identifier(voiceId, 'voice channel ID');
        return this._withBot(record, async () => {
            this._assertOpen();
            if (!this._ready(record)) throw new Error('The selected fleet bot is not ready.');
            const previous = this._pin(record.key, guild);
            if (requireUnassigned && previous) throw new Error('The selected bot was assigned while distribution was pending.');
            const pin = { botKey: record.key, guildId: guild, voiceChannelId: voice, textChannelId: textId == null ? previous?.textChannelId || null : identifier(textId, 'text channel ID') };
            // Check permissions/access before changing durable desired placement.
            await this._channels(record, guild, pin.voiceChannelId, pin.textChannelId);
            this._assertOpen();
            const oldQueue = record.player.getQueue?.(guild);
            const snapshot = snapshotQueue(oldQueue);
            const oldVoice = oldQueue?.voiceChannel?.id || previous?.voiceChannelId;
            let rollbackRoom = null;
            // Hold the guild lock only for reservation/state changes. Distinct
            // accounts may wait for Discord voice readiness concurrently.
            await this._withGuild(guild, async () => {
                this._assertOpen();
                const occupied = this.state.getPins().find(item => item.guildId === guild && item.voiceChannelId === voice && item.botKey !== record.key);
                const reserved = this._roomReservations.get(this._roomKey(guild, voice));
                if (occupied || (reserved && reserved !== record.key)) throw new Error('Voice room is already assigned or reserved by another fleet bot.');
                if (previous && previous.voiceChannelId !== voice) {
                    rollbackRoom = this._roomKey(guild, previous.voiceChannelId);
                    this._roomReservations.set(rollbackRoom, record.key);
                }
                try { await this.state.setPin(pin); }
                catch (error) { if (rollbackRoom) this._roomReservations.delete(rollbackRoom); throw error; }
                this._clearRetry(record.key, guild);
            });
            try {
                const queue = await this._join(record, pin);
                record.lastError = null;
                return queue;
            } catch (error) {
                if (this._closed) throw new Error(this._sanitize(error));
                // Restore desired state first. Reconnect callbacks then see the
                // old valid room, rather than an abandoned new placement.
                await this._withGuild(guild, () => previous ? this.state.setPin(previous) : this.state.removePin(record.key, guild));
                if (previous && !this._closed) {
                    const queue = record.player.getQueue?.(guild) || oldQueue;
                    this._prepareJoin(queue, oldVoice || previous.voiceChannelId);
                    this._applySnapshot(queue, snapshot);
                    try {
                        const restored = await this._join(record, previous);
                        this._applySnapshot(restored, snapshot);
                        if (snapshot?.playing && !restored.resource) await this._resume(record, restored, snapshot);
                    } catch (rollbackError) {
                        if (snapshot) record.snapshots.set(guild, snapshot);
                        this._failure(record, rollbackError);
                        this._scheduleRetry(record, guild);
                    }
                } else if (!previous) {
                    const queue = record.player.getQueue?.(guild);
                    if (queue) queue._intentionalDestroy = true;
                    await record.player.deleteQueue?.(guild);
                }
                throw new Error(this._sanitize(error));
            } finally {
                if (rollbackRoom && this._roomReservations.get(rollbackRoom) === record.key) this._roomReservations.delete(rollbackRoom);
            }
        });
    }
    release(key, guildId) {
        const record = this._requireRecord(key);
        const guild = identifier(guildId, 'guild ID');
        return this._withBot(record, async () => {
            this._assertOpen();
            await this._withGuild(guild, () => this.state.removePin(record.key, guild));
            this._clearRetry(record.key, guild);
            record.snapshots.delete(guild);
            record.pinErrors.delete(guild);
            const queue = record.player?.getQueue?.(guild);
            if (queue) {
                queue._intentionalDestroy = true;
                if (queue._rejoinTimer) clearTimeout(queue._rejoinTimer);
                queue._rejoinTimer = null;
            }
            await record.player?.deleteQueue?.(guild);
            return true;
        });
    }

    _roomKey(guildId, voiceId) { return `${guildId}\0${voiceId}`; }
    _retryKey(key, guildId) { return `${key}\0${guildId}`; }
    _clearRetry(key, guildId) {
        const retryKey = this._retryKey(key, guildId);
        const entry = this._retries.get(retryKey);
        if (entry?.timer) clearTimeout(entry.timer);
        this._retries.delete(retryKey);
    }
    _scheduleRetry(record, guildId) {
        if (this._closed || !this._pin(record.key, guildId)) return;
        const key = this._retryKey(record.key, guildId);
        const previous = this._retries.get(key);
        if (previous?.timer) return;
        const attempts = Math.min(30, Number(previous?.attempts || 0) + 1);
        const delay = Math.min(this._retryMax, this._retryBase * (2 ** (attempts - 1)));
        const jittered = Math.min(this._retryMax, Math.max(1, Math.floor(delay * (0.8 + Math.random() * 0.4))));
        const entry = { attempts, timer: null };
        entry.timer = setTimeout(() => {
            entry.timer = null;
            if (this._closed || this._retries.get(key) !== entry) return;
            void this._withBot(record, () => this._restorePin(record, guildId)).catch(error => {
                if (!this._closed) { this._failure(record, error); this._scheduleRetry(record, guildId); }
            });
        }, jittered);
        entry.timer.unref?.();
        this._retries.set(key, entry);
    }
    async _restorePin(record, guildId, force = false) {
        if (this._closed) return false;
        const pin = this._pin(record.key, guildId);
        if (!pin) { this._clearRetry(record.key, guildId); return false; }
        if (!this._ready(record)) { this._scheduleRetry(record, guildId); return false; }
        const existing = record.player.getQueue?.(guildId);
        if (!force && existing?.voiceChannel?.id === pin.voiceChannelId && existing.connection?.state?.status === 'ready' && !record.snapshots.has(guildId)) {
            this._clearRetry(record.key, guildId);
            record.pinErrors.delete(guildId);
            record.lastError = [...record.pinErrors.values()].join('; ').slice(0, 500) || null;
            return true;
        }
        try {
            const queue = await this._join(record, pin);
            const snapshot = record.snapshots.get(guildId);
            if (snapshot) { await this._resume(record, queue, snapshot); record.snapshots.delete(guildId); }
            record.pinErrors.delete(guildId);
            record.lastError = [...record.pinErrors.values()].join('; ').slice(0, 500) || null;
            this._clearRetry(record.key, guildId);
            return true;
        } catch (error) {
            record.pinErrors.set(guildId, this._sanitize(error));
            this._failure(record, error);
            this._scheduleRetry(record, guildId);
            return false;
        }
    }

    async distribute(guildId, voiceIds) {
        this._assertOpen();
        const guild = identifier(guildId, 'guild ID');
        if (!Array.isArray(voiceIds)) throw new Error('Voice room IDs must be an array.');
        const rooms = [...new Set(voiceIds.map(id => identifier(id, 'voice channel ID')))];
        const results = [];
        for (const room of rooms) {
            const result = await this._lock(this._distributionLocks, this._roomKey(guild, room), async () => {
                // Claim capacity atomically, then release the guild lane before
                // channel fetching or voice readiness. Other bots join in parallel.
                const allocation = await this._withGuild(guild, () => {
                    this._assertOpen();
                    const assigned = this.resolveForVoice(guild, room);
                    if (assigned) return { result: { key: assigned.key, voiceChannelId: room, status: 'assigned' } };
                    const available = [...this.records.values()].find(record => this._ready(record)
                        && !this._pin(record.key, guild) && !this._distributionReservations.has(this._retryKey(record.key, guild)));
                    if (!available) return { result: { voiceChannelId: room, status: 'unavailable' } };
                    const reservation = this._retryKey(available.key, guild);
                    this._distributionReservations.add(reservation);
                    return { available, reservation };
                });
                if (allocation.result) return allocation.result;
                const { available, reservation } = allocation;
                try {
                    await this.place(available.key, guild, room, null, { requireUnassigned: true });
                    return { key: available.key, voiceChannelId: room, status: 'placed' };
                } catch (error) {
                    return { key: available.key, voiceChannelId: room, status: 'failed', error: this._sanitize(error) };
                } finally { this._distributionReservations.delete(reservation); }
            });
            results.push(result);
        }
        return results;
    }
    repairBot(key) {
        const record = this._requireRecord(key);
        if (!this._ready(record)) return this.restartBot(key);
        return this._withBot(record, async () => {
            this._assertOpen();
            let failed = false;
            for (const pin of this.state.getPins().filter(item => item.botKey === record.key)) {
                const restored = await this._restorePin(record, pin.guildId, true);
                if (!restored) failed = true;
            }
            if (failed) throw new Error(record.lastError || 'An assigned voice room could not be repaired.');
            return record;
        });
    }
    restartBot(key) {
        const record = this._requireRecord(key);
        return this._withBot(record, async () => {
            this._assertOpen();
            this._clearLoginRetry(record.key);
            for (const pin of this.state.getPins().filter(item => item.botKey === record.key)) {
                this._clearRetry(record.key, pin.guildId);
                const snapshot = snapshotQueue(record.player?.getQueue?.(pin.guildId));
                if (snapshot) record.snapshots.set(pin.guildId, snapshot);
            }
            record.status = 'restarting';
            await this._teardownRecord(record);
            this._assertOpen();
            try { this._buildRecord(record); }
            catch (error) { this._failure(record, error, 'failed'); throw new Error(this._sanitize(error)); }
            if (!(await this._loginRecord(record))) throw new Error(record.lastError || 'Fleet bot restart did not complete.');
            if (record.lastError) throw new Error(record.lastError);
            return record;
        });
    }

    resolveForVoice(guildId, voiceId) {
        const pin = this.state.getPins().find(item => item.guildId === String(guildId) && item.voiceChannelId === String(voiceId));
        return pin ? this.records.get(pin.botKey) || null : null;
    }
    resolveSession(session = {}) {
        const guildId = String(session.g || session.guildId || '');
        const userId = String(session.u || session.userId || '');
        if (guildId && userId) {
            for (const record of this.records.values()) {
                const guild = record.client?.guilds?.cache?.get(guildId);
                const voice = guild?.voiceStates?.cache?.get(userId);
                const voiceId = voice?.channelId || voice?.channel?.id;
                if (voiceId) {
                    const assigned = this.resolveForVoice(guildId, voiceId);
                    if (assigned && this._ready(assigned)) return assigned;
                }
            }
        }
        const original = this.recordFor(session.b || session.botKey);
        if (original && this._ready(original)) return original;
        return this.recordForClient(this.controlClient());
    }
    status() {
        const pins = this.state.getPins();
        return [...this.records.values()].map(record => {
            const ready = this._ready(record);
            return { key: record.key, id: record.client?.user?.id || null,
                name: this._sanitize(record.definition.name || record.client?.user?.username || record.key), main: record.definition.main,
                status: record.status === 'ready' && !ready ? 'disconnected' : record.status, ready, lastError: record.lastError,
                pins: pins.filter(pin => pin.botKey === record.key).map(pin => ({ ...pin })) };
        });
    }

    async _bounded(promise, label) {
        let timer;
        try {
            return await Promise.race([Promise.resolve(promise), new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Fleet ${label} exceeded its shutdown deadline.`)), this._shutdownTimeout);
            })]);
        } finally { if (timer) clearTimeout(timer); }
    }
    async _teardownRecord(record) {
        const client = record.client;
        const player = record.player;
        client?.removeListener?.('error', record.errorListener);
        // Stop automatic rejoin before awaiting any user-supplied close hook.
        // A hook that times out cannot leave this account reviving its voice.
        for (const queue of player?.queues?.values?.() || []) {
            queue._intentionalDestroy = true;
            for (const field of ['_rejoinTimer', 'leaveTimer', 'progressTimer']) {
                if (queue[field]) clearTimeout(queue[field]);
                queue[field] = null;
            }
        }
        if (player?._healthTimer) clearInterval(player._healthTimer);
        for (const timer of client?._fleetTimers || []) clearTimeout(timer);
        client?._fleetTimers?.clear?.();
        try {
            if (typeof player?.close === 'function') await this._bounded(player.close(), 'player close');
            else if (player?.queues) {
                for (const queue of player.queues.values()) {
                    queue._intentionalDestroy = true;
                    if (queue._rejoinTimer) clearTimeout(queue._rejoinTimer);
                    if (queue.leaveTimer) clearTimeout(queue.leaveTimer);
                    try { queue.connection?.destroy?.(); } catch (_) {}
                }
                player.queues.clear();
                if (player._healthTimer) clearInterval(player._healthTimer);
            }
        } catch (error) {
            this._failure(record, error);
            for (const queue of player?.queues?.values?.() || []) {
                try { queue.connection?.destroy?.(); } catch (_) {}
                try { queue.player?.stop?.(true); } catch (_) {}
                try { player._cleanupResource?.(queue); } catch (_) {}
            }
            player?.queues?.clear?.();
        }
        try { if (client) await this._bounded(client.destroy(), 'client close'); }
        catch (error) { this._failure(record, error); }
    }
    close() {
        if (this._closePromise) return this._closePromise;
        this._closed = true;
        for (const entry of this._retries.values()) if (entry.timer) clearTimeout(entry.timer);
        this._retries.clear();
        for (const entry of this._loginRetries.values()) if (entry.timer) clearTimeout(entry.timer);
        this._loginRetries.clear();
        for (const entry of this._loginQueue.splice(0)) entry.reject(new Error('Fleet manager is closed.'));
        this._roomReservations.clear();
        this._distributionReservations.clear();
        for (const [timer, resolve] of this._waiters) { clearTimeout(timer); resolve(); }
        this._waiters.clear();
        this._closePromise = (async () => {
            try { await this._bounded(Promise.allSettled([...this._botLocks.values(), ...this._guildLocks.values(), this._loginTail, this._joinTail]), 'pending operations'); }
            catch (error) { this.logger?.warn?.(`[Fleet] ${this._sanitize(error)}`); }
            await Promise.all([...this.records.values()].map(async record => { await this._teardownRecord(record); record.status = 'closed'; }));
            await this._bounded(this.state.flush(), 'state flush');
        })();
        return this._closePromise;
    }
}

module.exports = { FleetManager };
