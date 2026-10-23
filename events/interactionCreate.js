const { getPlayer } = require("../utils/playerContext");
const {
    createNowPlayingMessage,
    createNowPlayingPayload,
    createNowPlayingUpdate,
    createSuccessEmbed,
    createErrorEmbed,
    createQueueEmbed,
    createFavoritesMessage,
    createFavoriteSavedEmbed,
    createLyricsMessage,
    createLyricsPayload,
    createMoreMessage,
} = require("../utils/embed");
const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const config = require("../config");
const favorites = require("../utils/favoritesStore");
const history = require('../utils/historyStore');
const { recommendForUser } = require('../utils/recommendations');
const { sessions, createCollectionMessage, KINDS } = require('../utils/collectionUI');
const { generateCollectionCard, generateMoreCard } = require('../utils/uiCards');
const { downloadAudio } = require('../utils/audioDownload');
const lyricsProvider = require("../utils/lyricsProvider");
const lyricsAutoFollow = require('../utils/lyricsAutoFollow');
const { skipPlayback } = require('../utils/skipControl');
const { canonicalTrackKey } = require('../utils/trackIdentity');
const { canUsePlayback, isCurrentPlaybackTarget, acknowledgeSilently } = require('../utils/fleetRouting');
// Only pending panel requests live here. Closing/reopening a panel invalidates
// its lookup before a slow provider or card renderer can edit or restart it.
const lyricsPanelRequests = new Map();
function requireCurrentPlaybackTarget(interaction, player, client, queue) {
    if (!isCurrentPlaybackTarget(interaction, client, queue, player)) throw new Error('Join the current assigned voice room for this player.');
}

function lyricsSessionKey(interaction) {
    return lyricsAutoFollow.makeKey(interaction.guild?.id || 'dm', interaction.channel?.id || 'channel', interaction.user?.id || 'user');
}

function stopLyricsAuto(interaction) {
    lyricsPanelRequests.delete(lyricsSessionKey(interaction));
    lyricsAutoFollow.stop({
        guildId: interaction.guild?.id || 'dm',
        channelId: interaction.channel?.id || 'channel',
        userId: interaction.user?.id || 'user',
    });
}

function startLyricsAuto(interaction, player, lyrics, track) {
    if (!track || !interaction.guild?.id) return false;
    return lyricsAutoFollow.start({
        guildId: interaction.guild.id,
        channelId: interaction.channel?.id || 'channel',
        userId: interaction.user.id,
        player,
        track,
        lyrics,
        render: async (current, elapsed, activeLyrics = lyrics) => {
            const payload = await createLyricsPayload(interaction.user, current, activeLyrics, {
                page: 0,
                elapsed,
                ownerId: interaction.user.id,
                autoFollow: true,
                dynamicCard: false,
            });
            return stripEphemeral(payload);
        },
        edit: payload => interaction.editReply(payload),
    });
}

const EPHEMERAL_FLAG = MessageFlags?.Ephemeral ?? 64;

function addEphemeralFlag(payload) {
    const out = { ...(payload || {}) };
    delete out.ephemeral;
    const current = Number(out.flags?.bitfield ?? out.flags ?? 0) || 0;
    out.flags = current | EPHEMERAL_FLAG;
    return out;
}

function privatePayload(payload) {
    if (typeof payload === "string") return addEphemeralFlag({ embeds: [createErrorEmbed(payload)], components: [] });
    if (payload?.data?.title || payload?.title || typeof payload?.toJSON === "function") {
        return addEphemeralFlag({ embeds: [payload], components: [] });
    }
    return addEphemeralFlag(payload || {});
}

async function safeEphemeral(interaction, payload) {
    const out = privatePayload(payload);
    try {
        if (interaction.deferred || interaction.replied) return await interaction.followUp(out);
        return await interaction.reply(out);
    } catch (err) {
        const code = err?.code || err?.rawError?.code;
        if (code !== 10062) console.error("[interaction] failed to reply:", err.message || err);
    }
}

async function handleSlashSkip(interaction, client) {
    if (!interaction.guild?.id) return safeEphemeral(interaction, 'استخدم الأمر داخل السيرفر.');
    const player = getPlayer(client);
    if (!player) return acknowledgeSilently(interaction);
    const queue = player.getQueue(interaction.guild.id);
    if (!canUsePlayback(interaction, client, queue)) return acknowledgeSilently(interaction);
    if (!queue?.currentTrack) return safeEphemeral(interaction, config.MESSAGES.NO_MUSIC);

    try {
        await interaction.deferReply({ flags: EPHEMERAL_FLAG });
        requireCurrentPlaybackTarget(interaction, player, client, queue);
        const outcome = await skipPlayback(queue, player, client, interaction.guild.id);
        if (outcome.unavailable) return interaction.editReply({ embeds: [createErrorEmbed(config.MESSAGES.NO_MUSIC)] });
        return interaction.editReply({ embeds: [createSuccessEmbed(
            'تخطي', outcome.ended ? 'لا توجد أغنية تالية. توقفت الموسيقى وبقي البوت في الروم.' : `تم تخطي: **${outcome.title}**`,
        )] });
    } catch (err) {
        console.error('[slash skip] failed:', err.message || err);
        if (!canUsePlayback(interaction, client, queue)) {
            if (interaction.deferred || interaction.replied) await interaction.deleteReply?.().catch(() => {});
            else return acknowledgeSilently(interaction);
            return;
        }
        if (interaction.deferred || interaction.replied) {
            return interaction.editReply({ embeds: [createErrorEmbed('تعذر التخطي الآن. حاول مجدداً.')] }).catch(() => {});
        }
        return safeEphemeral(interaction, 'تعذر التخطي الآن. حاول مجدداً.');
    }
}

