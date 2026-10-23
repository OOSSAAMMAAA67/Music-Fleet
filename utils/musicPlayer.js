const {
    joinVoiceChannel,
    getVoiceConnection,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    StreamType,
    NoSubscriberBehavior,
} = require("@discordjs/voice");
const { PermissionFlagsBits, GatewayIntentBits } = require("discord.js");
const { Readable, PassThrough, pipeline } = require("stream");
const config = require("../config");
const ytDlp = require("./ytDlpProvider");
const mediaCache = require('./mediaCache');
const artworkResolver = require('./artworkResolver');
const { resolveFfmpegPath } = require("./ffmpegResolver");
const { isUnknownMessageReference } = require('./discordSafety');

const sleep = (ms, signal) => require('node:timers/promises').setTimeout(ms, undefined, { signal: signal || undefined });
const sameDiscordMessage = (a, b) => a === b || Boolean(a?.id && b?.id && a.id === b.id);

// Resolve the best available FFmpeg once: explicit path -> modern ffmpeg-static -> bundled fallback -> system PATH.
try { process.env.FFMPEG_PATH = resolveFfmpegPath(); } catch (_) {}

class MusicQueue {
    constructor(guildId) {
        this.guildId = guildId;
        this.tracks = [];
        this._queueRevision = 0;
        this._stopGeneration = 0;
        this.currentIndex = 0;
        this.volume = config.DEFAULT_VOLUME;
        this.loop = false;
        this.loopQueue = false;
        this.shuffle = false;
        this.paused = false;
        this.playing = false;
        this.connection = null;
        this.player = null;
        this.resource = null;
        this.textChannel = null;
        this.voiceChannel = null;
        this.leaveTimer = null;
        this.startTime = 0;
        this.seekPosition = 0;
        this.pausedAt = 0;
        this._prevVolume = config.DEFAULT_VOLUME;
        this._suppressIdle = false;
        this._suppressIdleGeneration = 0;
        this.lockedVoiceChannelId = null;
        this._rejoinTimer = null;
        this._rejoinTries = 0;
        this._rejoinPromise = null;
        this._joinPromise = null;
        this._voiceOutageAt = 0;
        this._voiceRecoveryWarningAt = 0;
        this._voiceResumePosition = null;
        this._intentionalDestroy = false;
        this.nowPlayingMessage = null;
        this._nowPlayingTrack = null;
        this._nowPlayingSendPromise = null;
        this._nowPlayingRetryTimer = null;
        this._nowPlayingRetryTrack = null;
        this._nowPlayingRetryCount = 0;
        this._nowPlayingFailureLoggedAt = 0;
        // Retained only to remove a progress post left by an older running build.
        this.nowPlayingProgressMessage = null;
        this._progressRetryAt = 0;
        this.progressTimer = null;
        this._progressUpdateBusy = false;
        this._playToken = 0;
        // Monotonic request generation: the newest play/seek/skip/stop request owns the queue.
        // Older async yt-dlp/FFmpeg startups are allowed to finish cleanup, but can never
        // stop or overwrite the newer resource.
        this._playRequestToken = 0;
        this._streamErrorRetries = 0;
        this._lastHealthLog = 0;
        this._earlyIdleRetries = 0;
        this._lastPlayingAt = 0;
        this._recoveryTimer = null;
        this._voiceResumePosition = null;
        this._startingTrack = false;
        this._forcePcmOnce = false;
        this._lastProgressTick = -1;
        this._progressGeneration = 0;
        // Serialize every edit of the public now-playing message. Without this,
        // a progress refresh can race the async artwork upgrade and leave the
        // animated attachment orphaned above the embed on Discord mobile.
        this._nowPlayingEditChain = Promise.resolve();
    }

    get currentTrack() {
        return this.tracks[this.currentIndex] || null;
    }

    getElapsed() {
        return Math.floor(this.getElapsedPrecise());
    }

    getElapsedPrecise() {
        // AudioResource.playbackDuration is the closest clock to what Discord has
        // actually consumed. Prefer it over Date.now() so the 600 ms startup
        // stability window, short buffering events and seeks cannot leave lyrics
        // or the Web Player permanently behind the audible stream.
        const resource = this.resource;
        const token = Number(resource?.__playToken || 0);
        const resourceMs = Number(resource?.playbackDuration);
        if (resource && (!token || token === Number(this._playToken || 0)) && Number.isFinite(resourceMs) && resourceMs >= 0) {
            return Math.max(0, Number(this.seekPosition || 0) + (resourceMs / 1000));
        }
        if (!resource && this._voiceResumePosition != null) return Math.max(0, Number(this._voiceResumePosition) || 0);
        if (!this.startTime) return Math.max(0, Number(this.seekPosition || 0));
        return Math.max(0, ((this.paused && this.pausedAt ? this.pausedAt : Date.now()) - this.startTime) / 1000);
    }
}

class MusicPlayer {
    constructor({ platform, group = 'default', client } = {}) {
        this.group = String(group);
        this.client = client;
        this.closed = false;
        this.queues = new Map();
        this._pendingStarts = new Set();
        this._pendingDisposals = new Set();
        this.platform = platform;
        this.ledger = new (require('./platformPlayback').PlaybackLedger)({ service: platform });
        this.lastSearchError = null;
        this.lastPlayError = null;
        this._healthTimer = setInterval(() => this._voiceHealthCheck(), Math.max(10000, Number(config.VOICE_HEALTH_CHECK_INTERVAL || 30000)));
        if (this._healthTimer.unref) this._healthTimer.unref();
    }

    _voiceHealthCheck() {
        if (!this._stayInVoiceEnabled()) return;
        for (const queue of this.queues.values()) {
            try {
                if (!queue?.voiceChannel || queue._intentionalDestroy) continue;
                const status = queue.connection?.state?.status;
                if (!queue.connection || status === VoiceConnectionStatus.Destroyed || status === VoiceConnectionStatus.Disconnected) {
                    this._scheduleReconnect(queue, `health_${status || "no_connection"}`);
                    continue;
                }
                if ((status === VoiceConnectionStatus.Signalling || status === VoiceConnectionStatus.Connecting)
                    && Date.now() - Number(queue._connectionStateSinceAt || Date.now()) >= Math.max(5000, Number(config.VOICE_REJOIN_STUCK_AFTER_MS || 15000))) {
                    this._scheduleReconnect(queue, `health_stuck_${status}`);
                    continue;
                }
                const botChannelId = queue.voiceChannel.guild.members.me?.voice?.channelId;
                if (queue.lockedVoiceChannelId && botChannelId && botChannelId !== queue.lockedVoiceChannelId) {
                    this._scheduleReconnect(queue, "health_moved_from_locked_channel");
                }
            } catch (_) {}
        }
    }

    getQueue(guildId) { return this.queues.get(guildId) || null; }

    async close() {
        if (this.closed) return;
        this.closed = true;
        require('./lyricsAutoFollow').stopForPlayer(this);
        clearInterval(this._healthTimer);
        this._healthTimer = null;
        for (const guildId of [...this.queues.keys()]) this.deleteQueue(guildId);
        await Promise.allSettled([...this._pendingStarts]);
        await Promise.allSettled([...this._pendingDisposals]);
        await this.ledger?.close();
    }

    getLastPlayError(queueOrGuild = null) {
        const queue = typeof queueOrGuild === 'string' ? this.getQueue(queueOrGuild) : queueOrGuild;
        return queue?._lastPlayError || this.lastPlayError || null;
    }

    createQueue(guildId) {
        const q = new MusicQueue(guildId);
        this.queues.set(guildId, q);
        return q;
    }

    _disposeResource(resource) {
        if (!resource) return;
        const trackCleanup = work => {
            if (!work?.then) return;
            this._pendingDisposals.add(work);
            Promise.resolve(work).finally(() => this._pendingDisposals.delete(work)).catch(() => {});
        };
        try { trackCleanup(resource.playStream?.cleanup?.()); } catch (_) {}
        try { trackCleanup(resource.cleanup?.()); } catch (_) {}
        try { resource.playStream?.destroy?.(); } catch (_) {}
    }

    _cleanupResource(queue, expectedResource = null) {
        if (!queue) return;
        const resource = expectedResource || queue.resource;
        if (!resource) return;
        // Never let a delayed Idle/error from an old AudioResource destroy the resource
        // that a newer play request has already installed on the queue.
        if (expectedResource && queue.resource !== expectedResource) {
            this._disposeResource(expectedResource);
            return;
        }
        this.ledger?.detach(queue, resource);
        this._disposeResource(resource);
        if (queue.resource === resource) queue.resource = null;
    }

    _invalidatePlayRequests(queue) {
        if (!queue) return 0;
        queue._startupController?.abort();
        if (queue._recoveryTimer) clearTimeout(queue._recoveryTimer);
        queue._recoveryTimer = null;
        queue._voiceResumePosition = null;
        queue._playRequestToken = (Number(queue._playRequestToken || 0) + 1) >>> 0;
        queue._playToken = (Number(queue._playToken || 0) + 1) >>> 0;
        return queue._playRequestToken;
    }

    _setIdleSuppression(queue, enabled, autoClearMs = 0) {
        if (!queue) return 0;
        const generation = (Number(queue._suppressIdleGeneration || 0) + 1) >>> 0;
        queue._suppressIdleGeneration = generation;
        queue._suppressIdle = Boolean(enabled);
        if (enabled && autoClearMs > 0) {
            const timer = setTimeout(() => {
                // An older timer must never clear suppression armed by a newer
                // seek/stop/retry operation.
                if (queue._suppressIdleGeneration === generation) queue._suppressIdle = false;
            }, Math.max(50, Number(autoClearMs) || 0));
            timer.unref?.();
        }
        return generation;
    }

    _consumeIdleSuppression(queue) {
        if (!queue?._suppressIdle) return false;
        this._setIdleSuppression(queue, false);
        return true;
    }

    deleteQueue(guildId) {
        const q = this.queues.get(guildId);
        if (q) {
            this.ledger?.finish(q, { reason: 'disconnect' });
            q._intentionalDestroy = true;
            this._invalidatePlayRequests(q);
            if (q.leaveTimer) clearTimeout(q.leaveTimer);
            if (q._rejoinTimer) clearTimeout(q._rejoinTimer);
            if (q._emptyRoomStopTimer) clearTimeout(q._emptyRoomStopTimer);
            if (q._nowPlayingRetryTimer) clearTimeout(q._nowPlayingRetryTimer);
            this._stopProgressUpdater(q);
            this._retireProgressMessage(q);
            this._cleanupResource(q);
            if (q.player)     { try { q.player.stop(true);    } catch (_) {} }
            if (q.connection) { try { q.connection.destroy(); } catch (_) {} }
        }
        this.queues.delete(guildId);
    }

