'use strict';
const { ownerTarget, voiceDestination, ownerAction } = require('../utils/ownerControl');
module.exports = {
    name: 'الحق', aliases: ['تعال', 'join', 'connect', 'انضم'], ownerOnly: true, fleetControl: true,
    description: 'تثبيت بوت في روم صوتي أو نقله إلى روم آخر (للأونر)', usage: 'تعال @bot [voice-channel-id]',
    execute(message, args, client) {
        return ownerAction(message, client, async () => {
            const target = ownerTarget(message, args, client);
            const voiceId = voiceDestination(message, args, client.fleet);
            if (!voiceId) throw new Error('Use the voice room chat, a voice ID, or join a room.');
            await client.fleet.place(target.key, message.guild.id, voiceId, message.channel.id);
        });
    },
};
