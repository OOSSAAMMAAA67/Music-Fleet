'use strict';

const config = require('../config');
const lyricsProvider = require('./lyricsProvider');
const { currentClient } = require('./playerContext');

const sessions = new Map();
// One edit lane per guild/channel/user. An old session can never race a replacement.
const activeKeys = new Set();
// REST promises may outlive a cancelled session. Keep their ownership separately
// from the diagnostics of live sessions, until the owning tick really finishes.
const editLanes = new Map();
const MAX_AUTO_SESSIONS = Math.max(64, Number(config.LYRICS_AUTO_MAX_SESSIONS || 512));

function makeKey(guildId, channelId, userId) {
    const botKey = currentClient()?.botKey;
    return `${botKey ? `${botKey}:` : ''}${guildId || 'dm'}:${channelId || 'channel'}:${userId || 'user'}`;
}

function trackIdentity(track) {
    if (!track) return '';
    return `${track.url || ''}|${track.title || ''}|${track.author || ''}|${Math.round(Number(track.duration || 0))}`;
}

function playbackGeneration(queue) {
    return `${Number(queue?._playToken || 0)}:${Number(queue?._playRequestToken || 0)}`;
}

function stopByKey(key) {
    const old = sessions.get(key);
    if (!old) { activeKeys.delete(key); return false; }
    old.cancelled = true;
    clearInterval(old.interval);
    clearTimeout(old.timeout);
    sessions.delete(key);
    activeKeys.delete(key);
    // Discord cannot cancel an edit already sent to REST. Keep its lane locked
    // until that promise settles, otherwise a replacement session can edit the
    // same message concurrently and the old response may overwrite the new one.
    // The owning tick releases the lock in finally, including cancelled sessions.
    return true;
}

function stop({ guildId, channelId, userId }) {
    return stopByKey(makeKey(guildId, channelId, userId));
}

async function resolveCurrentLyrics(track, forceRefresh = false) {
    const language = lyricsProvider.guessLyricsLanguage?.(track?.title, track?.author) || undefined;
    return lyricsProvider.findLyrics(track, { language, forceRefresh });
}

function retryDelayForMisses(misses = 1) {
    const base = Math.max(250, Number(config.LYRICS_AUTO_RESOLVE_RETRY_MS || 12_000));
    const n = Math.max(1, Number(misses || 1));
    if (n <= 2) return base;
    if (n <= 5) return Math.max(base, Math.min(30_000, base * 2));
    return Math.max(base, Math.min(60_000, base * 4));
}

function hasReliableSync(lyrics) {
    return Boolean(lyrics?.syncedLines?.length) && !lyrics?.approximateSync && !lyrics?.estimatedSync && !lyrics?.needsUpgrade;
}

function retryDelayForEditFailures(failures = 1) {
    const n = Math.max(1, Number(failures || 1));
    return Math.min(30_000, 600 * (2 ** Math.min(6, n - 1)));
}