    stopPlayback(queue, clearTracks = true, options = {}) {
        if (!queue) return false;
        // Cancel pending manual search intent even when this queue is idle.
        // Natural next/repeat and source recovery do not pass through this marker.
        queue._stopGeneration = (Number(queue._stopGeneration) || 0) + 1;
        const preserveNowPlayingMessage = options?.preserveNowPlayingMessage === true;
        this.ledger?.finish(queue, { reason: options?.endReason || 'manual-stop' });

        if (queue.leaveTimer) {
            clearTimeout(queue.leaveTimer);
            queue.leaveTimer = null;
        }
        if (queue._emptyRoomStopTimer) {
            clearTimeout(queue._emptyRoomStopTimer);
            queue._emptyRoomStopTimer = null;
            queue._emptyRoomSinceAt = 0;
        }
        if (queue._nowPlayingRetryTimer) {
            clearTimeout(queue._nowPlayingRetryTimer);
            queue._nowPlayingRetryTimer = null;
        }
        queue._nowPlayingRetryTrack = null;
        queue._nowPlayingRetryCount = 0;
        queue._nowPlayingTrack = null;

        this._invalidatePlayRequests(queue);
        this._setIdleSuppression(queue, true, 1000);
        this._cleanupResource(queue);

        if (queue.player) {
            try { queue.player.stop(true); } catch (_) {}
        }

        if (clearTracks) {
            if (queue.tracks.length) queue._queueRevision++;
            queue.tracks = [];
            queue.currentIndex = 0;
        }

        queue.playing = false;
        queue.paused = false;
        queue._autoPausedOnEmpty = false;
        queue.pausedAt = 0;
        queue.startTime = 0;
        queue.seekPosition = 0;
        queue._streamErrorRetries = 0;
        this._stopProgressUpdater(queue);
        if (!preserveNowPlayingMessage) this._retireProgressMessage(queue);
        if (!preserveNowPlayingMessage) queue.nowPlayingMessage = null;
        queue._playerVisual = null;
        queue._playerVisualTrackUrl = '';
        queue._visualUpgradeKey = null;
        queue._visualUpgradeBusy = false;

        return true;
    }

    async setNowPlayingMessage(queue, maybeMessage) {
        if (!queue) return null;
        const track = queue.currentTrack;
        const playToken = queue._playToken, requestToken = queue._playRequestToken;
        try {
            const message = await Promise.resolve(maybeMessage);
            if (!this._isCurrentQueue(queue) || !track || queue.currentTrack !== track ||
                queue._playToken !== playToken || queue._playRequestToken !== requestToken) return null;
            if (message && typeof message.edit === "function") {
                if (queue.nowPlayingMessage && !sameDiscordMessage(queue.nowPlayingMessage, message)) {
                    this._retireProgressMessage(queue);
                }
                queue.nowPlayingMessage = message;
                queue._displayedPaused = queue.paused;
                this._retireProgressMessage(queue);
                this._startProgressUpdater(queue);
                this._upgradeNowPlayingVisual(queue).catch(() => {});
                return message;
            }
        } catch (_) {}
        return null;
    }

    _retireProgressMessage(queue) {
        const message = queue?.nowPlayingProgressMessage;
        if (!queue) return;
        queue.nowPlayingProgressMessage = null;
        queue._progressRetryAt = 0;
        if (message) void Promise.resolve(message.delete?.()).catch(() => {});
    }

    _stopProgressUpdater(queue) {
        if (!queue) return;
        queue._progressGeneration = Number(queue._progressGeneration || 0) + 1;
        if (queue.progressTimer) {
            clearTimeout(queue.progressTimer);
            queue.progressTimer = null;
        }
        queue._lastProgressTick = -1;
    }

    _startProgressUpdater(queue) {
        if (!queue || config.NOW_PLAYING_PROGRESS_UPDATES === false) return;
        if (!queue.nowPlayingMessage || typeof queue.nowPlayingMessage.edit !== "function") return;

        this._stopProgressUpdater(queue);
        // The displayed time starts in the same embed as the animated artwork.
        // Poll near each second boundary, but edit only once per changed second.
        // Never reupload the animation or send a second progress message.
        const interval = Math.max(500, Number(config.PROGRESS_UPDATE_INTERVAL || 1000));
        const generation = queue._progressGeneration;
        queue._lastProgressTick = Math.floor(queue.getElapsedPrecise?.() ?? queue.getElapsed?.() ?? 0);

        const nextDelay = () => {
            const elapsedMs = Math.max(0, Date.now() - Number(queue.startTime || Date.now()));
            return Math.max(150, interval - (elapsedMs % interval) + 25);
        };

        const schedule = (delay = nextDelay()) => {
            if (queue._progressGeneration !== generation || !queue.nowPlayingMessage) return;
            queue.progressTimer = setTimeout(async () => {
                queue.progressTimer = null;
                try { await this.refreshNowPlayingMessage(queue); } catch (_) {}
                if (queue._progressGeneration !== generation || !queue.nowPlayingMessage) return;
                schedule();
            }, Math.max(100, Number(delay) || interval));
            queue.progressTimer.unref?.();
        };
        schedule();
    }

    /**
     * Serialize edits to the current public player message. Factories are evaluated
     * inside the lock so a queued refresh always uses the latest visual state.
     */
    async editNowPlayingMessage(queue, payloadOrFactory, options = {}) {
        if (!queue) return null;
        const message = options.message || queue.nowPlayingMessage;
        if (!message || typeof message.edit !== 'function') return null;
        const expectedTrack = options.track || queue.currentTrack;
        const expectedToken = options.playToken ?? queue._playToken;

        const run = async () => {
            if (options.allowStale !== true) {
                if (queue.nowPlayingMessage && !sameDiscordMessage(queue.nowPlayingMessage, message)) return null;
                if (expectedTrack && queue.currentTrack !== expectedTrack) return null;
                if (expectedToken && queue._playToken !== expectedToken) return null;
            }
            const payload = typeof payloadOrFactory === 'function'
                ? await payloadOrFactory()
                : payloadOrFactory;
            if (!payload) return null;
            if (options.allowStale !== true) {
                if (queue.nowPlayingMessage && !sameDiscordMessage(queue.nowPlayingMessage, message)) return null;
                if (expectedTrack && queue.currentTrack !== expectedTrack) return null;
                if (expectedToken && queue._playToken !== expectedToken) return null;
            }
            let edited;
            try {
                edited = await message.edit(payload);
            } catch (err) {
                if (isUnknownMessageReference(err) && sameDiscordMessage(queue.nowPlayingMessage, message)) {
                    queue.nowPlayingMessage = null;
                    this._stopProgressUpdater(queue);
                }
                throw err;
            }
            if (typeof options.onSuccess === 'function') {
                await options.onSuccess(edited, payload);
            }
            return edited;
        };

        const prior = queue._nowPlayingEditChain || Promise.resolve();
        const task = prior.catch(() => {}).then(run);
        queue._nowPlayingEditChain = task.catch(() => {});
        return task;
    }

    async refreshNowPlayingMessage(queue, force = false) {
        if (!queue) return false;
        if (queue._progressUpdateBusy) {
            if (force) queue._pendingForcedProgress = true;
            return false;
        }
        if (!queue.nowPlayingMessage || typeof queue.nowPlayingMessage.edit !== "function") return false;
        if (!queue.currentTrack || (!queue.playing && !queue.paused)) return false;
        // A new track must first commit its own artwork. Editing an old card
        // with a new track and no matching attachment can orphan the image.
        if (queue._playerVisualTrackUrl !== (queue.currentTrack.url || '')) return false;
        if (!force && Date.now() < (queue._progressRetryAt || 0)) return false;

        const elapsedTick = Math.floor(queue.getElapsedPrecise?.() ?? queue.getElapsed?.() ?? 0);
        if (!force && (queue.paused || queue._lastProgressTick === elapsedTick)) return false;

        queue._progressUpdateBusy = true;
        try {
            const { createNowPlayingUpdate } = require('./embed');
            const track = queue.currentTrack;
            const playToken = queue._playToken;
            let publishedTick = elapsedTick;
            const edited = await this.editNowPlayingMessage(queue, () => {
                if (queue._playerVisualTrackUrl !== (track.url || '')) return null;
                publishedTick = Math.floor(queue.getElapsedPrecise?.() ?? queue.getElapsed?.() ?? 0);
                if (!force && (queue.paused || queue._lastProgressTick === publishedTick)) return null;
                return createNowPlayingUpdate(track, queue, { controls: queue._displayedPaused !== queue.paused });
            }, { track, playToken });
            if (!edited) return false;
            queue._lastProgressTick = publishedTick;
            queue._displayedPaused = queue.paused;
            queue._progressRetryAt = 0;
            return true;
        } catch (err) {
            const code = err?.code || err?.rawError?.code;
            if ([10008, 50001, 50013, 429].includes(code)) queue._progressRetryAt = Date.now() + 15_000;
            if (code === 10008) { queue.nowPlayingMessage = null; this._stopProgressUpdater(queue); }
            return false;
        } finally {
            queue._progressUpdateBusy = false;
            if (queue._pendingForcedProgress) {
                queue._pendingForcedProgress = false;
                queueMicrotask(() => { void this.refreshNowPlayingMessage(queue, true).catch(() => {}); });
            }
        }
    }


    async _upgradeNowPlayingVisual(queue) {
        if (!queue?.nowPlayingMessage || !queue.currentTrack || config.NOW_PLAYING_ANIMATED_BACKGROUND === false) return false;
        const track = queue.currentTrack;
        const message = queue.nowPlayingMessage;
        const playToken = queue._playToken;
        const key = `${track.url || ''}|${track.thumbnail || ''}|${track.title || ''}`;
        if (queue._visualUpgradeKey === key || queue._visualUpgradeBusy) return false;
        queue._visualUpgradeBusy = true;
        try {
            const { generateAnimatedNowPlayingCard } = require('./uiCards');
            const animated = await generateAnimatedNowPlayingCard(track, queue);
            if (!animated || queue.currentTrack !== track || !sameDiscordMessage(queue.nowPlayingMessage, message) || queue._playToken !== playToken) return false;
            const visual = { fileName: animated.fileName, accent: animated.accent, animated: true };
            const { createNowPlayingEmbed, createMusicButtons } = require('./embed');

            // Replace the attachment inside the serialized edit lane. Crucially,
            // do NOT publish queue._playerVisual before Discord confirms this edit:
            // an already-queued progress refresh could otherwise reference the new
            // attachment filename before the file exists, making artwork disappear
            // or jump above the embed on some clients. onSuccess runs inside the
            // same lane before the next queued refresh is allowed to evaluate.
            const edited = await this.editNowPlayingMessage(queue, () => ({
                embeds: [createNowPlayingEmbed(track, queue, visual)],
                components: createMusicButtons(queue),
                attachments: [],
                files: [animated.file],
            }), {
                message, track, playToken,
                onSuccess: () => {
                    queue._playerVisual = visual;
                    queue._playerVisualTrackUrl = track.url || '';
                    queue._visualUpgradeKey = key;
                },
            });
            if (!edited) return false;
            this._startProgressUpdater(queue);
            return true;
        } catch (err) {
            console.warn('[AnimatedUI] fallback to static card:', err?.message || err);
            return false;
        } finally {
            queue._visualUpgradeBusy = false;
            if (queue.currentTrack && queue.nowPlayingMessage &&
                (queue.currentTrack !== track || !sameDiscordMessage(queue.nowPlayingMessage, message)) &&
                queue._visualUpgradeKey !== `${queue.currentTrack.url || ''}|${queue.currentTrack.thumbnail || ''}|${queue.currentTrack.title || ''}`) {
                setImmediate(() => this._upgradeNowPlayingVisual(queue).catch(() => {}));
            }
        }
    }

