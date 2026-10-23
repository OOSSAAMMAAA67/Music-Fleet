'use strict';
const { ownerTarget, ownerAction } = require('../utils/ownerControl');
module.exports = {
    name: 'اصلاح', aliases: ['إصلاح', 'repair', 'fixbot'], ownerOnly: true, fleetControl: true,
    description: 'إصلاح اتصال بوت واحد مع بقاء البوتات الأخرى تعمل', usage: 'اصلاح @bot',
    execute(message, args, client) { return ownerAction(message, client, () => client.fleet.repairBot(ownerTarget(message, args, client).key)); },
};
