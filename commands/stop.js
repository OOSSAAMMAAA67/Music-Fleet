const { createSuccessEmbed, createErrorEmbed } = require("../utils/embed");
const config = require("../config");

const { getPlayer } = require("../utils/playerContext");
const { reactQuietly } = require('../utils/quietControl');

module.exports = {
    name: "وقف",
    aliases: ["ايقاف", "إيقاف", "stop", "ق", "q"],
    description: "إيقاف الموسيقى ومسح القائمة مع إبقاء البوت مثبتاً في الروم",
    usage: "وقف",

    async execute(message, args, client) {
        const player = getPlayer(client);
        const queue = player.getQueue(message.guild.id);

        if (!queue) {
            return message.reply({ embeds: [createErrorEmbed(config.MESSAGES.NO_MUSIC)] });
        }

        player.stopPlayback(queue, true);
        client.queues.set(message.guild.id, queue);

        return reactQuietly(message);
    },
};
