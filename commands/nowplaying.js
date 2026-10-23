const { createNowPlayingPayload, createErrorEmbed } = require("../utils/embed");
const config = require("../config");

const { getPlayer } = require("../utils/playerContext");

module.exports = {
    name: "ماشغل",
    aliases: ["الان", "الآن", "nowplaying", "np", "current"],
    description: "عرض الأغنية التي تعزف الآن",
    usage: "ماشغل",

    async execute(message, args, client) {
        const player = getPlayer(client);
        const queue = player.getQueue(message.guild.id);
        if (!queue || !queue.playing || !queue.currentTrack) {
            return message.reply({ embeds: [createErrorEmbed(config.MESSAGES.NO_MUSIC)] });
        }

        // This command shows a snapshot. It must not become the canonical
        // progress-updated message or the original player would freeze.
        return message.reply(await createNowPlayingPayload(queue.currentTrack, queue, { commitVisual: false }));
    },
};
