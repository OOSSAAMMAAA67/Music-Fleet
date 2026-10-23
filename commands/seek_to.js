const { createSuccessEmbed, createErrorEmbed } = require("../utils/embed");
const { MusicPlayer } = require("../utils/musicPlayer");
const config = require("../config");

const { getPlayer } = require("../utils/playerContext");
const { reactQuietly, runQuietPlayback } = require('../utils/quietControl');

module.exports = {
    name: "انتقل",
    aliases: ["seekto", "goto", "اذهب"],
    description: "الانتقال لوقت معين في الأغنية (بالثواني أو بالصيغة m:ss)",
    usage: "انتقل [وقت] — مثال: انتقل 90 أو انتقل 1:30",

    async execute(message, args, client) {
        const player = getPlayer(client);
        const queue = player.getQueue(message.guild.id);
        if (!queue || !queue.playing || !queue.currentTrack) {
            return message.reply({ embeds: [createErrorEmbed(config.MESSAGES.NO_MUSIC)] });
        }

        if (!args[0]) return message.reply({ embeds: [createErrorEmbed("اكتب الوقت\nمثال: `انتقل 90` أو `انتقل 1:30`")] });

        let seekSeconds;
        if (args[0].includes(":")) {
            const [m, s] = args[0].split(":").map(Number);
            seekSeconds = m * 60 + (s || 0);
        } else {
            seekSeconds = parseInt(args[0]);
        }

        if (isNaN(seekSeconds) || seekSeconds < 0) {
            return message.reply({ embeds: [createErrorEmbed("وقت غير صحيح! مثال: `انتقل 90` أو `انتقل 1:30`")] });
        }

        if (seekSeconds >= queue.currentTrack.duration) {
            return message.reply({ embeds: [createErrorEmbed(`الوقت أكبر من مدة الأغنية (${MusicPlayer.formatDuration(queue.currentTrack.duration)})`)] });
        }

        const result = await runQuietPlayback(message, client, player, queue, queue.currentTrack, seekSeconds);
        if (!result.started) return;
        await player.refreshNowPlayingMessage(queue, true);
        if (result.current()) return reactQuietly(message);
    },
};
