const { getPlayer } = require('../utils/playerContext');
const config = require('../config');
const { createInfoEmbed } = require('../utils/embed');

const DEFAULT_EMPTY_STOP_MS = 10 * 60 * 1000;
const RECHECK_WHILE_OFFLINE_MS = 30 * 1000;
const VOICE_STABLE_FOR_EMPTY_STOP_MS = 15 * 1000;

function clearEmptyStop(queue) {
    if (queue?._emptyRoomStopTimer) clearTimeout(queue._emptyRoomStopTimer);
    if (queue) {
        queue._emptyRoomStopTimer = null;
        queue._emptyRoomSinceAt = 0;
    }
}

function humanMembers(channel) {
    return channel?.members?.filter(member => !member.user?.bot) || null;
}

function currentQueue(client, player, guildId) {
    return player?.getQueue(guildId) || client.queues?.get(guildId) || null;
}

function scheduleEmptyStop(queue, player, client, guildId) {
    if (queue._emptyRoomStopTimer || !queue.currentTrack || !(queue.playing || queue.paused || queue.tracks.length)) return;
    const duration = Math.max(1000, Number(config.AUTO_STOP_ON_EMPTY_AFTER_MS || DEFAULT_EMPTY_STOP_MS));
    queue._emptyRoomSinceAt ||= Date.now();
    const remaining = Math.max(0, duration - (Date.now() - queue._emptyRoomSinceAt));
    const expectedQueue = queue;
    queue._emptyRoomStopTimer = setTimeout(() => {
        queue._emptyRoomStopTimer = null;
        const liveQueue = currentQueue(client, player, guildId);
        if (liveQueue !== expectedQueue || liveQueue._intentionalDestroy || liveQueue.voiceChannel?.id !== queue._emptyRoomChannelId) {
            clearEmptyStop(queue);
            return;
        }
        const guild = liveQueue.voiceChannel?.guild;
        const channel = guild?.channels?.cache?.get(liveQueue.voiceChannel.id);
        const connectionReady = liveQueue.connection?.state?.status === 'ready';
        const actualBotChannelId = guild?.members?.me?.voice?.channelId;
        const voiceStable = Date.now() - Number(liveQueue._connectionStateSinceAt || 0) >= VOICE_STABLE_FOR_EMPTY_STOP_MS;
        const humans = humanMembers(channel);
        if (humans && humans.size > 0) {
            clearEmptyStop(liveQueue);
            return;
        }
        const authoritative = Boolean(guild && guild.available !== false && client.isReady?.() !== false
            && connectionReady && channel && actualBotChannelId === liveQueue.voiceChannel.id && voiceStable
            && humans && !liveQueue._voiceOutageAt && !liveQueue._rejoinPromise && !liveQueue._rejoinTimer);
        if (!authoritative) {
            // During a gateway outage the cached member list may be stale. Keep the
            // already-earned empty time, but do not stop until voice state is current.
            scheduleEmptyStop(liveQueue, player, client, guildId);
            if (liveQueue._emptyRoomStopTimer) {
                clearTimeout(liveQueue._emptyRoomStopTimer);
                liveQueue._emptyRoomStopTimer = setTimeout(() => {
                    liveQueue._emptyRoomStopTimer = null;
                    scheduleEmptyStop(liveQueue, player, client, guildId);
                }, RECHECK_WHILE_OFFLINE_MS);
                liveQueue._emptyRoomStopTimer.unref?.();
            }
            return;
        }
        if (!humans) {
            clearEmptyStop(liveQueue);
            return;
        }
        if (Date.now() - Number(liveQueue._emptyRoomSinceAt || Date.now()) < duration) {
            scheduleEmptyStop(liveQueue, player, client, guildId);
            return;
        }

        const publicMessage = liveQueue.nowPlayingMessage;
        const textChannel = liveQueue.textChannel;
        player.stopPlayback(liveQueue, true, { preserveNowPlayingMessage: true });
        liveQueue._emptyRoomSinceAt = 0;
        const stoppedEmbed = createInfoEmbed('إيقاف تلقائي', '⏹️ توقفت الموسيقى بعد بقاء القناة الصوتية فارغة لمدة 10 دقائق.');
        const update = publicMessage?.edit?.({ embeds: [stoppedEmbed], components: [], attachments: [] });
        Promise.resolve(update).then(result => {
            if (!result && textChannel) return textChannel.send({ embeds: [stoppedEmbed] });
            return null;
        }).catch(() => {
            if (textChannel) void textChannel.send({ embeds: [stoppedEmbed] }).catch(() => {});
        });
    }, remaining);
    queue._emptyRoomStopTimer.unref?.();
}

function observeBotInAssignedRoom(queue, player, client, guild, channelId) {
    if (!queue || !channelId) return;
    const channel = guild?.channels?.cache?.get(channelId);
    const humans = humanMembers(channel);
    if (!humans) return;
    if (humans.size > 0) {
        clearEmptyStop(queue);
        return;
    }
    queue._emptyRoomChannelId = channelId;
    scheduleEmptyStop(queue, player, client, guild.id);
}

