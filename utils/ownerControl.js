'use strict';
const { mentionedRecords } = require('./fleetRouting');
const { isOwner } = require('./permissions');
const { reactQuietly } = require('./quietControl');
function ownerTarget(message, args, client) {
    const fleet = client.fleet;
    if (!fleet) throw new Error('Fleet service is unavailable.');
    const mentions = mentionedRecords(message, fleet);
    if (mentions.length > 1) throw new Error('Choose one bot.');
    if (mentions.length === 1) return mentions[0];
    const explicit = args[0] && fleet.recordFor(args[0]);
    if (explicit) return explicit;
    return (message.member?.voice?.channelId && fleet.resolveForVoice(message.guild.id, message.member.voice.channelId)) || fleet.recordForClient(client);
}
function voiceDestination(message, args, fleet) {
    const explicit = args.find(arg => /^<#\d+>$/.test(arg) || (/^\d{5,32}$/.test(arg) && !fleet.recordFor(arg)));
    if (explicit) return explicit.replace(/[<#>]/g, '');
    if (message.channel?.isVoiceBased?.() || [2, 13].includes(message.channel?.type)) return message.channel.id;
    return message.member?.voice?.channelId || null;
}
async function ownerAction(message, client, work) {
    if (!isOwner(message.author.id, client)) return;
    try { await work(); return reactQuietly(message); }
    catch (err) { console.warn('[Owner]', client.fleet?.safeError?.(err) || err.message); return reactQuietly(message, '❌'); }
}
module.exports = { ownerTarget, voiceDestination, ownerAction };
