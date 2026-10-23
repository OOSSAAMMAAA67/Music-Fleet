'use strict';
const { ownerTarget, ownerAction } = require('../utils/ownerControl');
module.exports = {
    name: 'اخرج', aliases: ['فصل', 'leave', 'disconnect', 'dc'], ownerOnly: true, fleetControl: true,
    description: 'إخراج بوت وإلغاء تثبيته في السيرفر (للأونر)', usage: 'اخرج @bot',
    execute(message, args, client) { return ownerAction(message, client, () => client.fleet.release(ownerTarget(message, args, client).key, message.guild.id)); },
};
