const { createErrorEmbed } = require("../utils/embed");
const config = require("../config");
const { reactQuietly, runQuietPlayback } = require('../utils/quietControl');

const { getPlayer } = require("../utils/playerContext");

module.exports = {
    name: "اعد",
    aliases: ["replay", "restart_song", "من_البداية"],
    description: "إعادة تشغيل الأغنية الحالية من البداية",
    usage: "اعد",

    async execute(message, args, client) {
        const player = getPlayer(client);
        const queue = player.getQueue(message.guild.id);
        if (!queue || !queue.playing || !queue.currentTrack) {
            return message.reply({ embeds: [createErrorEmbed(config.MESSAGES.NO_MUSIC)] });
        }

        const track = queue.currentTrack;
        const result = await runQuietPlayback(message, client, player, queue, track, 0);
        if (!result.started) return;
        await player.syncNowPlayingMessage(queue, track);
        if (result.current()) return reactQuietly(message);
    },
};