    _stayInVoiceEnabled() {
        return this.client?.fleet ? true : config.STAY_IN_VOICE !== false;
    }

    _isCurrentQueue(queue) {
        return Boolean(queue && !this.closed && !queue._intentionalDestroy && this.queues.get(queue.guildId) === queue);
    }

    _scheduleReconnect(queue, reason = "unknown", delayOverride = null) {
        if (!this._isCurrentQueue(queue) || !this._stayInVoiceEnabled() || (!this.client?.fleet && config.AUTO_REJOIN_ON_DISCONNECT === false)) return false;
        if (!queue.voiceChannel || queue._intentionalDestroy) return false;

        const baseDelay = Math.max(250, Number(config.REJOIN_DELAY || 1500));
        const maxDelay = Math.max(baseDelay, Number(config.REJOIN_MAX_DELAY || 30000));
        const exponent = Math.min(8, Math.max(0, Number(queue._rejoinTries || 0)));
        const backoff = Math.min(maxDelay, Math.round(baseDelay * (2 ** exponent)));
        const maxTries = Number(config.REJOIN_MAX_TRIES || 0);
        if (maxTries > 0 && queue._rejoinTries >= maxTries) return false;
        const delay = delayOverride == null ? Math.round(backoff * (0.85 + Math.random() * 0.3)) : Math.max(0, Number(delayOverride) || 0);

        // All gateway, health-check and pinned-room signals share one retry lane.
        // If a retry is already running, remember a follow-up request instead of
        // starting a second join while the first is still waiting for Ready.
        if (queue._rejoinPromise) {
            queue._rejoinRequestedDelay = queue._rejoinRequestedDelay == null
                ? delay : Math.min(queue._rejoinRequestedDelay, delay);
            queue._rejoinRequestedReason = reason;
            return true;
        }
        if (queue._rejoinTimer) {
            if (delay >= Number(queue._rejoinScheduledDelay ?? Infinity)) return true;
            clearTimeout(queue._rejoinTimer);
            queue._rejoinTimer = null;
        }
        queue._rejoinScheduledDelay = delay;
        if (!queue._voiceOutageAt) {
            queue._voiceOutageAt = Date.now();
            console.warn(`[VoiceRecovery] connection recovery started guild=${queue.guildId}; retries are serialized and music state is preserved.`);
        }
        queue._rejoinTimer = setTimeout(() => {
            queue._rejoinTimer = null;
            queue._rejoinScheduledDelay = null;
            if (!this._isCurrentQueue(queue)) return;
            const work = this._runVoiceRecovery(queue, reason);
            queue._rejoinPromise = work;
            work.catch(() => {}).finally(() => {
                if (queue._rejoinPromise === work) queue._rejoinPromise = null;
                if (!this._isCurrentQueue(queue)) return;
                const nextDelay = queue._rejoinRequestedDelay;
                const nextReason = queue._rejoinRequestedReason || reason;
                queue._rejoinRequestedDelay = null;
                queue._rejoinRequestedReason = null;
                if (nextDelay != null) this._scheduleReconnect(queue, nextReason, nextDelay);
            });
        }, delay);
        queue._rejoinTimer.unref?.();
        return true;
    }

    async _runVoiceRecovery(queue, reason) {
        if (!this._isCurrentQueue(queue) || !queue.voiceChannel) return false;
        const requestToken = queue._playRequestToken;
        const track = queue.currentTrack;
        const wantedPlayback = Boolean(track && (queue.playing || queue.paused || queue._voiceResumePosition != null));
        const resumeFrom = Math.max(0, queue._voiceResumePosition ?? queue.getElapsedPrecise());
        queue._rejoinTries++;

        try {
            const targetId = queue.lockedVoiceChannelId || queue.voiceChannel.id;
            const botChannelId = queue.voiceChannel.guild.members.me?.voice?.channelId;
            const connectionReady = queue.connection?.state?.status === VoiceConnectionStatus.Ready;
            if (!(connectionReady && botChannelId === targetId)) {
                await this.join(queue.voiceChannel, queue.textChannel);
            }
            if (!this._isCurrentQueue(queue) || queue._playRequestToken !== requestToken) return false;

            const ready = queue.connection?.state?.status === VoiceConnectionStatus.Ready;
            const actualChannelId = queue.voiceChannel.guild.members.me?.voice?.channelId;
            if (!ready || actualChannelId !== targetId) throw new Error('Voice connection is not ready in its assigned room yet.');

            const resetGeneration = requestToken;
            const stabilityTimer = setTimeout(() => {
                if (this._isCurrentQueue(queue) && queue._playRequestToken === resetGeneration
                    && queue.connection?.state?.status === VoiceConnectionStatus.Ready) queue._rejoinTries = 0;
            }, 15000);
            stabilityTimer.unref?.();

            if (wantedPlayback && track && queue.currentTrack === track && queue._playRequestToken === requestToken
                && !queue._startupController && (queue._voiceResumePosition != null || !queue.resource || !this.hasActivePlayback(queue))) {
                await this._recoverPlayback(queue, track, resumeFrom);
            }
            const stillRecoveringAudio = wantedPlayback && queue.currentTrack === track && queue.playing
                && queue._voiceResumePosition != null && !queue.resource;
            if (queue._voiceOutageAt && !stillRecoveringAudio) {
                const outageDuration = Date.now() - queue._voiceOutageAt;
                queue._voiceOutageAt = 0;
                console.log(`[VoiceRecovery] connection restored guild=${queue.guildId} after ${Math.round(outageDuration / 1000)}s.`);
            }
            return true;
        } catch (error) {
            const now = Date.now();
            if (now - Number(queue._voiceRecoveryWarningAt || 0) >= 60000) {
                queue._voiceRecoveryWarningAt = now;
                console.warn(`[VoiceRecovery] guild=${queue.guildId} attempt=${queue._rejoinTries} reason=${reason}: ${String(error?.message || error).slice(0, 220)}`);
            }
            this._scheduleReconnect(queue, reason);
            return false;
        }
    }

