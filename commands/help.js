const { createHelpEmbed } = require("../utils/embed");

module.exports = {
    name: "help",
    aliases: ["مساعدة", "اوامر", "أوامر", "h"],
    description: "عرض قائمة جميع الأوامر",
    usage: "-help",

    async execute(message, args, client) {
        return message.reply({ embeds: [createHelpEmbed(client, client.prefixes?.get(message.guild.id), message.author.id)], allowedMentions: { parse: [] } });
    },
};