async function safeEditPrivate(interaction, payload) {
    const out = { ...(payload || {}) };
    delete out.ephemeral;
    try {
        if (interaction.deferred || interaction.replied) return await interaction.editReply(out);
        return await interaction.reply(privatePayload(out));
    } catch (err) {
        const code = err?.code || err?.rawError?.code;
        if (code !== 10062) console.error("[interaction] failed to edit private:", err.message || err);
    }
}

async function safeEditControls(interaction, queue, player) {
    const privateMenu = Boolean(interaction.message?.flags?.has?.(64) || (Number(interaction.message?.flags?.bitfield || 0) & 64));
    const track = queue.currentTrack;
    const playToken = queue._playToken;
    const requestToken = queue._playRequestToken;
    const isCurrentControls = () => queue.currentTrack === track && queue._playToken === playToken
        && queue._playRequestToken === requestToken && !queue._intentionalDestroy && !player?.closed
        && (!player?.getQueue || player.getQueue(queue.guildId || interaction.guild?.id) === queue);
    const publicMessage = queue.nowPlayingMessage || (!privateMenu ? interaction.message : null);
    let pendingVisual = null;
    let visualChanged = false;
    const commitVisual = () => {
        if (!isCurrentControls()) return;
        queue._playerVisual = pendingVisual ? { fileName: pendingVisual.fileName, accent: pendingVisual.accent, animated: false } : null;
        queue._playerVisualTrackUrl = track?.url || '';
    };

    const payloadFactory = async () => {
        const changedTrack = queue._playerVisualTrackUrl !== (queue.currentTrack?.url || '');
        if (changedTrack) {
            visualChanged = true;
            return { ...(await createNowPlayingPayload(queue.currentTrack, queue, {
                commitVisual: false, snapshot: false, onVisual: visual => { pendingVisual = visual; },
            })), attachments: [] };
        }
        // Always refresh the embed, even with animated artwork. The serialized
        // edit lane in MusicPlayer keeps the attachment in place while the
        // timer, seek state and pause icon update immediately.
        return createNowPlayingUpdate(queue.currentTrack, queue);
    };

    try {
        if (publicMessage && player?.editNowPlayingMessage) {
            if (!queue.nowPlayingMessage) queue.nowPlayingMessage = publicMessage;
            const msg = await player.editNowPlayingMessage(queue, payloadFactory, {
                message: publicMessage, track, playToken,
                onSuccess: () => { if (visualChanged) commitVisual(); },
            });
            if (!isCurrentControls() || !msg) return null;
            if (privateMenu) await interaction.editReply({ components: createMoreMessage(queue).components }).catch(() => {});
            return isCurrentControls() ? msg : null;
        }
        const payload = await payloadFactory();
        if (!isCurrentControls()) return null;
        const result = await interaction.editReply(payload);
        if (!isCurrentControls()) return null;
        if (visualChanged) commitVisual();
        return result;
    } catch (err) {
        // Never bypass the serialized public-message edit lane: a direct edit can
        // race the animated attachment replacement and orphan the artwork above
        // the embed. Private menus may still be refreshed independently.
        if (privateMenu) {
            try {
                await interaction.editReply({ components: createMoreMessage(queue).components });
                return null;
            } catch (_) {}
        }
        throw err;
    }
}

function trackFromFavorite(track, user) {
    // Preserve provider/link/media identity when replaying saved tracks.
    return {
        ...track,
        title: track.title,
        url: track.url,
        author: track.author,
        duration: Number(track.duration || 0) || 0,
        thumbnail: track.thumbnail,
        source: track.source || "youtube",
        requester: user.tag || user.username,
        requesterId: user.id,
    };
}

async function ensureVoiceQueue(interaction, player, client) {
    const member = interaction.member;
    if (!member?.voice?.channel) throw new Error(config.MESSAGES.NO_VOICE_CHANNEL);
    let queue = player.getQueue(interaction.guild.id);
    if (queue?.voiceChannel && queue.voiceChannel.id !== member.voice.channelId) {
        throw new Error('Join the same voice channel as the player.');
    }
    if (!queue || !queue.connection || queue.connection.state?.status === "destroyed") {
        queue = await player.join(member.voice.channel, interaction.channel);
        requireCurrentPlaybackTarget(interaction, player, client, queue);
        client.queues.set(interaction.guild.id, queue);
    }
    requireCurrentPlaybackTarget(interaction, player, client, queue);
    return queue;
}

async function sendPublicNowPlaying(interaction, player, queue, track) {
    if (queue && (!interaction.client?.fleet || !queue.textChannel)) queue.textChannel = interaction.channel;
    return player.syncNowPlayingMessage(queue, track);
}

function stripEphemeral(payload) {
    const out = { ...(payload || {}) };
    delete out.ephemeral;
    if (out.flags != null) {
        const bits = (Number(out.flags?.bitfield ?? out.flags) || 0) & ~EPHEMERAL_FLAG;
        if (bits) out.flags = bits;
        else delete out.flags;
    }
    return out;
}

function webLinkRow(interaction, view = 'player') {
    try {
        const web = require('../utils/webPlayerServer');
        if (!web.isStarted?.()) return null;
        const url = web.createSessionUrl(interaction.user.id, interaction.guild.id, view);
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(view === 'lyrics' ? 'Open Live Lyrics' : 'Open Web Player').setURL(url)
        );
    } catch (_) { return null; }
}

async function openWebPlayer(interaction, view = 'player') {
    const row = webLinkRow(interaction, view);
    if (!row) return safeEphemeral(interaction, 'Web Player is not running on this bot yet.');
    return safeEphemeral(interaction, {
        embeds: [createSuccessEmbed('Web Player', 'Open the private high-performance player. The live progress and animated background run locally in your browser.')],
        components: [row],
    });
}

