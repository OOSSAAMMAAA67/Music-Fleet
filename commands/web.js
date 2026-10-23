'use strict';
const { reactQuietly } = require('../utils/quietControl');
module.exports = {
    name: 'ويب', aliases: ['web', 'website', 'الواجهة'], description: 'إرسال رابط واجهتك الموسيقية الخاصة في الخاص', usage: 'ويب',
    async execute(message, args, client) {
        try {
            const url = require('../utils/webPlayerServer').createSessionUrl(message.author.id, message.guild.id, 'player', client.botKey);
            await message.author.send({ content: url });
            return reactQuietly(message);
        } catch (_) { return reactQuietly(message, '❌'); }
    },
};
