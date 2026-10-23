const { createSuccessEmbed, createErrorEmbed } = require("../utils/embed");
const config = require("../config");
const { getPlayer } = require("../utils/playerContext");
const { reactQuietly } = require('../utils/quietControl');
module.exports={
 name:"امسح", aliases:["clear","clearqueue","مسح"], description:"مسح الأغاني القادمة مع الإبقاء على الحالية", usage:"امسح",
 async execute(message, args, client){
  const player=getPlayer(client); const queue=player.getQueue(message.guild.id);
  if(!queue||queue.tracks.length===0) return message.reply({embeds:[createErrorEmbed(config.MESSAGES.QUEUE_EMPTY)]});
  const removed=player.clearUpcoming(queue);
  await player.refreshNowPlayingMessage(queue, true);
  return reactQuietly(message);
 }
};
