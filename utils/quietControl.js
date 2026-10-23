'use strict';

const { getPlayer } = require('./playerContext');
const { canUsePlayback } = require('./fleetRouting');

// Prefix commands are ordinary public messages. A reaction acknowledges a
// small playback action without adding a new bot message to the channel.
async function reactQuietly(message, emoji = '✅') {
    try { await message.react(emoji); } catch (_) {
        // The player state itself still shows the change when Add Reactions
        // is unavailable; never post another public success card as fallback.
    }
}

function currentPlaybackRequest(message, client, player, queue, track, requestToken) {
    return !player.closed && !client?.fleet?._closed && !queue._intentionalDestroy
        && getPlayer(client) === player && player.getQueue(message.guild.id) === queue
        && queue.currentTrack === track && queue._playRequestToken === requestToken
        && canUsePlayback(message, client, queue);
}

async function runQuietPlayback(message, client, player, queue, track, seek, onFailure) {
    let work, error, started = false;
    try { work = player.play(queue, track, seek); } catch (err) { error = err; }
    const requestToken = queue._playRequestToken;
    const current = () => currentPlaybackRequest(message, client, player, queue, track, requestToken);
    if (!error) {
        try { started = await work; } catch (err) { error = err; }
    }
    if (!current()) return { started: false, current };
    if (!started) {
        if (error) console.error('[Playback control]', error.message || error);
        onFailure?.();
        await reactQuietly(message, '❌');
    }
    return { started: Boolean(started), current };
}

module.exports = { reactQuietly, currentPlaybackRequest, runQuietPlayback };
