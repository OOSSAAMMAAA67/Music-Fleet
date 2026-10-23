'use strict';
const config = require('../config');
const { isOwner } = require('../utils/permissions');
const { ownerAction } = require('../utils/ownerControl');
module.exports = {
    name: 'بريفكس', aliases: ['prefix', 'setprefix'], ownerOnly: true, fleetControl: true,
    description: 'تغيير بريفكس جميع البوتات في السيرفر وحفظه', usage: 'بريفكس [prefix]',
    async execute(message, args, client) {
        if (!isOwner(message.author.id, client)) return;
        if (!args[0]) return message.reply({ content: client.prefixes.get(message.guild.id) || config.PREFIX });
        return ownerAction(message, client, async () => {
            const prefix = args[0].slice(0, 5);
            await client.fleet.state.setPrefix(message.guild.id, prefix);
            for (const record of client.fleet.records.values()) record.client.prefixes.set(message.guild.id, prefix);
        });
    },
};
