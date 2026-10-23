const { createErrorEmbed } = require("../utils/embed");
const config = require("../config");
const { reactQuietly, runQuietPlayback } = require('../utils/quietControl');

const { getPlayer } = require("../utils/playerContext");

module.exports = {
    name: "رجع",
    aliases: ["rewind", "backward", "رجوع"],
    description: `رجوع الأغنية ${config.SEEK_SECONDS} ثانية للخلف`,
    usage: "رجع",

    async execute(message, args, client) {
        const player = getPlayer(client);
        const queue = player.getQueue(message.guild.id);

        if (!queue || !queue.playing || !queue.currentTrack) {
            return message.reply({ embeds: [createErrorEmbed(config.MESSAGES.NO_MUSIC)] });
        }

        const elapsed = Math.max(0, queue.getElapsedPrecise?.() ?? queue.getElapsed?.() ?? 0);
        const seekTo = Math.max(0, elapsed - config.SEEK_SECONDS);

        const result = await runQuietPlayback(message, client, player, queue, queue.currentTrack, seekTo);
        if (!result.started) return;
        await player.refreshNowPlayingMessage(queue, true);

        if (result.current()) return reactQuietly(message);
    },
};
