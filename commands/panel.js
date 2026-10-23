const { createControlPanel, createErrorEmbed } = require("../utils/embed");
const config = require("../config");

const { getPlayer } = require("../utils/playerContext");

module.exports = {
    name: "لوحة",
    aliases: ["panel", "control", "تحكم", "cp"],
    description: "عرض لوحة التحكم الكاملة مع الأزرار التفاعلية",
    usage: "لوحة",

    async execute(message, args, client) {
        const player = getPlayer(client);
        const queue = player.getQueue(message.guild.id);

        if (!queue || !queue.playing || !queue.currentTrack) {
            return message.reply({ embeds: [createErrorEmbed(config.MESSAGES.NO_MUSIC)] });
        }

        return message.reply(createControlPanel(queue.currentTrack, queue));
    },
};
