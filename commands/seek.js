const { createErrorEmbed } = require("../utils/embed");
const config = require("../config");
const { reactQuietly, runQuietPlayback } = require('../utils/quietControl');

const { getPlayer } = require("../utils/playerContext");

module.exports = {
    name: "قدم",
    aliases: ["forward", "تقديم"],
    description: `تقديم الأغنية ${config.SEEK_SECONDS} ثانية للأمام`,
    usage: "قدم",

    async execute(message, args, client) {
        const player = getPlayer(client);
        const queue = player.getQueue(message.guild.id);

        if (!queue || !queue.playing || !queue.currentTrack) {
            return message.reply({ embeds: [createErrorEmbed(config.MESSAGES.NO_MUSIC)] });
        }

        // ─── حساب الوقت المنقضي مع مراعاة الإيقاف المؤقت ─
        const elapsed = Math.max(0, queue.getElapsedPrecise?.() ?? queue.getElapsed?.() ?? 0);

        const duration = queue.currentTrack.duration || 0;
        const seekTo = duration > 0
            ? Math.min(elapsed + config.SEEK_SECONDS, duration - 5)
            : elapsed + config.SEEK_SECONDS;

        const result = await runQuietPlayback(message, client, player, queue, queue.currentTrack, seekTo);
        if (!result.started) return;
        await player.refreshNowPlayingMessage(queue, true);

        if (result.current()) return reactQuietly(message);
    },
};
