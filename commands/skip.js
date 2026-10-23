const { reactQuietly } = require('../utils/quietControl');
const { skipPlayback } = require('../utils/skipControl');

const { getPlayer } = require("../utils/playerContext");

module.exports = {
    name: "تخطى",
    aliases: ["سكيب", "سكب", "skip", "next", "التالي", "س", "s"],
    description: "تخطي الأغنية الحالية",
    usage: "تخطى",

    async execute(message, args, client) {
        const player = getPlayer(client);
        const queue = player.getQueue(message.guild.id);

        if (!queue?.currentTrack) {
            return reactQuietly(message, '❌');
        }

        const outcome = await skipPlayback(queue, player, client, message.guild.id);
        return reactQuietly(message, outcome.unavailable ? '❌' : '✅');
    },
};