function start({ guildId, channelId, userId, player, track, lyrics, render, edit }) {
    if (!guildId || !player || !track || typeof render !== 'function' || typeof edit !== 'function') return false;
    const key = makeKey(guildId, channelId, userId);
    stopByKey(key);

    const intervalMs = Math.max(100, Number(config.LYRICS_AUTO_UPDATE_MS || 250));
    const minEditGapMs = Math.max(100, Number(config.LYRICS_DISCORD_MIN_EDIT_GAP_MS || 180));
    // Keep auto-follow alive across queue transitions. The hard cap only protects abandoned UI sessions.
    const durationMs = Math.max(20 * 60_000, Number(config.LYRICS_AUTO_SESSION_MAX_MS || 6 * 60 * 60_000));
    let busy = false;
    let failures = 0;
    let session = null;

    const adaptiveLeadMs = () => {
        // The resource clock is ahead of what the listener physically hears by the
        // Discord voice presentation/buffer latency. REST editing adds latency in the
        // opposite direction. Compensate the *difference* instead of always advancing
        // lyrics by the entire REST time (which made many tracks visibly early).
        const baseline = Number(config.DISCORD_LYRICS_SYNC_OFFSET_MS || 0);
        const presentation = Math.max(0, Number(config.LYRICS_AUDIO_PRESENTATION_LATENCY_MS || 250));
        const rest = Math.max(0, Number(session?.editLatencyMs || 220)) + Math.round(intervalMs / 2);
        const maxLead = Math.max(0, Math.min(350, Number(config.LYRICS_DISCORD_MAX_LATENCY_LEAD_MS ?? 200)));
        // A slow or rate-limited REST response is not evidence that the next edit
        // has the same delay. Bound prediction so an outage cannot skip vocals.
        return baseline + Math.max(-presentation, Math.min(maxLead, rest - presentation));
    };
    const timedEdit = async payload => {
        const startedAt = Date.now();
        await edit(payload);
        if (!session || session.cancelled) return;
        const sample = Math.max(0, Math.min(2000, Date.now() - startedAt));
        const previous = Math.max(0, Number(session.editLatencyMs || sample));
        // EWMA keeps the lead stable while still adapting to a slower Discord REST path.
        session.editLatencyMs = previous * 0.72 + sample * 0.28;
        session.nextEditAt = 0;
        session.lastEditAt = Date.now();
    };

    const scheduleUpgrade = (current, currentKey) => {
        if (!session || session.cancelled || session.resolvePromise) return;
        if (Date.now() < Number(session.nextResolveAt || 0)) return;
        const resolveGeneration = ++session.resolveGeneration;
        session.resolvePromise = resolveCurrentLyrics(current, true)
            .then(refreshed => {
                if (!session || session.cancelled || sessions.get(key) !== session || resolveGeneration !== session.resolveGeneration) return;
                if (trackIdentity(player.getQueue(guildId)?.currentTrack) !== currentKey) return;
                if (refreshed?.plainLyrics || refreshed?.syncedLines?.length || session.lyrics?.pending) {
                    // A completed miss ends loading for a new track. An empty
                    // upgrade must still retain any useful current-track fallback.
                    session.lyrics = { plainLyrics: '', syncedLines: [], hasSynced: false, ...refreshed, pending: false };
                    session.lastActiveIndex = -2;
                    session.pendingPlainRefresh = !refreshed?.syncedLines?.length;
                }
                if (hasReliableSync(refreshed)) {
                    session.resolveMisses = 0; session.nextResolveAt = 0;
                } else {
                    session.resolveMisses = Math.min(20, Number(session.resolveMisses || 0) + 1);
                    session.nextResolveAt = Date.now() + retryDelayForMisses(session.resolveMisses);
                }
            })
            .catch(err => {
                if (!session || session.cancelled || resolveGeneration !== session.resolveGeneration) return;
                session.resolveMisses = Math.min(20, Number(session.resolveMisses || 0) + 1);
                session.nextResolveAt = Date.now() + retryDelayForMisses(session.resolveMisses);
                console.warn('[LyricsAuto] background upgrade failed:', err?.message || err);
            })
            .finally(() => {
                if (session && resolveGeneration === session.resolveGeneration) session.resolvePromise = null;
            });
    };

    const tick = async () => {
        if (busy || editLanes.has(key)) return;
        if (!session || session.cancelled || sessions.get(key) !== session) return;
        if (Date.now() < Number(session.nextEditAt || 0)) return;
        if (Number(session.lastEditAt || 0) > 0 && Date.now() - Number(session.lastEditAt || 0) < minEditGapMs) return;
        busy = true;
        activeKeys.add(key);
        editLanes.set(key, session);
        try {
            const queue = player.getQueue(guildId);
            const current = queue?.currentTrack;
            if (!current) {
                // Do not permanently kill Auto just because the queue is between tracks for a moment.
                session.emptyTicks = (session.emptyTicks || 0) + 1;
                if (session.emptyTicks >= Math.ceil(15_000 / intervalMs)) stopByKey(key);
                return;
            }
            session.emptyTicks = 0;
            const currentKey = trackIdentity(current);
            const clockKey = playbackGeneration(queue);
            const currentResource = queue?.resource;
            const playbackStillCurrent = () => {
                const live = player.getQueue(guildId);
                return trackIdentity(live?.currentTrack) === currentKey
                    && playbackGeneration(live) === clockKey && live?.resource === currentResource;
            };
            if (session.clockKey !== clockKey || session.resource !== currentResource) {
                session.clockKey = clockKey;
                session.resource = currentResource;
                session.lastActiveIndex = -2;
            }

            // Invalidate the old body immediately. Provider discovery has its own
            // generation and never occupies the edit lane; a slow B lookup must
            // not prevent this panel from following the next queue track C.
            if (currentKey !== session.trackKey) {
                session.resolveGeneration++;
                session.resolvePromise = null;
                session.generation++;
                session.trackKey = currentKey;
                session.track = current;
                session.lyrics = { plainLyrics: '', syncedLines: [], hasSynced: false, pending: true };
                session.lastActiveIndex = -2;
                session.resolveMisses = 0;
                session.nextResolveAt = 0;
                session.pendingPlainRefresh = true;
            }

            let activeLyrics = session.lyrics;
            // Provider upgrades must never block the display loop. Estimated/native
            // fallback lyrics keep moving while the deeper lookup runs in parallel.
            if (!hasReliableSync(activeLyrics)) scheduleUpgrade(current, currentKey);

            if (!activeLyrics?.syncedLines?.length) {
                if (session.pendingPlainRefresh) {
                    session.pendingPlainRefresh = false;
                    const elapsed = Math.max(0, queue?.getElapsedPrecise?.() ?? queue?.getElapsed?.() ?? 0);
                    const payload = await render(current, elapsed, activeLyrics);
                    if (session.cancelled || sessions.get(key) !== session) return;
                    if (session.lyrics !== activeLyrics) return;
                    if (!playbackStillCurrent()) return;
                    await timedEdit(payload);
                    failures = 0;
                }
                return;
            }
            const elapsed = Math.max(0,
                (queue?.getElapsedPrecise ? queue.getElapsedPrecise() : queue?.getElapsed?.() || 0)
                + adaptiveLeadMs() / 1000
            );
            const activeIndex = lyricsProvider.getCurrentSyncedIndex?.(activeLyrics.syncedLines, elapsed) ?? -1;
            if (activeIndex === session.lastActiveIndex) return;
            const generation = session.generation;
            const payload = await render(current, elapsed, activeLyrics);
            if (session.cancelled || sessions.get(key) !== session || generation !== session.generation) return;
            if (session.lyrics !== activeLyrics) return;
            if (!playbackStillCurrent()) return;
            await timedEdit(payload);
            if (session.cancelled || sessions.get(key) !== session || generation !== session.generation) return;
            session.lastActiveIndex = activeIndex;
            failures = 0;
        } catch (err) {
            failures++;
            const code = err?.code || err?.rawError?.code;
            // Stop only when Discord tells us the target can no longer be edited.
            // A network/REST outage may last longer than a few seconds; killing Auto
            // after 10 quick failures made lyrics stay frozen until the user reopened it.
            if ([10062, 10008, 50027].includes(code)) stopByKey(key);
            else {
                if (session && !session.cancelled) session.nextEditAt = Date.now() + retryDelayForEditFailures(failures);
                console.warn('[LyricsAuto] transient update failed:', err?.message || err);
            }
        } finally {
            busy = false;
            if (editLanes.get(key) === session) {
                editLanes.delete(key);
                activeKeys.delete(key);
            }
        }
    };

    const interval = setInterval(tick, intervalMs);
    const timeout = setTimeout(() => stopByKey(key), durationMs);
    interval.unref?.();
    timeout.unref?.();
    session = {
        player,
        interval, timeout, cancelled: false,
        trackKey: trackIdentity(track), track, lyrics,
        lastActiveIndex: -2, generation: 0, emptyTicks: 0,
        resolveMisses: hasReliableSync(lyrics) ? 0 : 1,
        nextResolveAt: hasReliableSync(lyrics) ? 0 : Date.now() + retryDelayForMisses(1),
        editLatencyMs: 220, nextEditAt: 0, lastEditAt: 0,
        resolvePromise: null, resolveGeneration: 0, pendingPlainRefresh: false,
    };
    sessions.set(key, session);
    // Hard bound abandoned/private lyric panels. Keep the newest session and
    // stop oldest sessions first so timers/closures cannot accumulate forever.
    while (sessions.size > MAX_AUTO_SESSIONS) {
        const oldestKey = sessions.keys().next().value;
        if (!oldestKey || oldestKey === key) break;
        stopByKey(oldestKey);
    }
    void tick();
    return true;
}

module.exports = { makeKey, start, stop, stopByKey, _sessions: sessions, _activeKeys: activeKeys, _trackIdentity: trackIdentity, _retryDelayForMisses: retryDelayForMisses, _retryDelayForEditFailures: retryDelayForEditFailures, _hasReliableSync: hasReliableSync, _maxSessions: MAX_AUTO_SESSIONS };
module.exports.stopForPlayer = player => { for (const [key, session] of sessions) if (session.player === player) stopByKey(key); };