async function openFavorites(interaction, page = 1, mode = "reply") {
    const tracks = favorites.list(interaction.user.id);
    const payload = createFavoritesMessage(interaction.user, tracks, page);

    try {
        if (mode === "update") {
            const updatePayload = stripEphemeral(payload);
            if (interaction.deferred || interaction.replied) return await interaction.editReply(updatePayload);
            if (typeof interaction.update === "function") return await interaction.update(updatePayload);
            return await interaction.reply(privatePayload(payload));
        }

        // فتح المفضلة يجب أن يكون رداً مخفياً مستقلاً، ولا يعتمد على تعديل رسالة عامة.
        if (interaction.deferred || interaction.replied) return await interaction.followUp(privatePayload(payload));
        return await interaction.reply(privatePayload(payload));
    } catch (err) {
        const code = err?.code || err?.rawError?.code;
        console.error("[favorites] failed to open:", err?.message || err, err?.rawError || "");
        if (code === 10062) return;
        try {
            if (interaction.deferred || interaction.replied) {
                return await interaction.followUp(privatePayload({ embeds: [createErrorEmbed("تعذر فتح المفضلة الآن. تم تسجيل السبب في CMD.")], components: [] }));
            }
            return await interaction.reply(privatePayload({ embeds: [createErrorEmbed("تعذر فتح المفضلة الآن. تم تسجيل السبب في CMD.")], components: [] }));
        } catch (_) {}
    }
}

async function saveCurrentToFavorites(interaction, player) {
    try {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: EPHEMERAL_FLAG });
    } catch (_) { return true; }

    const queue = player.getQueue(interaction.guild.id);
    if (!queue?.currentTrack) {
        return interaction.editReply({ embeds: [createErrorEmbed("لا توجد أغنية تعمل حالياً لحفظها.")], components: [] }).catch(() => {});
    }

    const result = favorites.add(interaction.user, queue.currentTrack);
    // حفظ فوري حتى لو انطفأ البوت بعد الضغط بثوانٍ لا تضيع المفضلة.
    try { favorites.saveNow?.(interaction.user.id); } catch (_) {}
    return interaction.editReply({ embeds: [createFavoriteSavedEmbed(result)], components: [] }).catch(() => {});
}


async function openLyrics(interaction, player, page = 0, mode = "reply", options = {}) {
    const queue = player.getQueue(interaction.guild.id);
    let track = queue?.currentTrack;
    if (!track) return safeEphemeral(interaction, config.MESSAGES.NO_MUSIC);
    stopLyricsAuto(interaction);
    const panelKey = lyricsSessionKey(interaction);
    const panelRequest = {};
    lyricsPanelRequests.set(panelKey, panelRequest);
    const isCurrentPanel = () => lyricsPanelRequests.get(panelKey) === panelRequest && !player.closed;

    try {
        if (mode === "reply" && !interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: EPHEMERAL_FLAG });
        } else if (mode === "update" && !interaction.deferred && !interaction.replied) {
            await interaction.deferUpdate();
        }
    } catch (_) {
        if (lyricsPanelRequests.get(panelKey) === panelRequest) lyricsPanelRequests.delete(panelKey);
        return true;
    }

    try {
        if (!isCurrentPanel()) return true;
        let lyrics;
        let lyricsTrackKey = '';
        for (let attempt = 0; attempt < 3; attempt++) {
            const expected = lyricsAutoFollow._trackIdentity(track);
            lyricsTrackKey = expected;
            const preferredLanguage = lyricsProvider.guessLyricsLanguage?.(track.title, track.author) || undefined;
            lyrics = await lyricsProvider.findLyrics(track, { language: preferredLanguage });
            if (!isCurrentPanel()) return true;
            const latest = player.getQueue(interaction.guild.id)?.currentTrack;
            if (!latest) throw new Error('track changed');
            if (lyricsAutoFollow._trackIdentity(latest) === expected) { track = latest; break; }
            track = latest;
        }
        if (lyricsAutoFollow._trackIdentity(track) !== lyricsTrackKey) throw new Error('track changed during lyrics lookup');
        const liveQueue = player.getQueue(interaction.guild.id);
        const elapsed = Math.max(0, (liveQueue?.getElapsedPrecise ? liveQueue.getElapsedPrecise() : liveQueue?.getElapsed?.() || 0) + Number(config.DISCORD_LYRICS_SYNC_OFFSET_MS || 0) / 1000);
        const autoFollow = options.autoFollow !== false && Number(page || 0) <= 0;
        const payload = await createLyricsPayload(interaction.user, track, lyrics, {
            page, elapsed, ownerId: interaction.user.id, autoFollow, dynamicCard: !autoFollow,
        });
        if (!isCurrentPanel()) return true;
        const liveLyricsRow = webLinkRow(interaction, 'lyrics');
        if (liveLyricsRow && (payload.components?.length || 0) < 5) payload.components = [...(payload.components || []), liveLyricsRow];
        const out = stripEphemeral(payload);
        let result;
        if (mode === "update") result = await safeEditPrivate(interaction, out);
        else result = await interaction.editReply(out).catch(() => interaction.followUp(privatePayload(payload)).catch(() => {}));
        if (!isCurrentPanel()) return result;
        if (autoFollow) startLyricsAuto(interaction, player, lyrics, track);
        else stopLyricsAuto(interaction);
        return result;
    } catch (err) {
        if (!isCurrentPanel()) return true;
        console.error("[lyrics] failed:", err.message || err);
        stopLyricsAuto(interaction);
        const errPayload = { embeds: [createErrorEmbed("تعذر جلب كلمات الأغنية الآن. جرّب مرة أخرى أو اكتب `كلمات artist - song`.")], components: [] };
        if (interaction.deferred || interaction.replied) return interaction.editReply(errPayload).catch(() => interaction.followUp(privatePayload(errPayload)).catch(() => {}));
        return interaction.reply(privatePayload(errPayload)).catch(() => {});
    } finally {
        if (lyricsPanelRequests.get(panelKey) === panelRequest) lyricsPanelRequests.delete(panelKey);
    }
}

