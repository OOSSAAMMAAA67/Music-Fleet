'use strict';
const { isOwner } = require('../utils/permissions');
const { ownerAction } = require('../utils/ownerControl');
module.exports = {
    name: 'اونر', aliases: ['owner', 'owners', 'الأونر', 'الاونر'], ownerOnly: true, rootOwnerOnly: true, fleetControl: true,
    description: 'عرض الأونرات أو إضافة/حذف أونر مفوض بواسطة المالك الأساسي', usage: 'owners [add|remove] @user',
    async execute(message, args, client) {
        if (!isOwner(message.author.id, client)) return;
        const action = String(args[0] || '').toLowerCase();
        if (!['اضف', 'أضف', 'add', 'حذف', 'remove', 'del'].includes(action)) {
            const owners = [...new Set([...(client.fleet.rootOwnerIds || []), ...client.fleet.state.listOwners()])];
            return message.reply({ content: owners.map(id => `<@${id}>`).join(' · ') || 'لا يوجد أونر', allowedMentions: { parse: [] } });
        }
        if (!client.fleet.isRootOwner(message.author.id)) return;
        const id = [...(message.mentions?.users?.values?.() || [])].find(user => !client.fleet.recordFor(user.id))?.id || args[1]?.replace(/[<@!>]/g, '');
        return ownerAction(message, client, () => ['اضف', 'أضف', 'add'].includes(action) ? client.fleet.state.addOwner(id) : client.fleet.state.removeOwner(id));
    },
};
