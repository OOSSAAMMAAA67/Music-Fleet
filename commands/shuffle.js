const { createErrorEmbed } = require("../utils/embed");
const { reactQuietly } = require('../utils/quietControl');
const { getPlayer } = require("../utils/playerContext");
module.exports={
 name:"خلط", aliases:["shuffle","عشوائي"], description:"خلط الأغاني القادمة مع إبقاء الحالية ثابتة", usage:"خلط",
 async execute(message, args, client){
  const player=getPlayer(client); const queue=player.getQueue(message.guild.id);
  if(!queue||queue.tracks.length<3) return message.reply({embeds:[createErrorEmbed("لا توجد أغاني قادمة كافية للخلط!")]});
  const changed=player.shuffleUpcoming(queue);
  if(!changed) return message.reply({embeds:[createErrorEmbed("لا توجد أغاني قادمة كافية للخلط!")]});
  await player.refreshNowPlayingMessage(queue, true);
  return reactQuietly(message);
 }
};