async function handleLyricsAction(interaction, player) {
    const customId = interaction.customId;
    if (customId === "music_lyrics") return openLyrics(interaction, player, 0, "reply", { autoFollow: true });
    if (!customId.startsWith("lyrics_")) return false;

    const parts = customId.split(":");
    const action = parts[0];
    const ownerId = parts[1];
    const rawPage = Number(parts[2] ?? 1);
    const page = Number.isFinite(rawPage) ? rawPage : 1;

    if (ownerId && ownerId !== interaction.user.id) {
        return safeEphemeral(interaction, "هذه نافذة كلمات خاصة بصاحبها فقط.");
    }

    if (action === "lyrics_close") {
        stopLyricsAuto(interaction);
        try {
            if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        } catch (_) { return true; }
        return safeEditPrivate(interaction, { content: "تم إغلاق نافذة الكلمات.", embeds: [], components: [] });
    }

    if (action === "lyrics_prev") { stopLyricsAuto(interaction); return openLyrics(interaction, player, Math.max(1, page - 1), "update", { autoFollow: false }); }
    if (action === "lyrics_next") { stopLyricsAuto(interaction); return openLyrics(interaction, player, page + 1, "update", { autoFollow: false }); }
    if (action === "lyrics_refresh") return openLyrics(interaction, player, page <= 0 ? 0 : page, "update", { autoFollow: page <= 0 });
    if (action === "lyrics_auto") return openLyrics(interaction, player, 0, "update", { autoFollow: true });
    return true;
}