module.exports = {
    name: 'voiceStateUpdate',
    async execute(oldState, newState, client) {
        const guild = oldState.guild || newState.guild;
        const guildId = guild?.id;
        if (!guildId) return;
        const player = getPlayer(client);
        const queue = currentQueue(client, player, guildId);
        if (!queue) return;

        const botId = client.user.id;
        const isBotUpdate = oldState.id === botId || newState.id === botId;

        if (client.fleet) {
            if (client.fleet._closed || queue._intentionalDestroy) return;
            const pin = client.fleet.state.getPins().find(item => item.botKey === client.botKey && item.guildId === guildId);
            if (!pin) return;
            queue.lockedVoiceChannelId = pin.voiceChannelId;
            if (isBotUpdate) {
                if (newState.channelId !== pin.voiceChannelId) {
                    const target = guild.channels.cache.get(pin.voiceChannelId) || queue.voiceChannel;
                    if (target) {
                        queue.voiceChannel = target;
                        player?._scheduleReconnect(queue, 'fleet_voice_pin');
                    }
                } else {
                    queue.voiceChannel = guild.channels.cache.get(pin.voiceChannelId) || queue.voiceChannel;
                    observeBotInAssignedRoom(queue, player, client, guild, pin.voiceChannelId);
                }
                return;
            }
        } else if (isBotUpdate) {
            if (oldState.id !== botId) return;
            const stay = config.STAY_IN_VOICE !== false && config.AUTO_REJOIN_ON_DISCONNECT !== false;
            if (!newState.channelId) {
                if (!stay) {
                    player?.deleteQueue(guildId);
                    client.queues?.delete(guildId);
                    return;
                }
                const targetId = queue.lockedVoiceChannelId || oldState.channelId || queue.voiceChannel?.id;
                const target = guild.channels.cache.get(targetId) || oldState.channel || queue.voiceChannel;
                if (target) {
                    queue.voiceChannel = target;
                    client.queues?.set(guildId, queue);
                    player?._scheduleReconnect(queue, 'bot_disconnected_by_user_or_discord');
                }
                return;
            }
            if (oldState.channelId && oldState.channelId !== newState.channelId) {
                const targetId = queue.lockedVoiceChannelId || oldState.channelId;
                const target = guild.channels.cache.get(targetId) || oldState.channel;
                if (stay && target && newState.channelId !== target.id) {
                    queue.voiceChannel = target;
                    client.queues?.set(guildId, queue);
                    player?._scheduleReconnect(queue, 'bot_moved_from_pinned_channel');
                } else {
                    queue.voiceChannel = newState.channel;
                    if (!queue.lockedVoiceChannelId) queue.lockedVoiceChannelId = newState.channelId;
                }
            }
            if (newState.channelId && newState.channelId === queue.voiceChannel?.id) {
                observeBotInAssignedRoom(queue, player, client, guild, newState.channelId);
            }
            return;
        }

        const targetChannelId = queue.voiceChannel?.id;
        if (!targetChannelId || (oldState.channelId !== targetChannelId && newState.channelId !== targetChannelId)) return;
        const channel = guild.channels.cache.get(targetChannelId);
        if (!channel) return;

        // A real human joining is authoritative even if the member cache is one
        // event behind. Leaving/moving relies on the updated channel member cache.
        const joiningMember = newState.member || guild.members?.cache?.get(newState.id);
        const joiningUser = joiningMember?.user;
        const humanJoinedTarget = newState.channelId === targetChannelId && joiningUser && !joiningUser.bot;
        const humans = humanMembers(channel);
        if (humanJoinedTarget || (humans && humans.size > 0)) {
            clearEmptyStop(queue);
            if (queue.leaveTimer) {
                clearTimeout(queue.leaveTimer);
                queue.leaveTimer = null;
            }
            if (config.AUTO_PAUSE_ON_EMPTY && queue.paused && queue._autoPausedOnEmpty && queue.player && queue.player.unpause() !== false) {
                queue.paused = false;
                queue._autoPausedOnEmpty = false;
                queue.startTime = Date.now() - Math.max(0, Number(queue.pausedAt || 0) - Number(queue.startTime || 0));
                queue.pausedAt = 0;
                if (queue.textChannel) queue.textChannel.send({ embeds: [createInfoEmbed('استمرار', '▶️ استمرت الموسيقى لعودة عضو للقناة')] }).catch(() => {});
            }
            return;
        }
        if (!humans || humans.size !== 0) return;

        queue._emptyRoomChannelId = targetChannelId;
        scheduleEmptyStop(queue, player, client, guildId);

        // Preserve the older optional pause behavior, but do not let it replace
        // the requested ten-minute stop timer.
        if (config.AUTO_PAUSE_ON_EMPTY && !queue.paused && queue.player && queue.player.pause() !== false) {
            queue.paused = true;
            queue.pausedAt = Date.now();
            queue._autoPausedOnEmpty = true;
        }
    },
};
