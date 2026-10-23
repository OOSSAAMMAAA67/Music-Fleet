const { getPlayer } = require("../utils/playerContext");
module.exports = {
    name: "guildDelete",
    async execute(guild, client) {
        try {
            const player = getPlayer(client);
            player?.deleteQueue?.(guild.id);
        } catch (_) {}
        try { client.queues?.delete?.(guild.id); } catch (_) {}
        try { client.prefixes?.delete?.(guild.id); } catch (_) {}
    },
};
