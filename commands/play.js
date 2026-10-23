const {
    createNowPlayingPayload,
    createErrorEmbed,
    createSuccessEmbed,
    createQueueAddedEmbed,
} = require("../utils/embed");
const { isInVoiceChannel } = require("../utils/permissions");
const config = require("../config");
const { MusicPlayer } = require("../utils/musicPlayer");
const { getPlayer, createPlayerProxy } = require('../utils/playerContext');
const { canUsePlayback } = require('../utils/fleetRouting');
const { reactQuietly } = require('../utils/quietControl');

const player = createPlayerProxy();
const pendingPlayCommands = new WeakMap();

function isUrl(input) {
    return /^https?:\/\//i.test(String(input || "").trim());
}

function isDestroyed(connection) {
    return !connection || connection.state?.status === "destroyed";
}

async function ensureQueue(message, client, searchMsg, commandCurrent = () => true, observeQueue = () => {}) {
    const player = getPlayer(client);
    let queue = player.getQueue(message.guild.id);
    observeQueue(queue);
    if (!queue || isDestroyed(queue.connection)) {
        let joiningQueue = queue;
        let joiningConnection = queue?.connection;
        try {
            const joining = player.join(message.member.voice.channel, message.channel);
            joiningQueue = player.getQueue(message.guild.id) || queue;
            joiningConnection = joiningQueue?.connection;
            observeQueue(joiningQueue);
            queue = await joining;
            if (!commandCurrent() || getPlayer(client) !== player || player.closed || player.getQueue(message.guild.id) !== queue || !canUsePlayback(message, client, queue)) {
                throw Object.assign(new Error('Playback target changed during voice readiness.'), { code: 'PLAYBACK_SUPERSEDED', __alreadyReported: true });
            }
            client.queues.set(message.guild.id, queue);
        } catch (e) {
            if (e.code === 'PLAYBACK_SUPERSEDED') throw e;
            const liveQueue = player.getQueue(message.guild.id);
            if (!commandCurrent() || getPlayer(client) !== player || player.closed
                || (liveQueue && liveQueue !== joiningQueue)
                || (liveQueue?.connection && liveQueue.connection !== joiningConnection)) {
                throw Object.assign(new Error('Playback target changed during voice readiness.'), { code: 'PLAYBACK_SUPERSEDED', __alreadyReported: true });
            }
            if (client?.fleet) player._scheduleReconnect?.(player.getQueue(message.guild.id), 'command_join_failed');
            else { player.deleteQueue(message.guild.id); client.queues.delete(message.guild.id); }
            console.warn('[Play join]', e.message || e);
            await reactQuietly(message, '❌');
            e.__alreadyReported = true;
            throw e;
        }
    }
    return queue;
}

function selectTracks(query, results) {
    const queryIsUrl = isUrl(query);
    // روابط البلايليست تُضيف القائمة كلها، أما البحث النصي فيأخذ أفضل نتيجة فقط لسرعة واستقرار أعلى.
    return (queryIsUrl && results.length > 1) ? results : [results[0]];
}

async function replyToQueuedRequest(message, payload) {
    try {
        return await message.reply(payload);
    } catch (error) {
        // The queue mutation already succeeded. A missing/failed reply must
        // not be reported as a failed play request or invite the user to retry
        // and add the same track a second time.
        console.warn('[Play queue confirmation]', error?.message || error);
        await reactQuietly(message, '✅');
        return null;
    }
}

