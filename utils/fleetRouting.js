'use strict';

const OWNER_COMMAND_FILES = new Set([
    'join.js', 'leave.js', 'prefix.js', 'diagnose.js', 'voicetest.js',
    'owners.js', 'repair.js', 'avatarall.js', 'activity.js',
]);
const PLAYBACK_COMMAND_FILES = new Set([
    'help.js', 'play.js', 'playnow.js', 'add.js', 'search.js', 'queue.js',
    'favorites.js', 'like.js', 'lyrics.js', 'pause.js', 'resume.js',
    'stop.js', 'skip.js', 'previous.js', 'replay.js', 'seek.js', 'seek_to.js',
    'rewind.js', 'jumpto.js', 'move.js', 'remove.js', 'clear.js', 'loop.js',
    'loopqueue.js', 'shuffle.js', 'volume.js', 'volumeup.js', 'volumedown.js',
    'mute.js', 'unmute.js', 'voicetest.js', 'web.js', 'panel.js', 'nowplaying.js',
]);
function actorVoiceId(actor) {
    const userId = actor?.author?.id || actor?.user?.id || actor?.member?.user?.id || actor?.member?.id;
    const state = userId && actor?.guild?.voiceStates?.cache?.get?.(userId);
    return state ? state.channelId : actor?.member?.voice?.channelId || null;
}
function actorChannelId(actor) {
    return String(actor?.channelId || actor?.channel?.id || '');
}
function pinForVoice(fleet, guildId, voiceId) {
    const record = fleet?.resolveForVoice?.(guildId, voiceId) || null;
    if (!record) return null;
    const pin = fleet.state?.getPins?.().find(item => item.guildId === String(guildId)
        && item.botKey === record.key && item.voiceChannelId === String(voiceId));
    return pin ? { record, pin } : null;
}
function fleetPlaybackTarget(fleet, guildId, voiceId, client, channelId, queue) {
    const target = pinForVoice(fleet, guildId, voiceId);
    if (!target?.pin?.textChannelId || target.record.client !== client) return null;
    if (channelId != null && String(channelId) !== target.pin.textChannelId) return null;
    if (queue && queue.textChannel?.id !== target.pin.textChannelId) return null;
    return target;
}
function playbackTargetRecord(message, fleet) {
    const guildId = message?.guild?.id;
    const voiceId = actorVoiceId(message);
    const channelId = actorChannelId(message);
    if (!guildId || !voiceId || !channelId) return null;
    const target = pinForVoice(fleet, guildId, voiceId);
    // Fleet playback always belongs to the exact text/voice pair set by the
    // owner. A voice-only or missing pin is never guessed from a bot mention.
    if (!target?.pin?.textChannelId || target.pin.textChannelId !== channelId) return null;
    return target.record;
}
function mentionedRecords(message, fleet) {
    const ids = new Set();
    for (const user of message.mentions?.users?.values?.() || []) ids.add(user.id);
    for (const match of String(message.content || '').matchAll(/<@!?(\d+)>/g)) ids.add(match[1]);
    const selected = [];
    for (const id of ids) { const record = fleet.recordFor(id); if (record && !selected.includes(record)) selected.push(record); }
    return selected;
}
function targetRecord(message, client, command) {
    const fleet = client.fleet;
    if (!fleet) return null;
    if (command.fleetControl) return fleet.recordForClient(fleet.controlClient());
    // A bot mention must not route music to another bot's queue. The member's
    // current voice room and its saved text channel are the sole authority.
    if (command.requiresAssignedVoice) return playbackTargetRecord(message, fleet);
    const mentioned = mentionedRecords(message, fleet);
    if (mentioned.length > 1) return null;
    if (mentioned.length === 1) return mentioned[0];
    const voiceId = message.member?.voice?.channelId;
    return (voiceId && fleet.resolveForVoice(message.guild.id, voiceId)) || fleet.recordForClient(fleet.controlClient());
}
function shouldHandleMessage(message, client, command) {
    if (!client.fleet) return true;
    if (command.rootOwnerOnly && !client.fleet.isRootOwner(message.author.id)) return false;
    if (command.ownerOnly && !client.fleet.isOwner(message.author.id)) return false;
    return targetRecord(message, client, command)?.client === client;
}
function canUsePlayback(message, client, queue) {
    const guildId = message.guild?.id;
    if (!guildId) return false;
    const voiceId = actorVoiceId(message);
    if (!voiceId) return false;
    if (queue?.currentTrack && !queue.voiceChannel?.id) return false;
    if (queue?.voiceChannel?.id && queue.voiceChannel.id !== voiceId) return false;
    const channelId = actorChannelId(message);
    if (!channelId) return false;
    if (!client.fleet) return !queue?.textChannel?.id || queue.textChannel.id === channelId;
    return Boolean(fleetPlaybackTarget(client.fleet, guildId, voiceId, client, channelId, queue));
}
function isCurrentPlaybackTarget(actor, client, queue, player = client?.player) {
    if (!queue || !player || player.closed || queue._intentionalDestroy || (client?.player && client.player !== player)
        || player.getQueue(actor.guild?.id) !== queue) return false;
    const userId = actor.author?.id || actor.user?.id || actor.member?.id;
    const state = actor.guild?.voiceStates?.cache?.get(userId);
    const voiceId = state ? state.channelId : actor.member?.voice?.channelId;
    if (!voiceId || (queue.currentTrack && !queue.voiceChannel?.id)
        || (queue.voiceChannel?.id && queue.voiceChannel.id !== voiceId)) return false;
    if (client.fleet) {
        if (client.fleet._closed) return false;
        if (typeof client.fleet.recordForClient === 'function') {
            const record = client.fleet.recordForClient(client);
            if (!record || record.player !== player || ['restarting', 'failed', 'closed'].includes(record.status)) return false;
        }
        return canUsePlayback(actor, client, queue);
    }
    return true;
}
async function acknowledgeSilently(interaction) {
    if (!interaction || interaction.deferred || interaction.replied) return false;
    const component = interaction.isMessageComponent?.() || interaction.isButton?.() || interaction.isStringSelectMenu?.();
    if (component && typeof interaction.deferUpdate === 'function') {
        await interaction.deferUpdate().catch(() => {});
        return true;
    }
    if (typeof interaction.deferReply === 'function') {
        try {
            await interaction.deferReply({ ephemeral: true });
            if (typeof interaction.deleteReply === 'function') await interaction.deleteReply().catch(() => {});
            return true;
        } catch (_) { return false; }
    }
    return false;
}

module.exports = { OWNER_COMMAND_FILES, PLAYBACK_COMMAND_FILES, actorVoiceId, actorChannelId, mentionedRecords,
    targetRecord, shouldHandleMessage, canUsePlayback, isCurrentPlaybackTarget, acknowledgeSilently, fleetPinForVoice: pinForVoice, fleetPlaybackTarget };
