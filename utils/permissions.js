const config = require("../config");

function isOwner(userId, client = require('./playerContext').currentClient()) {
    const id = String(userId ?? '');
    return client?.fleet ? client.fleet.isOwner(id) : [config.OWNER_ID, ...(config.OWNER_IDS || [])].includes(id);
}

function isRootOwner(userId, client = require('./playerContext').currentClient()) {
    const id = String(userId ?? '');
    return client?.fleet
        ? client.fleet.isRootOwner(id)
        : [config.OWNER_ID, ...(config.OWNER_IDS || [])].filter(Boolean).map(String).includes(id);
}

function hasPermission(member, permission) {
    return Boolean(member?.permissions?.has?.(permission));
}

function isInVoiceChannel(member) {
    return !!member.voice.channel;
}

function isBotInSameChannel(member, client) {
    const botMember = member.guild.members.me;
    if (!botMember?.voice.channel) return true;
    return botMember.voice.channelId === member.voice.channelId;
}

function canManagePlayer(member) {
    return (
        hasPermission(member, "ManageGuild") ||
        hasPermission(member, "MoveMembers") ||
        hasPermission(member, "DeafenMembers") ||
        isOwner(member.id)
    );
}

module.exports = {
    isOwner,
    isRootOwner,
    hasPermission,
    isInVoiceChannel,
    isBotInSameChannel,
    canManagePlayer,
};
