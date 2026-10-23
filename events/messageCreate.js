const config = require("../config");
const { createErrorEmbed } = require("../utils/embed");
const { installSafeReply } = require("../utils/discordSafety");
const { shouldHandleMessage, canUsePlayback } = require("../utils/fleetRouting");
const { runWithClient } = require("../utils/playerContext");
const { isOwner, isRootOwner } = require("../utils/permissions");
const { reactQuietly } = require("../utils/quietControl");

module.exports = {
    name: "messageCreate",
    async execute(message, client) {
        if (message.author.bot || !message.guild) return;
        installSafeReply(message);
        if (config.ALLOWED_GUILD_IDS.length > 0 && !config.ALLOWED_GUILD_IDS.includes(message.guild.id)) return;

        const guildPrefix = client.prefixes.get(message.guild.id) || config.PREFIX;
        const content = message.content.trim();
        if (!client.fleet && config.TEXT_CHANNEL_LOCK && message.channel.id !== config.TEXT_CHANNEL_LOCK) return;

        let args, commandName;
        let usedPrefix = content.startsWith(guildPrefix) ? guildPrefix : null;

        if (usedPrefix !== null) {
            args = content.slice(usedPrefix.length).trim().split(/\s+/);
            commandName = args.shift().toLowerCase();
        } else {
            const firstWord = content.split(/\s+/)[0].toLowerCase();
            if (client.commands.has(firstWord) || client.aliases.has(firstWord)) {
                args = content.split(/\s+/);
                commandName = args.shift().toLowerCase();
            } else {
                return;
            }
        }

        if (!commandName) return;

        let command = client.commands.get(commandName);
        if (!command) {
            const aliasName = client.aliases.get(commandName);
            if (aliasName) command = client.commands.get(aliasName);
        }
        if (!command) return;

        if (command.rootOwnerOnly && !isRootOwner(message.author.id, client)) return;
        if (command.ownerOnly && !(client.fleet ? client.fleet.isOwner(message.author.id) : isOwner(message.author.id, client))) return;
        if (!shouldHandleMessage(message, client, command)) return;
        // Wrong voice/text-room commands are ignored without a public reaction.
        if (command.requiresAssignedVoice && !command.fleetControl && !canUsePlayback(message, client)) return;
        if (client.fleet && !command.ownerOnly) {
            const limitKey = String(message.guild.id) + ':' + String(message.author.id);
            const now = Date.now();
            const recent = client.fleet._messageRates ||= new Map();
            if (now - (recent.get(limitKey) || 0) < Math.max(0, Number(config.FLEET_COMMAND_COOLDOWN_MS ?? 400))) return;
            recent.delete(limitKey); recent.set(limitKey, now);
            while (recent.size > 10000) recent.delete(recent.keys().next().value);
        }
        args = args.filter(arg => !/^<@!?\d+>$/.test(arg));

        try {
            await runWithClient(client, () => command.execute(message, args, client));
        } catch (err) {
            console.error('خطأ في الأمر ' + commandName + ':', err.message);
            if (command.ownerOnly || config.FLEET_QUIET_ERRORS !== false) return reactQuietly(message, '❌');
            message.reply({ embeds: [createErrorEmbed("حدث خطأ غير متوقع!")] }).catch(() => {});
        }
    },
};