async function handleFavoriteAction(interaction, client, player) {
    const customId = interaction.customId;

    if (customId === "music_fav_save") {
        return saveCurrentToFavorites(interaction, player);
    }

    if (customId === "music_fav_list") {
        return openFavorites(interaction, 1, "reply");
    }

    if (!customId.startsWith("fav_")) return false;

    const parts = customId.split(":");
    const action = parts[0];
    const ownerId = parts[1];
    if (ownerId && ownerId !== interaction.user.id) {
        return safeEphemeral(interaction, "هذه القائمة خاصة بصاحبها فقط.");
    }

    try {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    } catch (_) {
        return true;
    }

    const page = Number(parts[3] || parts[2] || 1) || 1;

    try {
        if (action === "fav_select_play" || action === "fav_select_queue" || action === "fav_select_remove") {
            const index = Number(interaction.values?.[0]);
            if (!Number.isInteger(index)) return safeEphemeral(interaction, "اختيار غير صالح من المفضلة.");

            if (action === "fav_select_remove") {
                const removed = favorites.remove(interaction.user, index);
                if (!removed) return safeEphemeral(interaction, "لم أجد هذه الأغنية في مفضلتك.");
                await safeEphemeral(interaction, createSuccessEmbed("تم الحذف", `تم حذف **${String(removed.title || "أغنية").substring(0, 80)}** من مفضلتك.`));
                return openFavorites(interaction, page, "update");
            }

            const fav = favorites.get(interaction.user.id, index);
            if (!fav) return safeEphemeral(interaction, "لم أجد هذه الأغنية في مفضلتك.");
            const queue = await ensureVoiceQueue(interaction, player, client);
            requireCurrentPlaybackTarget(interaction, player, client, queue);
            const track = trackFromFavorite(fav, interaction.user);
            const active = player.hasActivePlayback(queue);

            if (action === "fav_select_play") {
                player.stopPlayback(queue, true, { preserveNowPlayingMessage: true });
                queue.tracks = [];
                queue.currentIndex = 0;
                const { added } = player.addTracks(queue, [track]);
                const started = await player.play(queue, added[0], 0);
                if (!started) return safeEphemeral(interaction, "❌ تعذر تشغيل هذا المصدر الآن.");
                await sendPublicNowPlaying(interaction, player, queue, added[0]);
                await safeEphemeral(interaction, createSuccessEmbed("تشغيل من المفضلة", `بدأ تشغيل **${track.title.substring(0, 80)}**`));
                return openFavorites(interaction, page, "update");
            }

            if (active) {
                const { startIndex } = player.addTracks(queue, [track]);
                await player.refreshNowPlayingMessage(queue, true);
                await safeEphemeral(interaction, createSuccessEmbed("أضيفت من المفضلة", `تمت إضافة **${track.title.substring(0, 80)}** للمكان #${startIndex + 1}.`));
                return openFavorites(interaction, page, "update");
            }

            queue.tracks = [];
            queue.currentIndex = 0;
            const { added } = player.addTracks(queue, [track]);
            const started = await player.play(queue, added[0], 0);
            if (!started) return safeEphemeral(interaction, "❌ تعذر تشغيل هذا المصدر الآن.");
            await sendPublicNowPlaying(interaction, player, queue, added[0]);
            await safeEphemeral(interaction, createSuccessEmbed("تشغيل من المفضلة", `لا توجد قائمة فعالة، لذلك بدأت **${track.title.substring(0, 80)}** الآن.`));
            return openFavorites(interaction, page, "update");
        }

        if (action === "fav_page_prev" || action === "fav_page_next" || action === "fav_refresh") {
            const currentPage = Number(parts[2] || 1) || 1;
            const nextPage = action === "fav_page_prev" ? Math.max(1, currentPage - 1)
                : action === "fav_page_next" ? currentPage + 1
                : currentPage;
            return openFavorites(interaction, nextPage, "update");
        }

        // توافق احتياطي مع أي رسالة قديمة فيها IDs من نسخ سابقة.
        if (action === "fav_page") {
            return openFavorites(interaction, Number(parts[2] || 1) || 1, "update");
        }

        if (action === "fav_close") {
            return safeEditPrivate(interaction, { content: "تم إغلاق مفضلتك الخاصة.", embeds: [], components: [] });
        }

        if (action === "fav_clear") {
            const count = favorites.clear(interaction.user);
            return safeEditPrivate(interaction, {
                embeds: [createSuccessEmbed("تم مسح المفضلة", `تم حذف **${count}** أغنية من مفضلتك الخاصة.`)],
                components: [],
            });
        }

        if (action === "fav_remove") {
            const index = Number(parts[2]);
            const removed = favorites.remove(interaction.user, index);
            if (!removed) return safeEphemeral(interaction, "لم أجد هذه الأغنية في مفضلتك.");
            return openFavorites(interaction, page, "update");
        }

        if (action === "fav_play" || action === "fav_queue") {
            const index = Number(parts[2]);
            const fav = favorites.get(interaction.user.id, index);
            if (!fav) return safeEphemeral(interaction, "لم أجد هذه الأغنية في مفضلتك.");

            const queue = await ensureVoiceQueue(interaction, player, client);
            requireCurrentPlaybackTarget(interaction, player, client, queue);
            const track = trackFromFavorite(fav, interaction.user);
            const active = player.hasActivePlayback(queue);

            if (action === "fav_play") {
                player.stopPlayback(queue, true, { preserveNowPlayingMessage: true });
                queue.tracks = [];
                queue.currentIndex = 0;
                const { added } = player.addTracks(queue, [track]);
                const started = await player.play(queue, added[0], 0);
                if (!started) return safeEphemeral(interaction, "❌ تعذر تشغيل هذا المصدر الآن.");
                await sendPublicNowPlaying(interaction, player, queue, added[0]);
                await safeEphemeral(interaction, createSuccessEmbed("تشغيل من المفضلة", `بدأ تشغيل **${track.title.substring(0, 80)}**`));
                return openFavorites(interaction, page, "update");
            }

            if (active) {
                const { added, startIndex } = player.addTracks(queue, [track]);
                await player.refreshNowPlayingMessage(queue, true);
                await safeEphemeral(interaction, createSuccessEmbed("أضيفت من المفضلة", `تمت إضافة **${track.title.substring(0, 80)}** للمكان #${startIndex + 1}.`));
                return openFavorites(interaction, page, "update");
            }

            queue.tracks = [];
            queue.currentIndex = 0;
            const { added } = player.addTracks(queue, [track]);
            const started = await player.play(queue, added[0], 0);
            if (!started) return safeEphemeral(interaction, "❌ تعذر تشغيل هذا المصدر الآن.");
            await sendPublicNowPlaying(interaction, player, queue, added[0]);
            await safeEphemeral(interaction, createSuccessEmbed("تشغيل من المفضلة", `لا توجد قائمة فعالة، لذلك بدأت **${track.title.substring(0, 80)}** الآن.`));
            return openFavorites(interaction, page, "update");
        }

        if (action === "fav_playall" || action === "fav_queueall") {
            const list = favorites.list(interaction.user.id).map(t => trackFromFavorite(t, interaction.user));
            if (!list.length) return safeEphemeral(interaction, "مفضلتك فارغة.");

            const queue = await ensureVoiceQueue(interaction, player, client);
            requireCurrentPlaybackTarget(interaction, player, client, queue);
            const active = player.hasActivePlayback(queue);
            const forceNow = action === "fav_playall";

            if (forceNow) {
                player.stopPlayback(queue, true, { preserveNowPlayingMessage: true });
                queue.tracks = [];
                queue.currentIndex = 0;
            }

            if (!active || forceNow) {
                if (!active && !forceNow) {
                    // تنظيف أي بقايا قائمة قديمة إذا لم تكن هناك أغنية فعالة.
                    queue.tracks = [];
                    queue.currentIndex = 0;
                }
                const { added } = player.addTracks(queue, list);
                if (!added.length) return safeEphemeral(interaction, "القائمة ممتلئة ولا يمكن إضافة مفضلتك الآن.");
                queue.currentIndex = 0;
                const started = await player.play(queue, queue.currentTrack, 0);
                if (!started) return safeEphemeral(interaction, "❌ تعذر تشغيل هذا المصدر الآن.");
                await sendPublicNowPlaying(interaction, player, queue, queue.currentTrack);
                await safeEphemeral(interaction, createSuccessEmbed("تشغيل المفضلة", `🔥 تم تجهيز **${added.length}** أغنية من مفضلتك وبدأت الأولى الآن.`));
                return openFavorites(interaction, 1, "update");
            }

            const { added } = player.addTracks(queue, list);
            if (!added.length) return safeEphemeral(interaction, "القائمة ممتلئة ولا يمكن إضافة مفضلتك الآن.");
            await player.refreshNowPlayingMessage(queue, true);
            await safeEphemeral(interaction, createSuccessEmbed("إضافة المفضلة", `📥 تمت إضافة **${added.length}** أغنية من مفضلتك إلى نهاية القائمة.`));
            return openFavorites(interaction, 1, "update");
        }
    } catch (err) {
        console.error("[favorites] interaction error:", err.message || err);
        return safeEphemeral(interaction, err.message || "حدث خطأ في المفضلة. افحص CMD إذا تكرر.");
    }

    return true;
}

async function tracksForCollection(kind, user) {
    if (kind === 'favorites') return favorites.list(user.id);
    if (kind === 'history') return history.list(user.id);
    const recent = await history.list(user.id);
    const seeds = recent.length ? recent : favorites.list(user.id);
    return recommendForUser(user.id, seeds);
}

async function openMore(interaction, player) {
    try {
        await interaction.deferReply({ flags: EPHEMERAL_FLAG });
        const queue=player.getQueue(interaction.guild.id);
        const payload=createMoreMessage(queue);
        const card=await generateMoreCard(queue?.currentTrack);
        if(card) {
            payload.files=[card.file];
            payload.embeds[0].setImage(`attachment://${card.fileName}`).setColor(card.accent);
        }
        return interaction.editReply(stripEphemeral(payload));
    } catch (err) {
        console.warn('[More] card fallback:',err.message);
        return safeEditPrivate(interaction,stripEphemeral(createMoreMessage(player.getQueue(interaction.guild.id))));
    }
}

