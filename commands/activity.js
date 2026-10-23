'use strict';

const { isOwner } = require('../utils/permissions');
const activity = require('../utils/activityManager');

module.exports = {
    name: 'activity',
    aliases: ['setactivity', 'activityall', 'presence'],
    ownerOnly: true,
    fleetControl: true,
    description: 'تغيير نشاط جميع البوتات أو إزالته (للأونر)',
    usage: 'activity <النشاط|off>',
    async execute(message, args, client) {
        if (!isOwner(message.author.id, client)) return;
        const value = args.join(' ').trim();
        const target = client.fleet || client;
        if (!value) {
            const saved = activity.get();
            return message.reply({
                content: saved.enabled ? `النشاط الحالي لكل البوتات: **${saved.text}**` : 'النشاط معطل حالياً لكل البوتات.',
                allowedMentions: { parse: [] },
            });
        }

        try {
            const remove = /^(off|clear|remove|disable|none)$/i.test(value);
            const result = remove ? await activity.clear(target) : await activity.setText(value, target);
            const description = remove
                ? 'تمت إزالة النشاط من البوتات المتصلة.'
                : `تم ضبط نشاط البوتات على **${result.preference.text}**.`;
            const pending = result.targetCount - result.appliedCount;
            return message.reply({
                content: `${description} (${result.appliedCount}/${result.targetCount} حالياً${pending > 0 ? '؛ ويُطبّق على غير المتصل عند عودته' : ''}).`,
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            console.warn('[activity] Could not update fleet presence:', error.message);
            return message.reply({ content: 'تعذر حفظ النشاط أو تطبيقه الآن.', allowedMentions: { parse: [] } });
        }
    },
};
