const { createErrorEmbed } = require("../utils/embed");
const config = require("../config");
const { reactQuietly, runQuietPlayback } = require('../utils/quietControl');

const { getPlayer } = require("../utils/playerContext");

module.exports = {
    name: "السابق",
    aliases: ["previous", "prev", "back", "رجع_اغنية"],
    description: "العودة للأغنية السابقة في القائمة",
    usage: "السابق",

    async execute(message, args, client) {
        const player = getPlayer(client);
        const queue = player.getQueue(message.guild.id);
        if (!queue || !queue.playing) return message.reply({ embeds: [createErrorEmbed(config.MESSAGES.NO_MUSIC)] });

        if (queue.currentIndex <= 0) {
            return message.reply({ embeds: [createErrorEmbed("لا توجد أغنية سابقة في القائمة!")] });
        }

        const previousIndex = queue.currentIndex;
        queue.currentIndex--;
        const track = queue.tracks[queue.currentIndex];
        const result = await runQuietPlayback(message, client, player, queue, track, 0, () => { queue.currentIndex = previousIndex; });
        if (!result.started) return;

        await player.syncNowPlayingMessage(queue, track);
        if (result.current()) return reactQuietly(message);
    },
};
