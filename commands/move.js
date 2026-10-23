const { createSuccessEmbed, createErrorEmbed } = require("../utils/embed");
const { getPlayer } = require("../utils/playerContext");
const { reactQuietly } = require('../utils/quietControl');
module.exports={
 name:"نقل", aliases:["move","swap"], description:"نقل أغنية من موضع لآخر في القائمة", usage:"نقل [من] [إلى]",
 async execute(message, args, client){
  const player=getPlayer(client); const queue=player.getQueue(message.guild.id);
  if(!queue||queue.tracks.length<2) return message.reply({embeds:[createErrorEmbed("القائمة فارغة أو تحتوي أغنية واحدة فقط!")]});
  const moved=player.moveTrack(queue,args[0],args[1]);
  if(!moved) return message.reply({embeds:[createErrorEmbed(`الأرقام يجب أن تكون بين 1 و ${queue.tracks.length}\nمثال: \`نقل 3 1\``)]});
  await player.refreshNowPlayingMessage(queue, true);
  return reactQuietly(message);
 }
};
