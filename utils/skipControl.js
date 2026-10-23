'use strict';
const { createSuccessEmbed } = require('./embed');

async function skipPlayback(queue, player, client, guildId, fallbackPublicMessage = null) {
    const title = String(queue.currentTrack?.title || 'الأغنية الحالية').slice(0, 80);
    if (queue.currentIndex + 1 >= queue.tracks.length && !queue.loopQueue) {
        const publicMessage = queue.nowPlayingMessage || fallbackPublicMessage;
        player.stopPlayback(queue, true, { endReason: 'skip' });
        client.queues.set(guildId, queue);
        const stoppedPayload = {
            embeds: [createSuccessEmbed('توقف', `لا توجد أغنية تالية بعد **${title}**. تم إيقاف الأغنية ومسح القائمة.`)],
            components: [],
            attachments: [],
        };
        if (publicMessage) {
            try {
                if (player.editNowPlayingMessage) {
                    await player.editNowPlayingMessage(queue, stoppedPayload, { message: publicMessage, allowStale: true });
                } else {
                    await publicMessage.edit(stoppedPayload);
                }
            } catch (_) { /* The control reply still reports the result. */ }
        }
        return { ended: true, title };
    }

    if (typeof player.skipPlayback === 'function') { const started = await player.skipPlayback(queue); return { ended: false, unavailable: !started, title }; }
    if (!queue.player) return { unavailable: true, title };
    queue.player.stop();
    return { ended: false, title };
}

module.exports = { skipPlayback };