async function collectionPayload(kind, interaction, tracks, page) {
    const payload = createCollectionMessage(kind, interaction.user, tracks, page, sessions.list(interaction.user.id, kind));
    try {
        const image = await generateCollectionCard(kind, tracks, page);
        if (image) {
            payload.files = [image.file];
            payload.embeds[0].setImage(`attachment://${image.fileName}`);
            payload.embeds[0].setColor(image.accent);
        }
    } catch (err) { console.warn('[Collection] artwork fallback:', err.message); }
    return payload;
}

async function openCollection(interaction, kind, page = 1, update = false, refresh = false) {
    try {
        if (!interaction.deferred && !interaction.replied) {
            if (update) await interaction.deferUpdate();
            else await interaction.deferReply({ flags: EPHEMERAL_FLAG });
        }
        let tracks = sessions.snapshot(interaction.user.id, kind);
        if (refresh || !tracks.length) {
            tracks = await tracksForCollection(kind, interaction.user);
            sessions.setSnapshot(interaction.user.id, kind, tracks);
        }
        const payload = await collectionPayload(kind, interaction, tracks, page);
        const out = stripEphemeral(payload);
        if (update) out.attachments = [];
        return interaction.editReply(out);
    } catch (err) {
        console.error('[Collection] failed:', err.message);
        return safeEditPrivate(interaction, { embeds: [createErrorEmbed('Could not open this collection right now. Please try again.')], components: [], attachments: [] });
    }
}

async function playCollection(interaction, client, player, list, forceNow) {
    if (!list.length) return safeEphemeral(interaction, 'Select a track first.');
    const queue = await ensureVoiceQueue(interaction, player, client);
    requireCurrentPlaybackTarget(interaction, player, client, queue);
    const active = player.hasActivePlayback(queue);
    if (forceNow) player.stopPlayback(queue, true, { preserveNowPlayingMessage: true });
    if (!active || forceNow) { queue.tracks = []; queue.currentIndex = 0; }
    const tracks = list.map(t => trackFromFavorite(t, interaction.user));
    const { added } = player.addTracks(queue, tracks);
    if (!added.length) return safeEphemeral(interaction, 'The queue is full.');
    if (!active || forceNow) {
        const started = await player.play(queue, added[0], 0);
        if (!started) return safeEphemeral(interaction, "❌ تعذر تشغيل هذا المصدر الآن.");
        await sendPublicNowPlaying(interaction, player, queue, added[0]);
    } else {
        await player.refreshNowPlayingMessage(queue, true);
    }
    return safeEphemeral(interaction, createSuccessEmbed(forceNow || !active ? 'Playing' : 'Queued', `${added.length} track(s) · ${String(added[0].title).slice(0, 100)}`));
}

async function handleCollectionAction(interaction, client, player) {
    const [verb, kind, ownerId, rawPage] = interaction.customId.split(':');
    if (!KINDS.has(kind) || !ownerId) return;
    if (ownerId !== interaction.user.id) return safeEphemeral(interaction, 'This private collection belongs to another member.');
    const page = Math.max(1, Number(rawPage) || 1);
    try { if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate(); }
    catch (_) { return; }
    const list = sessions.snapshot(ownerId, kind);
    try {
        if (verb === 'coll_add') {
            const index = Number(interaction.values?.[0]);
            if (!Number.isInteger(index) || index < 0 || index >= list.length) return safeEphemeral(interaction, 'This selection expired. Refresh the list.');
            sessions.add(ownerId, kind, list[index]);
            return openCollection(interaction, kind, page, true);
        }
        if (verb === 'coll_remove' && kind === 'favorites') {
            const index = Number(interaction.values?.[0]);
            if (!Number.isInteger(index) || index < 0 || index >= list.length) return safeEphemeral(interaction, 'This selection expired. Refresh the list.');
            const target = list[index];
            const current = favorites.list(ownerId);
            const targetKey = canonicalTrackKey(target);
            const removeIndex = current.findIndex(t => canonicalTrackKey(t) === targetKey);
            if (removeIndex < 0) return openCollection(interaction, kind, page, true, true);
            favorites.remove(interaction.user, removeIndex);
            favorites.saveNow?.(ownerId);
            sessions.clear(ownerId, kind);
            await safeEphemeral(interaction, createSuccessEmbed('Removed from Library', `Removed **${String(target?.title || 'track').slice(0, 90)}** from your favorites.`));
            return openCollection(interaction, kind, page, true, true);
        }
        if (verb === 'coll_prev') return openCollection(interaction, kind, page - 1, true);
        if (verb === 'coll_next') return openCollection(interaction, kind, page + 1, true);
        if (verb === 'coll_refresh') return openCollection(interaction, kind, page, true, true);
        if (verb === 'coll_clear') { sessions.clear(ownerId, kind); return openCollection(interaction, kind, page, true); }
        if (verb === 'coll_close') {
            sessions.close(ownerId, kind);
            return safeEditPrivate(interaction, { content: 'Closed.', embeds: [], components: [], attachments: [] });
        }
        if (['coll_play', 'coll_queue', 'coll_all', 'coll_queueall'].includes(verb)) {
            const selected = verb === 'coll_all' || verb === 'coll_queueall' ? list : sessions.list(ownerId, kind);
            return playCollection(interaction, client, player, selected, verb === 'coll_play' || verb === 'coll_all');
        }
    } catch (err) {
        console.error('[Collection] action failed:', err.message);
        return safeEphemeral(interaction, err.message || 'Could not play these tracks.');
    }
}

async function openDownloadModal(interaction, player) {
    const current = player.getQueue(interaction.guild.id)?.currentTrack;
    const input = new TextInputBuilder().setCustomId('music_url').setLabel('Music URL · YouTube, Spotify, SoundCloud…')
        .setPlaceholder('https://www.youtube.com/watch?v=...').setRequired(true).setStyle(TextInputStyle.Short).setMaxLength(1000);
    if (current?.url) input.setValue(current.url.slice(0, 1000));
    return interaction.showModal(new ModalBuilder().setCustomId('music_download_submit').setTitle('Download audio').addComponents(new ActionRowBuilder().addComponents(input)));
}