    _isTransientVoiceFailure(queue, error = null) {
        const state = queue?.connection?.state?.status;
        if (queue?.voiceChannel && state !== VoiceConnectionStatus.Ready) return true;
        const messages = [String(queue?._lastPlayError || '')];
        const codes = [];
        const seen = new Set();
        for (let current = error; current && typeof current === 'object' && messages.length < 7 && !seen.has(current); current = current.cause) {
            seen.add(current);
            messages.push(String(current.message || ''));
            if (current.code != null) codes.push(String(current.code));
        }
        if (error != null && typeof error !== 'object') messages.push(String(error));
        return /\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_[A-Z_]+)\b|socket hang up|network|DNS|name resolution|getaddrinfo|timed?\s*out|voice connection did not become ready|discord voice gateway|temporary server response|HTTP 5\d\d/i.test(`${codes.join(' ')} ${messages.join(' ')}`);
    }

    async search(query, options = {}) {
        this.lastSearchError = null;
        try {
            const limit = options.limit || config.YTDLP_SEARCH_LIMIT || 10;
            const results = await ytDlp.search(query, { limit });
            if (!results || !results.length) return null;
            return results;
        } catch (err) {
            this.lastSearchError = err.message || String(err);
            console.error("خطأ في البحث عبر yt-dlp:", this.lastSearchError);
            return null;
        }
    }



    hasActivePlayback(queue) {
        if (!queue || !queue.currentTrack) return false;
        const status = queue.player?.state?.status;
        return Boolean(queue.playing || queue.paused || status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.Buffering);
    }

    addTracks(queue, tracks = []) {
        if (!queue || !Array.isArray(tracks) || tracks.length === 0) return { startIndex: queue?.tracks?.length || 0, added: [] };
        const max = Number(config.MAX_QUEUE_SIZE || 0);
        const available = max > 0 ? Math.max(0, max - queue.tracks.length) : tracks.length;
        const added = tracks.slice(0, available).map(t => ({ ...t, queuedAt: Date.now() }));
        const startIndex = queue.tracks.length;
        queue.tracks.push(...added);
        if (added.length) queue._queueRevision++;
        return { startIndex, added };
    }

    clearUpcoming(queue) {
        if (!queue || !queue.tracks.length) return 0;
        const current = queue.currentTrack;
        if (!current) {
            const count = queue.tracks.length;
            queue.tracks = [];
            queue._queueRevision++;
            queue.currentIndex = 0;
            return count;
        }
        const before = queue.tracks.length;
        queue.tracks = queue.tracks.slice(0, queue.currentIndex + 1);
        queue.currentIndex = Math.max(0, queue.tracks.indexOf(current));
        const removed = Math.max(0, before - queue.tracks.length);
        if (removed) queue._queueRevision++;
        return removed;
    }

    shuffleUpcoming(queue) {
        if (!queue || queue.tracks.length < 3) return 0;
        const head = queue.tracks.slice(0, queue.currentIndex + 1);
        const upcoming = queue.tracks.slice(queue.currentIndex + 1);
        if (upcoming.length < 2) return 0;
        for (let i = upcoming.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]];
        }
        if (upcoming.some((track, index) => queue.tracks[head.length + index] !== track)) queue._queueRevision++;
        queue.tracks = [...head, ...upcoming];
        queue.shuffle = true;
        return upcoming.length;
    }

    moveTrack(queue, fromNumber, toNumber) {
        if (!queue || !queue.tracks.length) return null;
        const from = Number(fromNumber) - 1;
        const to = Number(toNumber) - 1;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= queue.tracks.length || to >= queue.tracks.length) return null;
        const current = queue.currentTrack;
        const [track] = queue.tracks.splice(from, 1);
        queue.tracks.splice(to, 0, track);
        if (from !== to) queue._queueRevision++;
        const newCurrentIndex = queue.tracks.indexOf(current);
        queue.currentIndex = newCurrentIndex >= 0 ? newCurrentIndex : Math.min(queue.currentIndex, queue.tracks.length - 1);
        return { track, from: from + 1, to: to + 1 };
    }

    removeTrack(queue, number) {
        if (!queue || !queue.tracks.length) return null;
        const index = Number(number) - 1;
        if (!Number.isInteger(index) || index < 0 || index >= queue.tracks.length) return null;
        if (index === queue.currentIndex) return { current: true };
        const [removed] = queue.tracks.splice(index, 1);
        queue._queueRevision++;
        if (index < queue.currentIndex) queue.currentIndex--;
        return { removed, index: index + 1 };
    }


    _assertBotVoicePermissions(voiceChannel) {
        const me = voiceChannel.guild.members.me;
        const perms = voiceChannel.permissionsFor(me);
        if (!perms?.has(PermissionFlagsBits.ViewChannel)) {
            throw new Error("Missing ViewChannel permission for the voice channel");
        }
        if (!perms?.has(PermissionFlagsBits.Connect)) {
            throw new Error("Missing Connect permission for the voice channel");
        }
        if (!perms?.has(PermissionFlagsBits.Speak)) {
            throw new Error("Missing Speak permission for the voice channel");
        }
        // Discord bots also need Use Voice Activity. If it is denied, the bot can appear in
        // the voice channel but Discord will not let it transmit normally.
        if (!perms?.has(PermissionFlagsBits.UseVAD)) {
            throw new Error("Missing Use Voice Activity permission for the voice channel");
        }
    }

    async _attemptReconnect(queue, connection) {
        if (!this._isCurrentQueue(queue) || !queue.voiceChannel || !connection) return false;
        queue._voiceResumePosition ??= Math.max(0, queue.getElapsedPrecise());
        this._scheduleReconnect(queue, 'voice_disconnected');
        return false;
    }

    async _recoverPlayback(queue, track, seek) {
        if (!this._isCurrentQueue(queue) || !track || queue.currentTrack !== track) return false;
        if (queue._recoveryPlaybackPromise) return queue._recoveryPlaybackPromise;
        const pause = { paused: queue.paused, auto: queue._autoPausedOnEmpty };
        const retryFrom = Math.max(0, Number(seek) || 0);
        const work = (async () => {
            const startedPromise = this.play(queue, track, retryFrom, { recoveryPause: pause, recovery: true });
            const requestToken = queue._playRequestToken;
            const started = await startedPromise;
            if (!started && this._isCurrentQueue(queue) && queue._playRequestToken === requestToken && queue.currentTrack === track) {
                const reason = this.getLastPlayError(queue) || 'Could not recover the interrupted recording.';
                if (this._isTransientVoiceFailure(queue, reason)) {
                    queue._voiceResumePosition = retryFrom;
                    queue.playing = true;
                    queue.paused = pause.paused === true;
                    queue._autoPausedOnEmpty = pause.auto === true;
                    this._scheduleReconnect(queue, 'transient_playback_recovery', 5000);
                } else {
                    this._handleTrackFailure(queue, reason);
                }
            }
            if (started && pause.restored == null && pause.paused && queue._playRequestToken === requestToken && !queue._intentionalDestroy && queue.player?.pause?.() !== false) {
                queue.paused = true;
                queue._autoPausedOnEmpty = pause.auto === true;
                queue.pausedAt = Date.now();
                this.refreshNowPlayingMessage(queue, true)?.catch?.(() => {});
            }
            return started;
        })();
        queue._recoveryPlaybackPromise = work;
        try { return await work; }
        finally { if (queue._recoveryPlaybackPromise === work) queue._recoveryPlaybackPromise = null; }
    }

    _clientHasVoiceIntent(client) {
        try {
            return !!client?.options?.intents?.has?.(GatewayIntentBits.GuildVoiceStates);
        } catch (_) {
            return false;
        }
    }

    _describeBotVoiceState(voiceChannel, connection) {
        const guild = voiceChannel.guild;
        const botMember = guild.members.me;
        const client = guild.client;
        const voiceState = botMember?.voice;
        const lines = [];
        lines.push(`connection=${connection?.state?.status || "none"}`);
        lines.push(`botChannel=${voiceState?.channelId || "none"}`);
        lines.push(`targetChannel=${voiceChannel.id}`);
        lines.push(`hasGuildVoiceStatesIntent=${this._clientHasVoiceIntent(client)}`);
        lines.push(`selfMute=${voiceState?.selfMute ?? "unknown"}`);
        lines.push(`serverMute=${voiceState?.serverMute ?? "unknown"}`);
        lines.push(`selfDeaf=${voiceState?.selfDeaf ?? "unknown"}`);
        lines.push(`serverDeaf=${voiceState?.serverDeaf ?? "unknown"}`);
        lines.push(`suppress=${voiceState?.suppress ?? "unknown"}`);
        return lines.join(" ");
    }

    async _waitConnectionReady(queue, context = "join", timeoutMs = 60000, signal = null) {
        const connection = queue?.connection;
        if (!connection) throw new Error("لا يوجد اتصال صوتي داخلي");

        if (connection.state.status === VoiceConnectionStatus.Ready) return true;

        try {
            await entersState(connection, VoiceConnectionStatus.Ready, signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : timeoutMs);
            return true;
        } catch (err) {
            if (signal?.aborted) throw signal.reason;
            const details = queue?.voiceChannel ? this._describeBotVoiceState(queue.voiceChannel, connection) : `connection=${connection.state.status}`;
            const msg = String(err?.message || err || "unknown");
            throw new Error(
                `Voice connection did not become Ready during ${context}. ${msg}. ${details}. ` +
                `إذا بقيت الحالة signalling فهذا يعني أن البوت لم يستلم أحداث Discord Voice Gateway، وليس مشكلة yt-dlp أو cookies.`
            );
        }
    }

    async join(voiceChannel, textChannel) {
        if (this.closed || this.client?.fleet?._closed) throw new Error('Player is closed.');
        const guildId = voiceChannel.guild.id;
        const queue = this.getQueue(guildId) || this.createQueue(guildId);
        if (queue._joinPromise) {
            if (!queue.voiceChannel || queue.voiceChannel.id === voiceChannel.id || queue.lockedVoiceChannelId === voiceChannel.id) {
                if (textChannel) queue.textChannel = textChannel;
                return queue._joinPromise;
            }
            await queue._joinPromise.catch(() => {});
            return this.join(voiceChannel, textChannel);
        }
        const work = this._joinInternal(voiceChannel, textChannel, queue);
        queue._joinPromise = work;
        try { return await work; }
        finally { if (queue._joinPromise === work) queue._joinPromise = null; }
    }

    async _joinInternal(voiceChannel, textChannel, queue) {
        if (this.closed || this.client?.fleet?._closed) throw new Error('Player is closed.');
        const guildId = voiceChannel.guild.id;
        if (this.client?.fleet) {
            const pin = this.client.fleet.state.getPins().find(p => p.botKey === this.client.botKey && p.guildId === guildId);
            if (!pin || pin.voiceChannelId !== voiceChannel.id) throw new Error('An owner must assign this bot to the voice room first.');
            if (voiceChannel.guild.client !== this.client) throw new Error('Voice room belongs to another client.');
        }
        if (queue.lockedVoiceChannelId && this._stayInVoiceEnabled()) {
            const locked = voiceChannel.guild.channels.cache.get(queue.lockedVoiceChannelId);
            if (locked) voiceChannel = locked;
        }

        this._assertBotVoicePermissions(voiceChannel);

        queue.textChannel = textChannel || queue.textChannel;
        queue.voiceChannel = voiceChannel || queue.voiceChannel;
        if (!queue.lockedVoiceChannelId && queue.voiceChannel) queue.lockedVoiceChannelId = queue.voiceChannel.id;
        queue._intentionalDestroy = false;

        if (!this._clientHasVoiceIntent(voiceChannel.client)) {
            throw new Error("GuildVoiceStates intent is not enabled in index.js. Replace index.js from the fixed package and restart the bot.");
        }

        let connection = getVoiceConnection(guildId, this.group);

        if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
            queue.connection = connection;
            try {
                // If the bot was moved, or a gateway handshake remained stuck through
                // a retry interval, refresh the voice session once in this join lane.
                const currentBotChannelId = voiceChannel.guild.members.me?.voice?.channelId;
                const status = connection.state.status;
                const transitionalStatus = status === VoiceConnectionStatus.Signalling || status === VoiceConnectionStatus.Connecting;
                const transitionalStuck = transitionalStatus && Number(queue._rejoinTries || 0) > 0
                    && Date.now() - Number(queue._connectionStateSinceAt || 0) >= Math.max(5000, Number(config.VOICE_REJOIN_STUCK_AFTER_MS || 15000));
                const shouldRejoin = status === VoiceConnectionStatus.Disconnected || transitionalStuck
                    || (status === VoiceConnectionStatus.Ready && currentBotChannelId !== voiceChannel.id);
                if (shouldRejoin && typeof connection.rejoin === "function") {
                    connection.rejoin({
                        channelId: voiceChannel.id,
                        guildId,
                        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                        selfDeaf: true,
                        selfMute: false,
                    });
                }
            } catch (_) {}
        } else {
            connection = joinVoiceChannel({
                group: this.group,
                channelId: voiceChannel.id,
                guildId,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: true,
                selfMute: false,
            });
            queue.connection = connection;
        }

        const ownsConnection = () => this._isCurrentQueue(queue) && queue.connection === connection;
        if (!connection.__musicMaestroDebugAttached) {
            connection.__musicMaestroDebugAttached = true;
            // @discordjs/voice forwards WebSocket failures as an EventEmitter
            // error. Without a listener, a transient HTTP 5xx response becomes
            // an uncaught exception and restarts the whole bot.
            connection.on("error", (err) => {
                if (!ownsConnection()) return;
                const message = String(err?.message || err);
                const temporaryGatewayStatus = /Unexpected server response: (5\d\d)\b/.exec(message);
                if (temporaryGatewayStatus) {
                    const now = Date.now();
                    if (now - (queue._lastVoiceGatewayWarningAt || 0) >= 60000) {
                        queue._lastVoiceGatewayWarningAt = now;
                        console.warn(`[Voice] Discord voice gateway returned HTTP ${temporaryGatewayStatus[1]} for guild ${guildId}; waiting for recovery.`);
                    }
                } else {
                    const now = Date.now();
                    if (now - Number(queue._lastVoiceErrorLogAt || 0) >= 60000) {
                        queue._lastVoiceErrorLogAt = now;
                        console.warn(`[Voice] connection error in guild ${guildId}: ${String(err?.message || err).slice(0, 260)}`);
                    }
                }
            });
            connection.on("stateChange", (oldState, newState) => {
                if (!ownsConnection()) return;
                const oldStatus = oldState?.status || "unknown";
                const newStatus = newState?.status || "unknown";
                const stateKey = `${oldStatus}->${newStatus}`;
                const now = Date.now();
                if (oldStatus !== newStatus) queue._connectionStateSinceAt = now;
                if (now - Number(queue._lastVoiceStateLogAt || 0) >= 10000) {
                    queue._lastVoiceStateLogKey = stateKey;
                    queue._lastVoiceStateLogAt = now;
                    console.log(`[VoiceDebug] guild=${guildId} ${stateKey}`);
                }
                if (newStatus === VoiceConnectionStatus.Ready && !queue._rejoinPromise
                    && (queue._voiceOutageAt || queue._voiceResumePosition != null)) {
                    this._scheduleReconnect(queue, 'voice_ready_after_recovery', 0);
                }
            });
            queue._connectionStateSinceAt = Date.now();

            connection.on(VoiceConnectionStatus.Disconnected, () => {
                if (!ownsConnection()) return;
                if (queue.currentTrack && (queue.playing || queue.paused)) {
                    queue._voiceResumePosition ??= Math.max(0, queue.getElapsedPrecise());
                    queue.playing = true;
                    this._cleanupResource(queue);
                }
                if (this._stayInVoiceEnabled()) this._scheduleReconnect(queue, 'voice_disconnected');
                else this.deleteQueue(guildId);
            });

            connection.on(VoiceConnectionStatus.Destroyed, () => {
                if (!ownsConnection()) return;
                queue._voiceResumePosition ??= Math.max(0, queue.getElapsedPrecise());
                this._cleanupResource(queue);
                if (queue.connection === connection) queue.connection = null;
                if (!queue._intentionalDestroy && this._stayInVoiceEnabled()) {
                    this._scheduleReconnect(queue, "connection_destroyed");
                }
            });
        }

        try {
            await this._waitConnectionReady(queue, "join", 60000);
            if (!ownsConnection()) throw new Error('Voice queue was retired or replaced while joining.');
        } catch (err) {
            const now = Date.now();
            if (now - Number(queue._lastReadyFailureLogAt || 0) >= 60000) {
                queue._lastReadyFailureLogAt = now;
                console.warn(`[VoiceRecovery] Ready wait failed guild=${guildId}: ${String(err.message || err).slice(0, 260)}`);
            }
            if (queue.connection === connection) {
                // Keep a live signalling/connecting connection. Destroying it on
                // every timeout forces a fresh gateway handshake during outages.
                if (connection.state.status === VoiceConnectionStatus.Destroyed) queue.connection = null;
            }
            if (this._stayInVoiceEnabled() && !queue._intentionalDestroy) this._scheduleReconnect(queue, 'join_not_ready');
            if (!this._stayInVoiceEnabled() && this.queues.get(guildId) === queue) this.queues.delete(guildId);
            throw err;
        }

        return queue;
    }

    async _waitResourceBuffer(resource, bufferMs = 0, signal = null) {
        let stream = resource?.playStream;
        // Real Discord resources expose an object-mode Opus packet stream. Keep
        // legacy/custom resource factories compatible without treating bytes as packets.
        if (!stream?.readableObjectMode) return;
        signal?.throwIfAborted();
        const capacity = Math.max(1, Number(stream.readableHighWaterMark) || 16);
        const requestedPackets = Math.min(250, Math.max(1, Math.ceil(Math.max(0, Number(bufferMs) || 0) / 20)));
        // The manual encoder applies live gain before its packet queue. Keep its
        // existing low-latency capacity so a volume change is not delayed by a
        // second reservoir of already transformed audio.
        const packets = resource.__volumeTransformer?.setVolume ? Math.min(capacity, requestedPackets) : requestedPackets;
        if (packets > capacity) {
            // A demuxer normally buffers only sixteen packets (320 ms). Add a
            // bounded packet reservoir instead of waiting forever behind that
            // watermark or changing Node/prism private buffer capacities.
            const buffered = new PassThrough({ objectMode: true, highWaterMark: Math.max(16, packets) });
            resource.playStream = stream = pipeline(stream, buffered, () => {});
        }
        const timeoutMs = Math.max(1000, Number(config.AUDIO_PIPELINE_READY_TIMEOUT_MS) || 22000);
        await new Promise((resolve, reject) => {
            let timer, settled = false;
            const done = error => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                for (const event of ['readable', 'finish', 'end', 'close']) stream.off(event, check);
                stream.off('error', fail);
                signal?.removeEventListener('abort', abort);
                error ? reject(error) : resolve();
            };
            const fail = error => done(error);
            const abort = () => done(signal.reason);
            const check = () => {
                const buffered = Number(stream.readableLength) || 0;
                if (stream.errored) return done(stream.errored);
                // A complete short recording can have fewer frames than the
                // runway. Node's ended flag is needed before a buffered Readable
                // emits end (the end event waits until those frames are consumed).
                const ended = stream.readableEnded || stream.writableFinished || stream._readableState?.ended;
                if (buffered >= packets || (buffered > 0 && ended)) return done();
                if (stream.destroyed || ended) return done(new Error('audio pipeline ended without an Opus packet'));
            };
            for (const event of ['readable', 'finish', 'end', 'close']) stream.on(event, check);
            stream.once('error', fail);
            signal?.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => done(new Error('audio pipeline did not buffer playable Opus packets before its deadline')), timeoutMs);
            // Request readable notification without consuming an audible frame.
            stream.read(0);
            check();
        });
    }

    async createStream(track, seek = 0, forcePipelineMode = null, volume = config.DEFAULT_VOLUME, playbackAttempt = 1, signal = null) {
        signal?.throwIfAborted();
        if (!track?.url || !track.url.startsWith("http")) {
            throw new Error("رابط الأغنية غير صالح");
        }

        let stream;
        const configuredMode = String(config.AUDIO_PIPELINE_MODE || "super-pcm").toLowerCase();
        const preferredMode = String(forcePipelineMode || configuredMode).toLowerCase();
        const adaptiveMode = preferredMode === "adaptive-hq" || preferredMode === "hybrid-hq";
        const primaryMode = adaptiveMode ? "hq-opus" : preferredMode;
        const allowFallback = config.AUDIO_PIPELINE_FALLBACK !== false;
        const startupBufferMs = Math.max(0, Number(config.AUDIO_STARTUP_BUFFER_MS || 0));

        const uploaded = require('./uploadsStore').parseUploadUrl(track.url);
        const localUpload = uploaded ? await require('./platformSources').awaitSource(() => require('./uploadsStore').resolveTrack(track), signal) : null;
        const cached = localUpload?.path || mediaCache.get(track.url);
        const openStream = async (forceMode, localFile = cached) => {
            let inputStream;
            let st;
            try {
                if (track.source === "direct" && !localFile) {
                    const opened = await require('./publicMedia').openPublicMedia(track.url, {
                        headerTimeoutMs: Math.max(1000, Number(config.DIRECT_AUDIO_FETCH_TIMEOUT_MS) || 20_000), signal,
                    });
                    inputStream = opened.response;
                }
                st = await ytDlp.createAudioStream(track.url, seek, {
                    volume: Number(volume === 0 ? 0 : (volume || config.DEFAULT_VOLUME)),
                    forceMode,
                    localFile,
                    inputStream,
                    playbackAttempt, signal,
                });
                if (st.ready) {
                    // A real packet must be available before attaching the resource.
                    await require('./platformSources').awaitSource(() => st.ready, signal);
                    signal?.throwIfAborted();
                }
                if (st.pipelineError) throw st.pipelineError;
                if (st.destroyed && st.readableLength === 0) {
                    throw new Error('audio pipeline closed before playback started');
                }
            } catch (err) { await st?.cleanup?.(); inputStream?.destroy(); throw err; }
            return st;
        };

        try {
            stream = await openStream(primaryMode);
        } catch (err) {
            if (signal?.aborted) throw signal.reason;
            if (cached && !localUpload) {
                try { stream = await openStream(primaryMode, null); }
                catch (remoteError) { err = remoteError; }
            }
            if (!stream) {
                signal?.throwIfAborted();
                // A removed or corrupted cache must not make a playable remote track fail.
                if (allowFallback && (adaptiveMode || primaryMode !== "super-pcm")) {
                    const fallbackMode = "super-pcm";
                    console.warn(`[AudioHQ] ${primaryMode} failed before stable audio; fallback to ${fallbackMode}: ${err.message || err}`);
                    stream = await openStream(fallbackMode, localUpload?.path || null);
                } else {
                    throw err;
                }
            }
        }
        const retrySource = Number(stream.ytdlpPlaybackAttempt || 1) > 1 && stream.ytdlpClients
            ? ` clients=${stream.ytdlpClients}` : '';
        console.log(`[yt-dlp/ffmpeg] تشغيل: ${track.title?.substring(0, 80)} عبر ${stream.ytdlpLabel || "yt-dlp"} pipeline=${stream.audioPipelineMode || "raw"}${retrySource}`);

        let resource;
        try { resource = createAudioResource(stream, {
            // createAudioStream يرجع إما Ogg/Opus عالي الجودة أو PCM خام كمسار احتياطي.
            // نحدد inputType صراحة لتجنب probe/Arbitrary ومشاكل The operation was aborted.
            inputType: stream.discordInputType || StreamType.Raw,
            // Opus arrives already encoded. The default high-quality route applies
            // live volume before encoding; inline volume here would re-encode at 128k.
            inlineVolume: ![StreamType.Opus, StreamType.OggOpus, StreamType.WebmOpus]
                .includes(stream.discordInputType || StreamType.Raw),
            metadata: track,
        }); } catch (error) { await stream.cleanup?.(); stream.destroy?.(); throw error; }

        // prism-media caps its Opus encoder at 128 kbps. The default PCM path
        // otherwise leaves this encoder at its library default bitrate.
        if (resource.encoder?.setBitrate) {
            const bitrate = Math.max(16_000, Math.min(128_000, Number(config.PCM_OPUS_BITRATE || 128_000)));
            try { resource.encoder.setBitrate(bitrate); }
            catch (err) { console.warn('[Audio] could not set PCM Opus bitrate:', err.message); }
        }

        resource.__audioPipelineMode = stream.audioPipelineMode || "raw-pcm";
        resource.__pcmPreGain = stream.pcmPreGain || 1;
        resource.__volumeTransformer = stream.volumeTransformer || null;
        resource.__hqPreGain = stream.hqPreGain || 1;
        resource.__hqLimitGain = stream.hqLimitGain !== false;
        resource.cleanup = () => {
            try { return stream.cleanup?.(); } catch (_) {}
        };

        try {
            await this._waitResourceBuffer(resource, startupBufferMs, signal);
            signal?.throwIfAborted();
            if (stream.pipelineError) throw stream.pipelineError;
        } catch (error) {
            await stream.cleanup?.();
            resource.playStream?.destroy();
            stream.destroy?.();
            throw error;
        }
        return resource;
    }

    play(queue, track, seek = 0, options = {}) {
        if (!queue || this.closed) return Promise.resolve(false);
        if (!options.recoveryPause && track === queue.currentTrack) {
            const previousTrack = queue.resource?.metadata || queue._lastPlaybackTrack;
            if (previousTrack && previousTrack !== track) { queue.paused = false; queue._autoPausedOnEmpty = false; queue.pausedAt = 0; }
            options = { ...options, recoveryPause: { paused: Boolean(queue.paused), auto: queue._autoPausedOnEmpty } };
        }
        queue._startupController?.abort();
        if (queue._recoveryTimer) clearTimeout(queue._recoveryTimer);
        queue._recoveryTimer = null;
        // Only an explicit play/seek/skip starts a new recovery budget. A source
        // surviving the startup grace does not erase repeated interruptions.
        if (options.recovery !== true) {
            queue._voiceResumePosition = null;
            queue._streamErrorRetries = 0;
            queue._earlyIdleRetries = 0;
        }
        const controller = new AbortController();
        queue._startupController = controller;
        const work = this._playRequest(queue, track, seek, controller.signal, options);
        this._pendingStarts.add(work);
        work.then(started => {
            if (started && this._isCurrentQueue(queue) && queue.currentTrack === track && queue.playing && queue.textChannel) {
                void this._sendNowPlaying(queue, track).catch(() => {});
            }
        }).catch(() => {});
        work.finally(() => {
            this._pendingStarts.delete(work);
            if (queue._startupController === controller) queue._startupController = null;
        }).catch(() => {});
        return work;
    }

    async _playRequest(queue, track, seek = 0, signal = null, options = {}) {
        if (!queue) return false;
        const requestToken = (Number(queue._playRequestToken || 0) + 1) >>> 0;
        queue._playRequestToken = requestToken;
        const maxAttempts = Math.max(1, Number(config.PLAYBACK_RETRIES || 0) + 1);
        let lastResult = false;
        let attemptSeek = Math.max(0, Number(seek) || 0);
        let restartedFromStart = false;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (queue._playRequestToken !== requestToken || queue._intentionalDestroy) return false;
            lastResult = await this._playOnce(queue, track, attemptSeek, attempt, requestToken, signal, options);
            if (queue._playRequestToken !== requestToken) return false;
            if (lastResult) return true;
            const startupError = String(queue._lastPlayError || this.getLastPlayError(queue) || '');
            if (options.recovery === true && this._isTransientVoiceFailure(queue, startupError)) {
                // A short internet outage is transport damage, not a bad song.
                // Retain the track/seek and let the serialized voice recovery lane
                // retry after connectivity returns instead of launching yt-dlp over
                // and over while DNS/Discord is still down.
                queue._voiceResumePosition = attemptSeek;
                queue.playing = true;
                return false;
            }
            if (!restartedFromStart && options.recovery === true && attemptSeek >= 30 && attempt < maxAttempts
                && /audio pipeline (?:did not produce real audio|closed before producing audio|did not buffer playable Opus packets)/i.test(startupError)) {
                restartedFromStart = true;
                attemptSeek = 0;
                console.warn(`[AudioPlayer] recovery seek produced no audio; retrying same track from start guild=${queue.guildId} offset=${Math.max(0, Number(seek) || 0)}s`);
            }
            if (queue._intentionalDestroy || attempt >= maxAttempts || queue._lastPlayErrorRetryable === false
                || Number.isInteger(queue._lastPlayErrorRetryLimit) && attempt > queue._lastPlayErrorRetryLimit) break;
            try { await sleep(Math.max(250, Number(config.PLAYBACK_RETRY_DELAY || 1200)), signal); }
            catch (error) { if (signal?.aborted) return false; throw error; }
            if (queue._playRequestToken !== requestToken) return false;
            if (queue.connection?.state?.status !== VoiceConnectionStatus.Ready && queue.voiceChannel) {
                try { await this.join(queue.voiceChannel, queue.textChannel); } catch (_) {}
            }
        }
        return lastResult;
    }

    async _playOnce(queue, track, seek = 0, attempt = 1, requestToken = queue?._playRequestToken || 0, signal = null, options = {}) {
        const playToken = queue ? ++queue._playToken : 0;
        const continuation = options.recovery === true || seek > 0 || queue?._streamErrorRetries > 0 || queue?._earlyIdleRetries > 0;
        let resource = null;
        const superseded = () => signal?.aborted || !queue || queue._intentionalDestroy || queue._playRequestToken !== requestToken;
        try {
            if (superseded()) return false;
            if (!queue?.connection) throw new Error("البوت غير متصل بقناة صوتية");
            const sources = require('./platformSources');
            if (track._platformUnresolved || sources.needsResolution(track)) {
                const resolved = await sources.resolve(track, track.requesterId, { signal });
                if (superseded()) return false;
                Object.assign(track, resolved, { _platformUnresolved: false });
            }

            // Resolve official/high-resolution Web artwork in parallel with audio startup.
            // Artwork is auxiliary: it must NEVER be able to abort voice playback.
            try {
                const artworkWarm = artworkResolver.warmArtwork(track);
                artworkWarm?.catch?.(err => console.warn('[Artwork] warm-up failed:', err.message || err));
            } catch (err) {
                console.warn('[Artwork] warm-up skipped:', err.message || err);
            }

            await this._waitConnectionReady(queue, "play", 60000, signal);
            if (superseded()) return false;

            // عند seek أو skip أو تشغيل جديد، أوقف عملية yt-dlp القديمة بدون السماح لـ Idle
            // أن يعتبرها نهاية أغنية وينتقل لأغنية عشوائية من القائمة.
            this._setIdleSuppression(queue, true);
            this._cleanupResource(queue);
            if (queue.player) {
                try { queue.player.stop(true); } catch (_) {}
            }

            const configuredPipeline = String(config.AUDIO_PIPELINE_MODE || "super-pcm").toLowerCase();
            // Keep the high-quality path on retries unless the operator has
            // explicitly enabled the lower-quality PCM emergency fallback.
            const hqLike = !["super-pcm", "supercharged-pcm", "raw-pcm"].includes(configuredPipeline);
            const allowPcmFallback = config.AUDIO_PIPELINE_FALLBACK === true;
            const forcePipeline = allowPcmFallback && (queue._forcePcmOnce || (hqLike && attempt > 1)) ? "super-pcm" : null;
            queue._forcePcmOnce = false;
            resource = await this.createStream(track, seek, forcePipeline, queue.volume, attempt, signal);
            if (superseded()) {
                this._disposeResource(resource);
                return false;
            }
            resource.__playToken = playToken;
            resource.volume?.setVolume(this._inlineVolumeGain(queue, resource));

            if (!queue.player) {
                queue.player = createAudioPlayer({
                    behaviors: {
                        // لا توقف المشغل فوراً لو تأخر اشتراك الاتصال لحظة واحدة.
                        noSubscriber: NoSubscriberBehavior.Play,
                    },
                });

                queue.player.on(AudioPlayerStatus.Idle, (oldState) => {
                    const endedResource = oldState?.resource || null;
                    const idleToken = endedResource?.__playToken || 0;
                    // An Idle event may arrive late for a resource replaced by a newer
                    // seek/skip/play. Dispose only that old resource and never touch the
                    // queue's current one.
                    if ((idleToken && idleToken !== queue._playToken) || (endedResource && queue.resource && endedResource !== queue.resource)) {
                        this._disposeResource(endedResource);
                        return;
                    }
                    // Voice pin recovery owns a transport-disposed stream. An
                    // ensuing Idle is not a source EOF and must not advance the
                    // queue or spend the bounded source recovery budget.
                    if (queue._voiceResumePosition != null) {
                        this._disposeResource(endedResource);
                        return;
                    }
                    if (this._consumeIdleSuppression(queue)) {
                        if (endedResource && endedResource !== queue.resource) this._disposeResource(endedResource);
                        return;
                    }

                    const track = queue.currentTrack;
                    // Snapshot the consumed-packet clock before disposal removes it.
                    const resumeFrom = Math.max(0, queue.getElapsedPrecise());
                    const duration = Number(track?.duration || 0);
                    const endTolerance = Math.max(2, Math.min(5, duration * 0.02));
                    const truncated = duration > 0 && duration - resumeFrom > endTolerance;
                    const elapsedMs = queue._lastPlayingAt ? (Date.now() - queue._lastPlayingAt) : 999999;
                    const earlyWindow = Math.max(1500, Number(config.EARLY_IDLE_WINDOW_MS || 4500));
                    const maxEarlyRetries = Math.max(0, Number(config.EARLY_IDLE_RETRIES || 0));

                    if (endedResource) this._cleanupResource(queue, endedResource);
                    else this._cleanupResource(queue);

                    // إذا انتهت الأغنية خلال أول ثواني وهي ليست أغنية قصيرة، فهذا غالباً stream فشل
                    // وليس انتهاء حقيقي. أعد نفس الأغنية بدل إرسال "انتهت القائمة" فوراً.
                    if (track && queue.playing && (truncated || (!duration && elapsedMs < earlyWindow))) {
                        if (queue._earlyIdleRetries < maxEarlyRetries) {
                            queue._earlyIdleRetries++;
                            const retryNo = queue._earlyIdleRetries;
                            console.warn(`[AudioPlayer] unexpected EOF; recovering same track guild=${queue.guildId} retry=${retryNo}/${maxEarlyRetries} from=${resumeFrom}s`);
                            queue.playing = false;
                            queue._forcePcmOnce = true;
                            const scheduledToken = queue._playRequestToken, scheduledIndex = queue.currentIndex;
                            queue._recoveryTimer = setTimeout(() => {
                                queue._recoveryTimer = null;
                                if (queue._intentionalDestroy || queue._playRequestToken !== scheduledToken || queue.currentIndex !== scheduledIndex || queue.currentTrack !== track) return;
                                const retryPromise = this._recoverPlayback(queue, track, resumeFrom);
                                const retryRequestToken = queue._playRequestToken;
                                retryPromise.then(started => {
                                    if (!started && queue._playRequestToken === retryRequestToken && queue.currentTrack === track) {
                                        this._handleTrackFailure(queue, this.getLastPlayError(queue) || "فشل stream في بداية الأغنية");
                                    }
                                }).catch(err => {
                                    if (queue._playRequestToken === retryRequestToken && queue.currentTrack === track) {
                                        this._handleTrackFailure(queue, err.message || "فشل stream في بداية الأغنية");
                                    }
                                });
                            }, Math.max(250, Number(config.PLAYBACK_RETRY_DELAY || 1200)));
                            queue._recoveryTimer.unref?.();
                            return;
                        }
                        return this._handleTrackFailure(queue, "الأغنية توقفت خلال أول ثواني أكثر من مرة؛ غالباً رابط/yt-dlp/ffmpeg لم ينتج صوتاً ثابتاً");
                    }

                    queue._earlyIdleRetries = 0;
                    this._onTrackEnd(queue);
                });

                queue.player.on("error", (err) => {
                    console.error("[AudioPlayer] خطأ:", err.message);
                    const failedResource = err?.resource || queue.resource || null;
                    const errorToken = failedResource?.__playToken || 0;
                    if ((errorToken && errorToken !== queue._playToken) || (failedResource && queue.resource && failedResource !== queue.resource)) {
                        this._disposeResource(failedResource);
                        return;
                    }
                    if (queue._voiceResumePosition != null) {
                        this._disposeResource(failedResource);
                        return;
                    }
                    const resumeFrom = Math.max(0, queue.getElapsedPrecise?.() ?? queue.getElapsed?.() ?? 0);
                    if (failedResource) this._cleanupResource(queue, failedResource);
                    else this._cleanupResource(queue);

                    if (this._consumeIdleSuppression(queue)) return;

                    const maxStreamRetries = Math.max(0, Number(config.STREAM_ERROR_RETRIES || 0));
                    if (queue.currentTrack && queue._streamErrorRetries < maxStreamRetries) {
                        queue._streamErrorRetries++;
                        queue._forcePcmOnce = true;
                        console.warn(`[AudioPlayer] retrying current track guild=${queue.guildId} retry=${queue._streamErrorRetries}/${maxStreamRetries} from=${resumeFrom}s pipeline=${config.AUDIO_PIPELINE_FALLBACK === true ? "PCM fallback" : configuredPipeline}`);
                        const recoveryTrack = queue.currentTrack;
                        const recoveryPromise = this._recoverPlayback(queue, recoveryTrack, resumeFrom);
                        const recoveryRequestToken = queue._playRequestToken;
                        recoveryPromise.then(started => {
                            if (!started && queue._playRequestToken === recoveryRequestToken && queue.currentTrack === recoveryTrack) {
                                this._handleTrackFailure(queue, this.getLastPlayError(queue) || "فشلت استعادة نفس الأغنية");
                            }
                        }).catch(err => {
                            if (queue._playRequestToken === recoveryRequestToken && queue.currentTrack === recoveryTrack) {
                                this._handleTrackFailure(queue, err.message || "فشلت استعادة نفس الأغنية");
                            }
                        });
                        return;
                    }

                    queue._streamErrorRetries = 0;
                    this._handleTrackFailure(queue, err.message || "خطأ في مشغل الصوت بعد استنفاد محاولات الاستعادة");
                });
            }

            if (superseded()) {
                this._disposeResource(resource);
                return false;
            }
            const subscription = queue.connection.subscribe(queue.player);
            if (!subscription) throw new Error("فشل الاشتراك في القناة الصوتية");
            if (superseded()) {
                this._disposeResource(resource);
                return false;
            }

            queue.resource = resource;
            // Publish the seek base before playback starts. getElapsedPrecise() can
            // then combine it with AudioResource.playbackDuration immediately.
            queue.seekPosition = Math.max(0, Number(seek || 0));
            queue.player.play(resource);

            // Do not report success before Discord's audio player really starts.
            // This catches many cases where yt-dlp/FFmpeg opens but no audio can be played.
            await entersState(queue.player, AudioPlayerStatus.Playing, signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : 20000);
            if (superseded()) {
                if (queue.resource === resource) this._cleanupResource(queue, resource);
                else this._disposeResource(resource);
                return false;
            }

            // Restore a recovered pause before the next voice packet is sent.
            // A user who resumed while the source was rebuilding owns that new intent.
            const recoveryPause = options.recoveryPause;
            let restorePause = Boolean(recoveryPause && queue.paused);
            if (recoveryPause) recoveryPause.restored = false;
            if (restorePause && queue.player.pause() === false) throw new Error('Could not restore the paused audio player.');

            // حماية مهمة: أحياناً يدخل المشغل Playing للحظة ثم Idle فوراً بسبب stream لم ينتج صوتاً صحيحاً.
            // لا نعتبر التشغيل ناجحاً إلا إذا صمدت حالة التشغيل فترة قصيرة.
            const sustainMs = Math.max(250, Number(config.PLAYING_STABILITY_GRACE_MS || 900));
            if (!restorePause) await sleep(sustainMs, signal);
            restorePause = Boolean(recoveryPause && queue.paused);
            const stableState = queue.player?.state?.status;
            if (!(restorePause ? [AudioPlayerStatus.Paused] : [AudioPlayerStatus.Playing, AudioPlayerStatus.Buffering]).includes(stableState)) {
                throw new Error(`audio stopped immediately after start (${stableState || "unknown"})`);
            }

            if (superseded() || queue._playToken !== playToken) {
                if (queue.resource === resource) this._cleanupResource(queue, resource);
                else this._disposeResource(resource);
                return false;
            }

            this._setIdleSuppression(queue, false);
            queue.playing = true;
            queue._lastPlaybackTrack = track;
            queue.paused = Boolean(restorePause);
            queue._autoPausedOnEmpty = restorePause && queue._autoPausedOnEmpty === true;
            queue.pausedAt = restorePause ? Date.now() : 0;
            if (recoveryPause) recoveryPause.restored = Boolean(restorePause);
            // Keep the wall-clock fallback aligned to the real resource clock too.
            // Audio may already have played throughout PLAYING_STABILITY_GRACE_MS.
            const resourcePlayedSeconds = Math.max(0, Number(resource?.playbackDuration || 0)) / 1000;
            queue.seekPosition = Math.max(0, Number(seek || 0));
            queue.startTime = Date.now() - ((queue.seekPosition + resourcePlayedSeconds) * 1000);
            queue._lastPlayingAt = Date.now();
            queue._voiceResumePosition = null;
            this.ledger?.begin(queue, track, resource, { seek, continuation });
            if (queue.leaveTimer) {
                clearTimeout(queue.leaveTimer);
                queue.leaveTimer = null;
            }

            queue._lastPlayError = null;
            queue._lastPlayErrorCode = null; queue._lastPlayErrorRetryable = true; queue._lastPlayErrorRetryLimit = null;
            queue._failureNotice = null;
            this.lastPlayError = null;
            this._startProgressUpdater(queue);

            // Auxiliary prefetch must never tear down audio that is already stable.
            // Run it in a fully isolated lane after playback starts.
            this._warmPlaybackExtras(queue, track);
            return true;
        } catch (err) {
            if (superseded() || (queue && queue._playToken !== playToken)) {
                if (resource && queue?.resource !== resource) this._disposeResource(resource);
                return false;
            }
            this.lastPlayError = err.message || String(err);
            if (queue) { queue._lastPlayError = this.lastPlayError; queue._lastPlayErrorCode = err.code || null;
                queue._lastPlayErrorRetryable = err.retryable !== false; queue._lastPlayErrorRetryLimit = err.retryLimit ?? null; }
            const state = queue?.connection?.state?.status || "no-connection";
            const playerState = queue?.player?.state?.status || "no-player";
            const transientRecoveryFailure = options.recovery === true && this._isTransientVoiceFailure(queue, err);
            const now = Date.now();
            if (!transientRecoveryFailure || now - Number(queue?._lastTransientPlaybackLogAt || 0) >= 60000) {
                if (queue && transientRecoveryFailure) queue._lastTransientPlaybackLogAt = now;
                console.warn(`خطأ في التشغيل (attempt ${attempt}):`, this.lastPlayError);
                console.warn(`[debug] voiceState=${state} playerState=${playerState}`);
            }
            this._cleanupResource(queue);
            if (queue?.player) {
                this._setIdleSuppression(queue, true, 1000);
                try { queue.player.stop(true); } catch (_) {}
            }
            if (queue?.connection?.state?.status === VoiceConnectionStatus.Signalling
                || queue?.connection?.state?.status === VoiceConnectionStatus.Connecting
                || queue?.connection?.state?.status === VoiceConnectionStatus.Disconnected) {
                if (options.recovery === true) {
                    queue._voiceResumePosition = Math.max(0, Number(seek) || 0);
                    queue.playing = Boolean(queue.currentTrack);
                }
                this._scheduleReconnect(queue, "play_signalling_failure");
            }
            return false;
        }
    }



    _warmPlaybackExtras(queue, track) {
        try {
            const lyricsProvider = require('./lyricsProvider');
            const prefetchNext = Math.max(0, Math.min(3, Number(config.PERFORMANCE_PREFETCH_NEXT_TRACKS || 2)));
            const warmTracks = [track, ...((queue?.tracks || []).slice((queue?.currentIndex || 0) + 1, (queue?.currentIndex || 0) + 1 + prefetchNext))];
            for (let warmIndex = 0; warmIndex < warmTracks.length; warmIndex++) {
                const warmTrack = warmTracks[warmIndex];
                if (!warmTrack) continue;
                // The current track is already being streamed live. Downloading it
                // again into seek-cache would duplicate network/disk traffic exactly
                // when audio deserves the highest priority. Prefetch audio only for
                // upcoming tracks; current artwork/lyrics can still warm in parallel.
                if (warmIndex > 0 && warmTrack.url && !require('./platformSources').needsResolution(warmTrack) && !require('./uploadsStore').parseUploadUrl(warmTrack.url)) void mediaCache.prefetch(warmTrack.url).catch(() => {});
                try {
                    const warmArtwork = artworkResolver.warmArtwork(warmTrack);
                    warmArtwork?.catch?.(() => {});
                } catch (_) {}
                try {
                    void lyricsProvider.findLyrics(warmTrack, {
                        language: lyricsProvider.guessLyricsLanguage(warmTrack.title, warmTrack.author),
                    }).then(found => {
                        // A YouTube uploader/channel is often not the recording artist
                        // (anime lyric channels, curator uploads, Arabic reposts). A
                        // strong lyrics identity gives the artwork resolver a much
                        // better Apple/Deezer/MusicBrainz query without changing the
                        // displayed queue title or the audio source.
                        const lt = String(found?.title || '').trim();
                        const la = String(found?.artist || '').trim();
                        if (lt && la) {
                            const changed = warmTrack.lyricsTitle !== lt || warmTrack.lyricsArtist !== la;
                            warmTrack.lyricsTitle = lt; warmTrack.lyricsArtist = la;
                            if (changed) void artworkResolver.warmArtwork(warmTrack, { forceRefresh: true }).catch(() => {});
                        }
                    }).catch(() => {});
                } catch (_) {}
            }
            if (track?.requesterId) {
                require('./historyStore').record(track.requesterId, track)
                    .catch(err => console.warn('[History] could not save playback:', err.message));
            }
        } catch (err) {
            console.warn('[Prefetch] auxiliary warm-up skipped:', err.message || err);
        }
    }

    _inlineVolumeGain(queue, resource) {
        const volume = Math.max(0, Math.min(Number(config.MAX_VOLUME || 150), Number(queue?.volume === 0 ? 0 : (queue?.volume || config.DEFAULT_VOLUME || 100))));
        const preGain = Number(resource?.__pcmPreGain || 1);
        if (preGain && preGain > 0 && preGain < 1 && config.PCM_LIMIT_INLINE_GAIN !== false) {
            return Math.min(1, volume / 100 / preGain);
        }
        return volume / 100;
    }

    async applyVolume(queue) {
        if (!queue) return false;
        if (queue.resource?.volume) {
            queue.resource.volume.setVolume(this._inlineVolumeGain(queue, queue.resource));
            return true;
        }
        if (queue.resource?.__volumeTransformer?.setVolume) {
            const volume = Math.max(0, Math.min(Number(config.MAX_VOLUME || 150), Number(queue.volume === 0 ? 0 : (queue.volume || config.DEFAULT_VOLUME || 100))));
            const preGain = Number(queue.resource.__hqPreGain || 1);
            let gain = (volume / 100) * preGain;
            if (queue.resource.__hqLimitGain !== false) gain = Math.min(1, gain);
            queue.resource.__volumeTransformer.setVolume(gain);
            return true;
        }
        // في أي مسار لا يدعم تغيير الصوت المباشر، نعيد تشغيل نفس الأغنية من نفس الثانية كحل احتياطي.
        if (queue.currentTrack && queue.playing) {
            const resumeFrom = Math.max(0, queue.getElapsed ? queue.getElapsed() : 0);
            return await this._recoverPlayback(queue, queue.currentTrack, resumeFrom);
        }
        return false;
    }

    _handleTrackFailure(queue, reason = "فشل تدفق الصوت", options = {}) {
        if (!queue) return false;
        const priorNotice = queue._failureNotice;
        const notify = options.notify !== false && !(priorNotice?.track === queue.currentTrack && priorNotice.reason === reason && Date.now() - priorNotice.at < 60000);
        queue._failureNotice = { track: queue.currentTrack, reason, at: Date.now() };
        queue._lastPlayError = String(reason);
        this.ledger?.finish(queue, { reason: 'error' });
        this._invalidatePlayRequests(queue);

        // لا تجعل البوت يمر على 100 أغنية كل ثواني إذا كان مصدر/stream يفشل.
        // نوقف الأغنية الحالية ونترك القائمة كما هي حتى يقرر المستخدم: تخطي / ش_الان / امسح.
        queue.playing = false;
        queue.paused = false;
        queue._autoPausedOnEmpty = false;
        queue.pausedAt = 0;
        queue.startTime = 0;
        queue.seekPosition = 0;
        queue._streamErrorRetries = 0;
        queue._earlyIdleRetries = 0;
        this._setIdleSuppression(queue, true, 1000);
        this._stopProgressUpdater(queue);
        this._cleanupResource(queue);
        try { queue.player?.stop(true); } catch (_) {}

        if (notify) {
            console.warn('[Playback '+this.group+' / '+queue.guildId+'] '+String(queue.currentTrack?.title||'track').slice(0,80)+': '+String(reason).slice(0,1000));
            // Technical detail stays in diagnostics. Repeated automatic failures
            // never create public Error cards or flood a server's voice chat.
            Promise.resolve(queue.nowPlayingMessage?.react?.('❌')).catch(() => {});
        }
        return true;
    }

    async skipPlayback(queue) {
        if (!queue || !queue.tracks.length) return false;
        const next = queue.loopQueue ? (queue.currentIndex + 1) % queue.tracks.length : queue.currentIndex + 1;
        if (next >= queue.tracks.length) return false;
        // An explicit skip is not a failed stream or a natural repeat-one end.
        this.stopPlayback(queue, false, { preserveNowPlayingMessage: true, endReason: 'skip' });
        queue.currentIndex = next; queue._earlyIdleRetries = 0;
        const track = queue.currentTrack, promise = this.play(queue, track, 0), token = queue._playRequestToken;
        const started = await promise;
        if (queue._playRequestToken !== token || queue.currentTrack !== track) return false;
        if (started) await this._sendNowPlaying(queue, track);
        else this._handleTrackFailure(queue, this.getLastPlayError(queue) || 'Could not play the next recording.');
        return started;
    }

    _onTrackEnd(queue) {
        if (!queue) return;
        const endedTrack = queue.currentTrack;
        this.ledger?.finish(queue, { completed: true, reason: 'completed' });

        if (!queue.tracks.length) {
            queue.playing = false;
            this._stopProgressUpdater(queue);
            return;
        }

        if (queue.loop && queue.currentTrack) {
            const loopTrack = queue.currentTrack;
            const loopPromise = this.play(queue, loopTrack, 0);
            const loopRequestToken = queue._playRequestToken;
            loopPromise.then(started => {
                if (!started && queue._playRequestToken === loopRequestToken && queue.currentTrack === loopTrack) {
                    this._handleTrackFailure(queue, this.getLastPlayError(queue) || 'فشل إعادة تشغيل الأغنية المكررة', { notify: true });
                }
            }).catch(err => {
                if (queue._playRequestToken === loopRequestToken && queue.currentTrack === loopTrack) {
                    this._handleTrackFailure(queue, err.message || 'فشل إعادة تشغيل الأغنية المكررة', { notify: true });
                }
            });
            return;
        }

        if (queue.loopQueue && queue.tracks.length > 0) {
            queue.currentIndex = (queue.currentIndex + 1) % queue.tracks.length;
        } else {
            queue.currentIndex++;
        }

        if (queue.currentIndex < queue.tracks.length) {
            const next = queue.tracks[queue.currentIndex];
            const nextPromise = this.play(queue, next);
            const nextRequestToken = queue._playRequestToken;
            nextPromise.then(started => {
                if (queue._playRequestToken !== nextRequestToken || queue.currentTrack !== next) return;
                if (started) this._sendNowPlaying(queue, next);
                else this._handleTrackFailure(queue, this.getLastPlayError(queue) || "فشل تشغيل الأغنية التالية", { notify: true });
            }).catch(err => {
                if (queue._playRequestToken === nextRequestToken && queue.currentTrack === next) {
                    this._handleTrackFailure(queue, err.message || "فشل تشغيل الأغنية التالية", { notify: true });
                }
            });
        } else {
            if (/^\d{5,32}$/.test(String(endedTrack?.requesterId || ''))) {
                queue.currentIndex = Math.max(0, queue.tracks.length - 1);
                queue.playing = false;
                this._stopProgressUpdater(queue);
                this._cleanupResource(queue);
                const token = queue._playRequestToken;
                void this._continueAutoplay(queue, endedTrack, token).then(continued => {
                    if (!continued && !queue._intentionalDestroy && queue._playRequestToken === token) this._finishEmptyQueue(queue);
                }).catch(err => {
                    console.warn('[Autoplay] could not continue:', err.message);
                    if (!queue._intentionalDestroy && queue._playRequestToken === token) this._finishEmptyQueue(queue);
                });
                return;
            }
            this._finishEmptyQueue(queue);
        }
    }

    async _continueAutoplay(queue, seed, token) {
        const service = this.platform || require('./platformService');
        const result = await service.autoplayNext(seed.requesterId, seed, { exclude: queue.tracks });
        if (queue._intentionalDestroy || queue._playRequestToken !== token || !result.enabled || !result.track) return false;
        const track = { ...result.track, requester: seed.requester, requesterId: seed.requesterId, _platformUnresolved: true };
        queue.tracks.push(track); queue._queueRevision++; queue.currentIndex = queue.tracks.length - 1;
        const work = this.play(queue, track, 0), requestToken = queue._playRequestToken;
        const started = await work;
        // A delayed failed autoplay startup must not stop a newer seek/play of
        // the same chosen track, which intentionally keeps its object identity.
        if (queue._intentionalDestroy || queue._playRequestToken !== requestToken || queue.currentTrack !== track) return true;
        if (started) this._sendNowPlaying(queue, track);
        else this._handleTrackFailure(queue, this.getLastPlayError(queue) || 'Autoplay source could not be played.');
        return true;
    }

    _finishEmptyQueue(queue) {
            queue.playing = false;
            queue.currentIndex = 0;
            if (queue.tracks.length) queue._queueRevision++;
            queue.tracks = [];
            this._stopProgressUpdater(queue);
            this._cleanupResource(queue);
            queue.nowPlayingMessage = null;
            this._retireProgressMessage(queue);

            if (config.LEAVE_ON_EMPTY && !this._stayInVoiceEnabled()) {
                queue.leaveTimer = setTimeout(() => {
                    this.deleteQueue(queue.guildId);
                }, config.LEAVE_TIMEOUT);
                queue.leaveTimer.unref?.();
            }

            if (queue.textChannel) {
                const { createEndEmbed } = require("./embed");
                queue.textChannel.send({ embeds: [createEndEmbed()] }).catch(() => {});
            }
    }

    async syncNowPlayingMessage(queue, track = queue?.currentTrack) {
        return this._sendNowPlaying(queue, track);
    }

    _scheduleNowPlayingRetry(queue, track) {
        if (!this._isCurrentQueue(queue) || !queue?.textChannel || !track || queue.currentTrack !== track) return false;
        if (queue._nowPlayingRetryTimer && queue._nowPlayingRetryTrack === track) return false;
        if (queue._nowPlayingRetryTimer) {
            clearTimeout(queue._nowPlayingRetryTimer);
            queue._nowPlayingRetryTimer = null;
        }
        if (queue._nowPlayingRetryTrack !== track) queue._nowPlayingRetryCount = 0;
        const attempt = Math.max(0, Number(queue._nowPlayingRetryCount || 0));
        const delay = Math.min(60000, Math.max(1000, Number(config.NOW_PLAYING_RETRY_BASE_MS || 2000) * (2 ** Math.min(5, attempt))));
        queue._nowPlayingRetryCount = attempt + 1;
        const now = Date.now();
        if (now - Number(queue._nowPlayingFailureLoggedAt || 0) >= 60000) {
            queue._nowPlayingFailureLoggedAt = now;
            console.warn(`[NowPlaying] panel delivery delayed guild=${queue.guildId}; retrying with backoff.`);
        }
        queue._nowPlayingRetryTrack = track;
        queue._nowPlayingRetryTimer = setTimeout(() => {
            queue._nowPlayingRetryTimer = null;
            queue._nowPlayingRetryTrack = null;
            if (this._isCurrentQueue(queue) && queue.currentTrack === track && (queue.playing || queue.paused)) {
                void this._sendNowPlaying(queue, track).catch(() => {});
            }
        }, Math.round(delay * (0.85 + Math.random() * 0.3)));
        queue._nowPlayingRetryTimer.unref?.();
        return true;
    }

    async _sendNowPlaying(queue, track) {
        if (!queue?.textChannel || !track || queue.currentTrack !== track || !this._isCurrentQueue(queue)) return null;
        if (queue._nowPlayingSendPromise) {
            await queue._nowPlayingSendPromise.catch(() => {});
            if (queue.currentTrack !== track) return null;
            if (queue.nowPlayingMessage && queue._nowPlayingTrack === track) return queue.nowPlayingMessage;
        }
        if (queue.nowPlayingMessage && queue._nowPlayingTrack === track) return queue.nowPlayingMessage;

        const work = (async () => {
            const { createNowPlayingMessage } = require('./embed');
            const playToken = queue._playToken;
            const requestToken = queue._playRequestToken;
            const commitStaticVisual = () => {
                queue._playerVisual = null;
                queue._playerVisualTrackUrl = track.url || '';
            };
            let message = queue.nowPlayingMessage;

            // Publish a lightweight player immediately. Artwork/animation upgrades
            // run only after this message exists, so slow rendering cannot prevent a
            // room from getting its own controls and progress panel.
            if (message && typeof message.edit === 'function') {
                try {
                    const edited = await this.editNowPlayingMessage(queue, () => ({
                        ...createNowPlayingMessage(track, queue), attachments: [],
                    }), { message, track, playToken, onSuccess: commitStaticVisual });
                    if (!edited) return null;
                    message = edited;
                } catch (error) {
                    // A temporary Discord failure must retry the edit. Only a truly
                    // deleted message is cleared by editNowPlayingMessage and replaced.
                    if (queue.nowPlayingMessage && sameDiscordMessage(queue.nowPlayingMessage, message)) throw error;
                    message = null;
                }
            }

            if (!message) {
                if (queue.currentTrack !== track || queue._playToken !== playToken || queue._playRequestToken !== requestToken) return null;
                message = await queue.textChannel.send(createNowPlayingMessage(track, queue));
                if (queue.currentTrack !== track || queue._playToken !== playToken || queue._playRequestToken !== requestToken) {
                    void Promise.resolve(message?.delete?.()).catch(() => {});
                    return null;
                }
                commitStaticVisual();
            }

            await this.setNowPlayingMessage(queue, message);
            if (!this._isCurrentQueue(queue) || queue.currentTrack !== track || queue._playToken !== playToken || queue._playRequestToken !== requestToken) return null;
            queue._nowPlayingTrack = track;
            queue._nowPlayingRetryCount = 0;
            queue._nowPlayingRetryTrack = null;
            if (queue._nowPlayingRetryTimer) {
                clearTimeout(queue._nowPlayingRetryTimer);
                queue._nowPlayingRetryTimer = null;
            }
            return queue.nowPlayingMessage || message;
        })();
        queue._nowPlayingSendPromise = work;
        try {
            const message = await work;
            if (!message && queue.currentTrack === track && (queue.playing || queue.paused)) this._scheduleNowPlayingRetry(queue, track);
            return message;
        } catch (error) {
            if (queue.currentTrack === track && (queue.playing || queue.paused)) this._scheduleNowPlayingRetry(queue, track);
            return null;
        } finally {
            if (queue._nowPlayingSendPromise === work) queue._nowPlayingSendPromise = null;
        }
    }

    static formatDuration(seconds) {
        if (!seconds || isNaN(seconds) || seconds <= 0) return "مباشر";
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
        return `${m}:${s.toString().padStart(2, "0")}`;
    }

    static createProgressBar(current, total, size = 28) {
        const safeSize = Math.max(18, Math.min(Number(size) || 28, 32));
        if (!total || total <= 0 || !isFinite(total)) return "─".repeat(safeSize);
        const progress = Math.min(Math.max(Number(current || 0) / total, 0), 1);
        const units = Math.round(progress * safeSize * 8);
        const full = Math.floor(units / 8);
        const fraction = units % 8;
        const partial = fraction ? '▏▎▍▌▋▊▉'[fraction - 1] : '';
        return '━'.repeat(full) + partial + '─'.repeat(safeSize - full - (fraction ? 1 : 0));
    }
}

module.exports = { MusicPlayer, MusicQueue };