async function playQuery(message, args, client, options = {}) {
    const player = getPlayer(client);
    const forceNow = Boolean(options.forceNow);
    const queueOnly = options.queueOnly === true;

    if (!isInVoiceChannel(message.member)) {
        return message.reply({ embeds: [createErrorEmbed(config.MESSAGES.NO_VOICE_CHANNEL)] });
    }

    if (!canUsePlayback(message, client, player.getQueue(message.guild.id))) return;

    if (!args.length) {
        const queue = player.getQueue(message.guild.id);
        if (queue && queue.currentTrack) {
            // Snapshot only: never replace the canonical live player message,
            // otherwise the old message freezes while this copy starts updating.
            return message.reply(await createNowPlayingPayload(queue.currentTrack, queue, { commitVisual: false }));
        }
        return message.reply({ embeds: [createErrorEmbed("اكتب اسم الأغنية أو رابطها\nمثال: `ش illenium alive` أو `اضف illenium alive`")] });
    }

    const query = args.join(" ").trim();
    // لا رسالة وسيطة أثناء البحث؛ النتيجة/الخطأ يظهران مباشرة عند الجاهزية.
    const searchMsg = null;
    const replacesPlayback = forceNow || (!queueOnly && config.PLAY_COMMAND_REPLACES_CURRENT !== false);
    const command = {};
    let commandQueue = player.getQueue(message.guild.id);
    let stopGeneration = Number(commandQueue?._stopGeneration || 0);
    const observeQueue = queue => {
        if (!commandQueue && queue) { commandQueue = queue; stopGeneration = Number(queue._stopGeneration || 0); }
    };
    let pendingCommands;
    if (replacesPlayback) {
        pendingCommands = pendingPlayCommands.get(player);
        if (!pendingCommands) { pendingCommands = new Map(); pendingPlayCommands.set(player, pendingCommands); }
        pendingCommands.set(message.guild.id, command);
    }
    const commandCurrent = () => !player.closed && !client?.fleet?._closed && getPlayer(client) === player
        && (!pendingCommands || pendingCommands.get(message.guild.id) === command)
        && (!commandQueue || (player.getQueue(message.guild.id) === commandQueue && Number(commandQueue._stopGeneration || 0) === stopGeneration));

    try {
        const searchLimit = isUrl(query) ? (config.YTDLP_PLAYLIST_LIMIT || 100) : 1;
        const results = await player.search(query, { limit: searchLimit });
        if (!commandCurrent()) return;
        if (!canUsePlayback(message, client, player.getQueue(message.guild.id))) return;
        if (!results || results.length === 0) return reactQuietly(message, '❌');

        const queue = await ensureQueue(message, client, searchMsg, commandCurrent, observeQueue);
        if (!commandCurrent() || player.getQueue(message.guild.id) !== queue) return;
        if (!canUsePlayback(message, client, queue)) return;
        if (!client?.fleet || !queue.textChannel) queue.textChannel = message.channel;
        const selected = selectTracks(query, results);
        const tracks = selected.map(t => ({ ...t, requester: message.author.tag, requesterId: message.author.id }));

        const active = player.hasActivePlayback(queue);

        if (forceNow || (!queueOnly && config.PLAY_COMMAND_REPLACES_CURRENT !== false && active)) {
            player.stopPlayback(queue, true, { preserveNowPlayingMessage: true });
            stopGeneration = Number(queue._stopGeneration || 0);
            queue.tracks = [];
            queue.currentIndex = 0;
        }

        if (active && !forceNow && (queueOnly || config.PLAY_COMMAND_REPLACES_CURRENT === false)) {
            const { startIndex, added } = player.addTracks(queue, tracks);
            if (!added.length) {
                const payload = { embeds: [createErrorEmbed(`القائمة ممتلئة. الحد الحالي: ${config.MAX_QUEUE_SIZE} أغنية.`)], components: [] };
                return searchMsg ? searchMsg.edit(payload) : message.reply(payload);
            }
            if (!commandCurrent() || player.getQueue(message.guild.id) !== queue || queue._intentionalDestroy
                || !canUsePlayback(message, client, queue) || !added.every(track => queue.tracks.includes(track))) return;
            // Progress/artwork updates are auxiliary. Don't hold a successful
            // queue request open on a Discord edit to the now-playing card.
            Promise.resolve(player.refreshNowPlayingMessage(queue, true))
                .catch(error => console.warn('[Play queue card refresh]', error?.message || error));
            const embed = createQueueAddedEmbed(added, queue, startIndex);
            return searchMsg
                ? searchMsg.edit({ embeds: [embed], components: [] }).catch(async error => {
                    console.warn('[Play queue confirmation]', error?.message || error);
                    await reactQuietly(message, '✅');
                    return null;
                })
                : replyToQueuedRequest(message, { embeds: [embed] });
        }

        // لا توجد أغنية فعالة: ابدأ فوراً من أول نتيجة، وأضف البقية كقائمة.
        if (!active) {
            queue.tracks = [];
            queue.currentIndex = 0;
        }

        const { startIndex, added } = player.addTracks(queue, tracks);
        if (!added.length) {
            const payload = { embeds: [createErrorEmbed(`القائمة ممتلئة. الحد الحالي: ${config.MAX_QUEUE_SIZE} أغنية.`)], components: [] };
            return searchMsg ? searchMsg.edit(payload) : message.reply(payload);
        }

        queue.currentIndex = startIndex;
        const firstTrack = queue.tracks[queue.currentIndex];
        const work = player.play(queue, firstTrack, 0);
        const requestToken = queue._playRequestToken;
        const current = () => commandCurrent() && !queue._intentionalDestroy && player.getQueue(message.guild.id) === queue
            && (!client?.player || client.player === player) && queue._playRequestToken === requestToken
            && queue.currentTrack === firstTrack && canUsePlayback(message, client, queue);
        const started = await work;
        // An older cancelled command never rolls back the new queue or posts
        // the old source's failure beneath a newer successful request.
        if (!current()) return;
        if (!started) {
            queue.tracks.splice(startIndex, added.length);
            queue._queueRevision = Number(queue._queueRevision || 0) + 1;
            queue.currentIndex = Math.max(0, Math.min(queue.currentIndex, queue.tracks.length - 1));
            return reactQuietly(message, '❌');
        }

        const msg = await player.syncNowPlayingMessage(queue, firstTrack);

        if (!current()) return;
        if (added.length > 1) {
            message.channel.send({ embeds: [createSuccessEmbed("تم تحميل القائمة", `تم تجهيز **${added.length}** أغنية. بدأت الأولى الآن والباقي في الانتظار.`)] }).catch(() => {});
        }
        return msg;

    } catch (err) {
        if (!commandCurrent()) return;
        if (err?.__alreadyReported) return;
        console.error("خطأ في أمر الشغل:", err.message || err);
        return reactQuietly(message, '❌');
    } finally {
        if (pendingCommands?.get(message.guild.id) === command) pendingCommands.delete(message.guild.id);
    }
}

module.exports = {
    _player: player,
    _playQuery: playQuery,

    name: "ش",
    aliases: ["شغل", "play", "p", "تشغيل"],
    description: "تشغيل أغنية أو إضافتها للقائمة إذا كانت هناك أغنية تعمل",
    usage: "ش [اسم الأغنية أو رابط]",

    async execute(message, args, client) {
        return playQuery(message, args, client, { forceNow: false });
    },
};