async function handleDownloadSubmit(interaction, player) {
    await interaction.deferReply({ flags: EPHEMERAL_FLAG });
    const url = interaction.fields.getTextInputValue('music_url').trim();
    const current = player.getQueue(interaction.guild.id)?.currentTrack;
    const same = current?.url === url;
    let file;
    try {
        file = await downloadAudio(url, {
            title: same ? current.title : 'Music', duration: same ? current.duration : 0,
            maxBytes: Math.max(1_000_000, (Number(interaction.attachmentSizeLimit || interaction.guild?.filesizeLimit) || 20 * 1024 * 1024) - 64 * 1024),
        });
        const payload = { content: file.compressed ? 'Audio ready · compressed to fit Discord.' : 'Audio ready.', files: [new AttachmentBuilder(file.path, { name: file.filename })] };
        try { await interaction.editReply(payload); }
        catch (uploadError) {
            await interaction.user.send(payload);
            await interaction.editReply({ content: 'Sent the audio file to your DMs.' });
        }
    } catch (err) {
        console.error('[Audio download] failed:', err.message);
        await interaction.editReply({ content: `Audio download failed: ${String(err.message || 'source unavailable').slice(0, 350)}` }).catch(() => {});
    } finally { await file?.cleanup?.().catch(() => {}); }
}

