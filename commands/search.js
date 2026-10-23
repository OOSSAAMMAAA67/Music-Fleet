const { createSearchEmbed, createErrorEmbed, createQueueAddedEmbed } = require("../utils/embed");
const config = require("../config");

const { getPlayer } = require("../utils/playerContext");
const { canUsePlayback } = require('../utils/fleetRouting');
const { reactQuietly, currentPlaybackRequest } = require('../utils/quietControl');

module.exports = {
    name: "بحث",
    aliases: ["search", "find", "ابحث"],
    description: "البحث عن أغنية واختيار من النتائج وإضافتها للقائمة",
    usage: "بحث [اسم الأغنية]",

    async execute(message, args, client) {
        if (!message.member.voice.channel) {
            return message.reply({ embeds: [createErrorEmbed(config.MESSAGES.NO_VOICE_CHANNEL)] });
        }
        if (!args.length) return message.reply({ embeds: [createErrorEmbed("اكتب اسم الأغنية للبحث") ] });

        const player = getPlayer(client);
        const currentPlayer = () => !player.closed && !client?.fleet?._closed && getPlayer(client) === player;
        const query = args.join(" ");

        // ابحث أولاً ثم أرسل النتائج مباشرة: لا نرسل رسالة "جاري البحث" مزعجة.
        let results;
        try { results = await player.search(query); }
        catch (error) {
            if (!currentPlayer()) return;
            console.error('[Search]', error.message || error);
            return reactQuietly(message, '❌');
        }
        if (!currentPlayer()) return;
        if (!canUsePlayback(message, client, player.getQueue(message.guild.id))) return;
        if (!results || !results.length) {
            return message.reply({ embeds: [createErrorEmbed("لم يتم العثور على نتائج")], components: [] });
        }

        const top5 = results.slice(0, 5);
        const searchMsg = await message.reply({ embeds: [createSearchEmbed(top5)], components: [] });
        if (!currentPlayer()) return;

        const filter = m => m.author.id === message.author.id && (m.content.trim().toLowerCase() === "cancel" || ["إلغاء", "الغاء"].includes(m.content.trim()) || (!isNaN(parseInt(m.content)) && parseInt(m.content) >= 1 && parseInt(m.content) <= top5.length));
        const collector = message.channel.createMessageCollector({ filter, time: 30000, max: 1 });

        collector.on("collect", async (m) => {
            if (!currentPlayer()) return;
            if (!canUsePlayback(message, client, player.getQueue(message.guild.id))) return;
            if (["إلغاء", "الغاء", "cancel"].includes(m.content.trim().toLowerCase())) {
                return searchMsg.edit({ embeds: [createErrorEmbed("تم إلغاء البحث")], components: [] }).catch(() => {});
            }

            const choice = parseInt(m.content.trim()) - 1;
            const track = { ...top5[choice], requester: message.author.tag, requesterId: message.author.id };
            let queue = player.getQueue(message.guild.id);
            let stopGeneration = Number(queue?._stopGeneration || 0);
            let playbackCurrent;
            const ownedQueue = () => currentPlayer() && queue && !queue._intentionalDestroy
                && player.getQueue(message.guild.id) === queue && Number(queue._stopGeneration || 0) === stopGeneration
                && canUsePlayback(message, client, queue);
            const failedSelection = () => searchMsg.edit({ embeds: [createErrorEmbed('تعذر تشغيل هذه الأغنية الآن. جرّب نتيجة أخرى.')], components: [] }).catch(() => {});

            try {
                if (!queue || !queue.connection || queue.connection.state?.status === "destroyed") {
                    const joining = player.join(message.member.voice.channel, message.channel);
                    const joiningQueue = player.getQueue(message.guild.id);
                    if (!queue && joiningQueue) { queue = joiningQueue; stopGeneration = Number(queue._stopGeneration || 0); }
                    queue = await joining;
                    if (!ownedQueue()) return;
                    client.queues.set(message.guild.id, queue);
                }
                if (!ownedQueue()) return;
                if (!client?.fleet || !queue.textChannel) queue.textChannel = message.channel;

                const active = player.hasActivePlayback(queue);
                if (active && config.PLAY_COMMAND_REPLACES_CURRENT === false) {
                    const { startIndex, added } = player.addTracks(queue, [track]);
                    if (!added.length) return failedSelection();
                    await player.refreshNowPlayingMessage(queue, true);
                    if (!ownedQueue() || !added.every(track => queue.tracks.includes(track))) return;
                    await searchMsg.edit({ embeds: [createQueueAddedEmbed(added, queue, startIndex)], components: [] });
                    try { await m.delete(); } catch (_) {}
                    return;
                }

                queue.tracks = [];
                queue.currentIndex = 0;
                const { added } = player.addTracks(queue, [track]);
                if (!added.length) return failedSelection();
                const firstTrack = added[0];
                const work = player.play(queue, firstTrack, 0);
                const requestToken = queue._playRequestToken;
                playbackCurrent = () => ownedQueue() && currentPlaybackRequest(message, client, player, queue, firstTrack, requestToken);
                let started;
                try { started = await work; }
                catch (error) { if (playbackCurrent()) console.error('[Search playback]', error.message || error); }
                if (!playbackCurrent()) return;
                if (!started) {
                    for (const failed of added) { const index = queue.tracks.indexOf(failed); if (index >= 0) queue.tracks.splice(index, 1); }
                    queue._queueRevision = Number(queue._queueRevision || 0) + 1;
                    queue.currentIndex = Math.max(0, Math.min(queue.currentIndex, queue.tracks.length - 1));
                    return failedSelection();
                }

                await player.syncNowPlayingMessage(queue, firstTrack);
                if (!playbackCurrent()) return;
                await searchMsg.delete().catch(() => {});
                try { await m.delete(); } catch (_) {}
            } catch (err) {
                if (!ownedQueue() || (playbackCurrent && !playbackCurrent())) return;
                console.error("خطأ في أمر البحث:", err.message || err);
                await failedSelection().catch(() => {});
            }
        });

        collector.on("end", (col, reason) => {
            if (reason === "time") searchMsg.edit({ embeds: [createErrorEmbed("انتهى وقت الاختيار (30 ثانية)")], components: [] }).catch(() => {});
        });
    },
};
