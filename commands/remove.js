const { createSuccessEmbed, createErrorEmbed } = require("../utils/embed");
const config = require("../config");
const { getPlayer } = require("../utils/playerContext");
const { reactQuietly } = require('../utils/quietControl');
module.exports={
 name:"حذف", aliases:["remove","del","rm"], description:"حذف أغنية من القائمة برقمها", usage:"حذف [رقم]",
 async execute(message, args, client){
  const player=getPlayer(client); const queue=player.getQueue(message.guild.id);
  if(!queue||queue.tracks.length===0) return message.reply({embeds:[createErrorEmbed(config.MESSAGES.QUEUE_EMPTY)]});
  const result=player.removeTrack(queue,args[0]);
  if(!result) return message.reply({embeds:[createErrorEmbed(`رقم غير صحيح! القائمة تحتوي على ${queue.tracks.length} أغنية`)]});
  if(result.current) return message.reply({embeds:[createErrorEmbed("لا يمكن حذف الأغنية الحالية. استخدم `تخطى` أو `وقف`.")]});
  await player.refreshNowPlayingMessage(queue, true);
  return reactQuietly(message);
 }
};
