const { createErrorEmbed } = require("../utils/embed");
const config = require("../config");
const { reactQuietly } = require('../utils/quietControl');
const { getPlayer } = require("../utils/playerContext");
module.exports={ name:"كرر", aliases:["loop","repeat","تكرار"], description:"تبديل وضع تكرار الأغنية الحالية", usage:"كرر", async execute(message,args,client){
 const player=getPlayer(client); const queue=player.getQueue(message.guild.id); if(!queue||!queue.playing) return message.reply({embeds:[createErrorEmbed(config.MESSAGES.NO_MUSIC)]});
 queue.loop=!queue.loop; if(queue.loop) queue.loopQueue=false; await player.refreshNowPlayingMessage(queue, true); return reactQuietly(message);
}};
