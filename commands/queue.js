const { createQueueEmbed, createErrorEmbed } = require("../utils/embed");
const config = require("../config");

const { getPlayer } = require("../utils/playerContext");

module.exports = {
    name: "قائمة",
    aliases: ["طابور", "queue", "q", "list"],
    description: "عرض قائمة التشغيل",
    usage: "قائمة [رقم الصفحة]",

    async execute(message, args, client) {
        const player = getPlayer(client);
        const queue = player.getQueue(message.guild.id);

        if (!queue || queue.tracks.length === 0) {
            return message.reply({ embeds: [createErrorEmbed(config.MESSAGES.QUEUE_EMPTY)] });
        }

        const page = parseInt(args[0]) || 1;
        const itemsPerPage = Number(config.QUEUE_PAGE_SIZE || 8);
        const totalPages = Math.max(1, Math.ceil(queue.tracks.length / itemsPerPage));

        if (page < 1 || page > totalPages) {
            return message.reply({ embeds: [createErrorEmbed(`رقم الصفحة يجب أن يكون بين 1 و ${totalPages}`)] });
        }

        return message.reply({ embeds: [createQueueEmbed(queue, page)] });
    },
};