module.exports = {
    name: "interactionCreate",
    async execute(interaction, client) {
        const interactionGuildId = interaction.guild?.id;
        const isSkipSlash = interaction.isChatInputCommand?.() && ['skip', 'سكب'].includes(interaction.commandName);
        if (interactionGuildId && config.ALLOWED_GUILD_IDS.length > 0 && !config.ALLOWED_GUILD_IDS.includes(interactionGuildId)) return;
        if (interactionGuildId && !client.fleet && config.TEXT_CHANNEL_LOCK && interaction.channelId !== config.TEXT_CHANNEL_LOCK) {
            return acknowledgeSilently(interaction);
        }
        if (isSkipSlash) {
            const slashPlayer = getPlayer(client);
            if (!interaction.guild?.id || !slashPlayer
                || !canUsePlayback(interaction, client, slashPlayer.getQueue(interaction.guild.id))) {
                return acknowledgeSilently(interaction);
            }
            return handleSlashSkip(interaction, client);
        }
        if (interaction.isModalSubmit?.() && interaction.customId === 'music_download_submit') {
            if (!interaction.guild?.id) return;
            const modalPlayer = getPlayer(client);
            if (!modalPlayer || !canUsePlayback(interaction, client, modalPlayer.getQueue(interaction.guild.id))) {
                return acknowledgeSilently(interaction);
            }
            return handleDownloadSubmit(interaction, modalPlayer);
        }
        if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

        const customId = interaction.customId;
        if (!customId.startsWith("music_") && !customId.startsWith("fav_") && !customId.startsWith("lyrics_") && !customId.startsWith('coll_')) return;

        const guildId = interaction.guild?.id;
        if (!guildId) return;

        const player = getPlayer(client);
        if (!player) return;

        // All interactive music components are scoped to the bot's assigned
        // voice room. This also protects entry points such as More and Web,
        // whose follow-up controls would otherwise be shown to an outsider.
        if (!canUsePlayback(interaction, client, player.getQueue(guildId))) {
            return acknowledgeSilently(interaction);
        }

        if (customId.startsWith('coll_')) return handleCollectionAction(interaction, client, player);
        if (customId === 'music_more') return openMore(interaction, player);
        if (customId === 'music_history') return openCollection(interaction, 'history', 1, false, true);
        if (customId === 'music_discover') return openCollection(interaction, 'discover', 1, false, true);
        if (customId === 'music_fav_list') return openCollection(interaction, 'favorites', 1, false, true);
        if (customId === 'music_download') return openDownloadModal(interaction, player);
        if (customId === 'music_web') return openWebPlayer(interaction, 'player');

        if (customId === "music_lyrics" || customId.startsWith("lyrics_")) {
            return handleLyricsAction(interaction, player);
        }

        if (customId === "music_fav_save" || customId.startsWith("fav_")) {
            return handleFavoriteAction(interaction, client, player);
        }

        const queue = player.getQueue(guildId);

        if (!queue || !queue.currentTrack) {
            return safeEphemeral(interaction, config.MESSAGES.NO_MUSIC);
        }

        const member = interaction.member;
        if (!member.voice.channelId || member.voice.channelId !== queue.voiceChannel?.id) {
            return safeEphemeral(interaction, "يجب أن تكون في نفس القناة الصوتية!");
        }

        // التفاعل يجب أن يُؤجل فوراً لأن seek/yt-dlp قد يأخذ أكثر من 3 ثوانٍ.
        try {
            if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        } catch (_) {
            return;
        }

        try {
            requireCurrentPlaybackTarget(interaction, player, client, queue);
            switch (customId) {
                case "music_pause": {
                    if (!queue.player) return safeEphemeral(interaction, config.MESSAGES.NO_MUSIC);
                    queue._autoPausedOnEmpty = false;
                    if (queue.paused) {
                        queue.player.unpause();
                        queue.paused = false;
                        queue.startTime = Date.now() - ((queue.pausedAt || Date.now()) - queue.startTime);
                        queue.pausedAt = 0;
                    } else {
                        queue.player.pause();
                        queue.paused = true;
                        queue.pausedAt = Date.now();
                    }
                    const msg = await safeEditControls(interaction, queue, player);
                    await player.setNowPlayingMessage(queue, msg);
                    break;
                }

                case "music_previous": {
                    if (queue.currentIndex <= 0) return safeEphemeral(interaction, "لا توجد أغنية سابقة في القائمة.");
                    const oldIndex = queue.currentIndex;
                    queue.currentIndex--;
                    const prev = queue.currentTrack;
                    const playRequest = player.play(queue, prev, 0);
                    const requestToken = queue._playRequestToken;
                    const started = await playRequest;
                    if (!started) {
                        requireCurrentPlaybackTarget(interaction, player, client, queue);
                        if (queue._playRequestToken !== requestToken || queue.currentTrack !== prev) return;
                        queue.currentIndex = oldIndex;
                        return safeEphemeral(interaction, "❌ تعذر تشغيل هذا المصدر الآن.");
                    }
                    const msg = await safeEditControls(interaction, queue, player);
                    await player.setNowPlayingMessage(queue, msg);
                    break;
                }

                case "music_skip": {
                    const privateMenu = Boolean(interaction.message?.flags?.has?.(64) || (Number(interaction.message?.flags?.bitfield || 0) & 64));
                    const outcome = await skipPlayback(queue, player, client, guildId, privateMenu ? null : interaction.message);
                    if (outcome.unavailable) return safeEphemeral(interaction, config.MESSAGES.NO_MUSIC);
                    await safeEphemeral(interaction, createSuccessEmbed('تخطي', outcome.ended
                        ? 'لا توجد أغنية تالية. توقفت الموسيقى وبقي البوت في الروم.'
                        : `تم تخطي: **${outcome.title}**`));
                    break;
                }

                case "music_forward": {
                    const elapsed = Math.max(0, queue.getElapsedPrecise?.() ?? queue.getElapsed?.() ?? 0);
                    const duration = Number(queue.currentTrack.duration || 0);
                    const seekTo = duration > 0
                        ? Math.min(elapsed + config.SEEK_SECONDS, Math.max(0, duration - 3))
                        : elapsed + config.SEEK_SECONDS;
                    const started = await player.play(queue, queue.currentTrack, seekTo);
                    if (!started) return safeEphemeral(interaction, "❌ لم يكتمل التقديم.");
                    const msg = await safeEditControls(interaction, queue, player);
                    await player.setNowPlayingMessage(queue, msg);
                    break;
                }

                case "music_rewind": {
                    const elapsed = Math.max(0, queue.getElapsedPrecise?.() ?? queue.getElapsed?.() ?? 0);
                    const seekTo = Math.max(0, elapsed - config.SEEK_SECONDS);
                    const started = await player.play(queue, queue.currentTrack, seekTo);
                    if (!started) return safeEphemeral(interaction, "❌ لم يكتمل الرجوع.");
                    const msg = await safeEditControls(interaction, queue, player);
                    await player.setNowPlayingMessage(queue, msg);
                    break;
                }

                case "music_volup": {
                    const newVol = Math.min(queue.volume + 10, config.MAX_VOLUME);
                    queue.volume = newVol;
                    await player.applyVolume(queue);
                    const msg = await safeEditControls(interaction, queue, player);
                    await player.setNowPlayingMessage(queue, msg);
                    break;
                }

                case "music_voldown": {
                    const newVol = Math.max(queue.volume - 10, 1);
                    queue.volume = newVol;
                    await player.applyVolume(queue);
                    const msg = await safeEditControls(interaction, queue, player);
                    await player.setNowPlayingMessage(queue, msg);
                    break;
                }

                case "music_queue": {
                    return safeEphemeral(interaction, createQueueEmbed(queue, queue.queuePage || 1));
                }

                case "music_shuffle": {
                    const changed = player.shuffleUpcoming(queue);
                    if (!changed) return safeEphemeral(interaction, "لا توجد أغاني قادمة كافية للخلط.");
                    const msg = await safeEditControls(interaction, queue, player);
                    await player.setNowPlayingMessage(queue, msg);
                    return safeEphemeral(interaction, createSuccessEmbed("خلط القادم", `تم خلط **${changed}** أغنية قادمة مع إبقاء الحالية ثابتة.`));
                }

                case "music_clear_next": {
                    const removed = player.clearUpcoming(queue);
                    const msg = queue.currentTrack ? await safeEditControls(interaction, queue, player) : null;
                    if (msg) await player.setNowPlayingMessage(queue, msg);
                    return safeEphemeral(interaction, createSuccessEmbed("مسح القادم", `تم حذف **${removed}** أغنية من الانتظار، والحالية بقيت تعمل.`));
                }

                case "music_loop": {
                    if (!queue.loop && !queue.loopQueue) {
                        queue.loop = true;
                        queue.loopQueue = false;
                    } else if (queue.loop) {
                        queue.loop = false;
                        queue.loopQueue = true;
                    } else {
                        queue.loop = false;
                        queue.loopQueue = false;
                    }
                    const msg = await safeEditControls(interaction, queue, player);
                    await player.setNowPlayingMessage(queue, msg);
                    break;
                }

                case "music_stop": {
                    const publicMessage = queue.nowPlayingMessage;
                    player.stopPlayback(queue, true);
                    client.queues.set(guildId, queue);
                    const stoppedPayload = {
                        embeds: [createSuccessEmbed("توقفت الموسيقى", "تم إيقاف الأغنية ومسح القائمة.")],
                        components: [],
                        attachments: [],
                    };
                    if (publicMessage) await player.editNowPlayingMessage(queue, stoppedPayload, { message: publicMessage, allowStale: true }).catch(() => {});
                    if (interaction.message?.id !== publicMessage?.id) await interaction.editReply(stoppedPayload).catch(() => {});
                    break;
                }

                default:
                    break;
            }
        } catch (err) {
            const code = err?.code || err?.rawError?.code;
            if (code !== 10062) console.error("خطأ في التفاعل:", err.message || err);
            await safeEphemeral(interaction, "حدث خطأ في الزر. افحص CMD إذا تكرر.");
        }
    },
};
