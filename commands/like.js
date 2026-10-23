const { createFavoriteSavedEmbed, createErrorEmbed } = require("../utils/embed");
const favorites = require("../utils/favoritesStore");

module.exports = {
    name: "احبها",
    aliases: ["حفظ", "لايك", "قلب", "like", "heart", "save"],
    description: "حفظ الأغنية الحالية في مفضلتك الخاصة",
    usage: "احبها",

    async execute(message) {
        const player = require("./play")._player;
        const queue = player.getQueue(message.guild.id);
        if (!queue?.currentTrack) return message.reply({ embeds: [createErrorEmbed("لا توجد أغنية تعمل حالياً لحفظها.")] });
        const result = favorites.add(message.author, queue.currentTrack);
        return message.reply({ embeds: [createFavoriteSavedEmbed(result)] });
    },
};
