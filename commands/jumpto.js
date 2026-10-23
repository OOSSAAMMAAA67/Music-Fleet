const { createErrorEmbed, createSuccessEmbed } = require("../utils/embed");
const config = require("../config");

const { getPlayer } = require("../utils/playerContext");
const { reactQuietly, runQuietPlayback } = require('../utils/quietControl');

module.exports = {
    name: "تخطى_لـ",
    aliases: ["jumpto", "skipto", "jump"],
    description: "القفز لأغنية معينة في القائمة",
    usage: "تخطى_لـ [رقم]",

    async execute(message, args, client) {
        const player = getPlayer(client);
        const queue = player.getQueue(message.guild.id);
        if (!queue || !queue.playing) return message.reply({ embeds: [createErrorEmbed(config.MESSAGES.NO_MUSIC)] });

        const num = parseInt(args[0]);
        if (isNaN(num) || num < 1 || num > queue.tracks.length) {
            return message.reply({ embeds: [createErrorEmbed(`رقم غير صحيح! القائمة تحتوي على ${queue.tracks.length} أغنية`)] });
        }

        const previousIndex = queue.currentIndex;
        queue.currentIndex = num - 1;
        const track = queue.tracks[queue.currentIndex];
        const result = await runQuietPlayback(message, client, player, queue, track, 0, () => { queue.currentIndex = previousIndex; });
        if (!result.started) return;

        await player.syncNowPlayingMessage(queue, track);
        if (result.current()) return reactQuietly(message);
    },
};
