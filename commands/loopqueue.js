const { createErrorEmbed } = require("../utils/embed");
const config = require("../config");
const { reactQuietly } = require('../utils/quietControl');
const { getPlayer } = require("../utils/playerContext");
module.exports={ name:"كرر_قائمة", aliases:["loopqueue","lq","تكرار_قائمة"], description:"تبديل وضع تكرار القائمة كاملة", usage:"كرر_قائمة", async execute(message,args,client){
 const player=getPlayer(client); const queue=player.getQueue(message.guild.id); if(!queue||!queue.playing) return message.reply({embeds:[createErrorEmbed(config.MESSAGES.NO_MUSIC)]});
 queue.loopQueue=!queue.loopQueue; if(queue.loopQueue) queue.loop=false; await player.refreshNowPlayingMessage(queue, true); return reactQuietly(message);
}};
