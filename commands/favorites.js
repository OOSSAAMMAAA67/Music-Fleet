const {
    createFavoritesLauncherMessage,
    createFavoriteSavedEmbed,
    createSuccessEmbed,
    createErrorEmbed,
} = require("../utils/embed");
const favorites = require("../utils/favoritesStore");

function currentQueue(message) {
    try { return require("./play")._player.getQueue(message.guild.id); } catch (_) { return null; }
}

module.exports = {
    name: "مفضلة",
    aliases: ["مفضلتي", "المفضلة", "fav", "favs", "favorites", "favorite", "playlistme"],
    description: "فتح مكتبتك الموسيقية الخاصة أو إدارة الأغاني المحفوظة",
    usage: "مفضلة | مفضلة اضف | مفضلة حذف 3 | مفضلة مسح",

    async execute(message, args, client) {
        const sub = String(args[0] || "").trim().toLowerCase();

        if (["اضف", "أضف", "add", "save", "احفظ", "حفظ"].includes(sub)) {
            const queue = currentQueue(message);
            if (!queue?.currentTrack) return message.reply({ embeds: [createErrorEmbed("لا توجد أغنية تعمل حالياً لحفظها.")] });
            const result = favorites.add(message.author, queue.currentTrack);
            return message.reply({ embeds: [createFavoriteSavedEmbed(result)] });
        }

        if (["حذف", "remove", "delete", "del"].includes(sub)) {
            const index = Number(args[1]) - 1;
            const removed = favorites.remove(message.author, index);
            if (!removed) return message.reply({ embeds: [createErrorEmbed("اكتب رقم صحيح من مفضلتك. مثال: `مفضلة حذف 3`")] });
            return message.reply({ embeds: [createSuccessEmbed("تم الحذف", `تم حذف **${removed.title.substring(0, 80)}** من مفضلتك الخاصة.`)] });
        }

        if (["مسح", "clear", "reset"].includes(sub)) {
            const count = favorites.clear(message.author);
            return message.reply({ embeds: [createSuccessEmbed("تم مسح المفضلة", `تم حذف **${count}** أغنية من مفضلتك الخاصة.`)] });
        }

        return message.reply(createFavoritesLauncherMessage(message.author));
    },
};
