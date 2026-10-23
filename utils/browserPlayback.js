'use strict';
const crypto = require('node:crypto');
class BrowserPlayback {
    constructor({ service = require('./platformService'), now = Date.now, maxSessions = 1024, retryBaseMs = 250, retryMaxMs = 5000, closeAttempts = 3 } = {}) {
        this.service = service; this.now = now; this.maxSessions = maxSessions;
        this.retryBaseMs = Math.max(10, Number(retryBaseMs) || 250);
        this.retryMaxMs = Math.max(this.retryBaseMs, Number(retryMaxMs) || 5000);
        this.closeAttempts = Math.max(1, Math.min(5, Number(closeAttempts) || 3));
        this.sessions = new Map(); this.pending = new Set(); this.closing = false;
    }
    async _persist(item) {
        try {
            if (!item.established) {
                await this.service.recordPlay(item.user, item.track, { eventId: item.eventId, guildId: item.guild,
                    playedAt: item.startedAt, listenedSeconds: 0, playbackSource: 'browser' });
                item.established = true;
            }
            while (item.savedRevision < item.revision) {
                const revision = item.revision, snapshot = { ...item.latest };
                await this.service.updatePlay(item.user, item.eventId, snapshot);
                item.savedRevision = revision;
            }
            item.lastError = null; item.retryCount = 0;
        } catch (error) {
            item.lastError = error;
            if (error.code === 'PLAY_EVENT_NOT_FOUND') item.established = false;
            this._schedule(item);
            throw error;
        }
    }
    _schedule(item) {
        if (this.closing || item.retryTimer) return;
        const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(8, item.retryCount++));
        item.retryTimer = setTimeout(() => {
            item.retryTimer = null;
            this._queue(item, () => this._persist(item)).catch(() => {});
        }, delay);
        item.retryTimer.unref?.();
    }
    _queue(item, work) {
        const pending = item.chain.catch(() => {}).then(work);
        item.chain = pending; this.pending.add(pending);
        pending.finally(() => this.pending.delete(pending)).catch(() => {});
        return pending;
    }
    async event(session, job, body) {
        if (this.closing) throw new Error('Browser playback tracking stopped.');
        if (job.kind !== 'audio' || !job.track) throw new Error('Browser audio is unavailable.');
        const playbackId = String(body.playbackId || ''), event = String(body.event || '');
        if (!/^[a-z\d_-]{8,80}$/i.test(playbackId) || !['play', 'tick', 'pause', 'ended'].includes(event)) throw new Error('Invalid browser playback event.');
        const reported = Number(body.listenedSeconds);
        if (!Number.isFinite(reported) || reported < 0) throw new Error('Invalid consumed audio time.');
        const key = `${session.u}:${session.g}:${playbackId}`, now = this.now();
        for (const [id, entry] of this.sessions) {
            if (entry.expires <= now && entry.savedRevision === entry.revision && !entry.retryTimer) this.sessions.delete(id);
        }
        let item = this.sessions.get(key);
        if (!item) {
            if (event !== 'play') throw new Error('Start a browser play before sending progress.');
            if (this.sessions.size >= this.maxSessions) throw new Error('Too many browser playback sessions.');
            item = { jobId: job.id, user: session.u, guild: session.g, track: job.track, eventId: crypto.randomUUID(),
                startedAt: new Date(now).toISOString(), lastAt: now, wallMs: 0, seconds: 0, playing: false,
                ended: false, established: false, expires: Math.min(job.expires, Number(session.e) || Infinity),
                revision: 0, savedRevision: 0, latest: {}, retryCount: 0, retryTimer: null, lastError: null, chain: Promise.resolve() };
            this.sessions.set(key, item);
        }
        if (item.jobId !== job.id) throw new Error('The browser play source changed.');
        return this._queue(item, async () => {
            const current = this.now();
            if (item.playing && !item.ended) item.wallMs += Math.max(0, current - item.lastAt);
            item.lastAt = current;
            item.seconds = Math.max(item.seconds, Math.min(reported, item.wallMs / 1000 + .25));
            // An audible state cannot depend on whether its disk acknowledgement
            // succeeds. Retain an absolute checkpoint and one stable event UUID.
            if (event === 'play' && !item.ended) item.playing = true;
            if (event === 'pause') item.playing = false;
            if (event === 'ended') { item.playing = false; item.ended = true; }
            item.latest = { listenedSeconds: item.seconds, ...(item.ended ? { endedAt: new Date(current).toISOString(), completed: true } : {}) };
            item.revision++;
            await this._persist(item);
            return { ok: true, eventId: item.eventId, listenedSeconds: item.seconds };
        });
    }
    async close() {
        this.closing = true;
        for (const item of this.sessions.values()) { clearTimeout(item.retryTimer); item.retryTimer = null; }
        while (this.pending.size) await Promise.allSettled([...this.pending]);
        const failures = [];
        for (const item of this.sessions.values()) {
            if (!item.ended) {
                item.playing = false; item.ended = true;
                item.latest = { listenedSeconds: item.seconds, endedAt: new Date(this.now()).toISOString(), completed: false };
                item.revision++;
            }
            for (let attempt = 0; attempt < this.closeAttempts; attempt++) {
                try { await this._persist(item); break; } catch (_) {}
            }
            if (item.lastError) failures.push(item.lastError);
        }
        if (failures.length) throw new AggregateError(failures, `Could not save ${failures.length} browser listening event(s).`);
        this.sessions.clear();
    }
}
module.exports={BrowserPlayback};
