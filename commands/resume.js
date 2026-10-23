const { createErrorEmbed } = require("../utils/embed");
const config = require("../config");
const { reactQuietly } = require('../utils/quietControl');
const { getPlayer } = require("../utils/playerContext");
module.exports={ name:"كمل", aliases:["استمر","resume","unpause"], description:"استمرار الموسيقى بعد الإيقاف المؤقت", usage:"كمل", async execute(message,args,client){
 const player=getPlayer(client); const queue=player.getQueue(message.guild.id);
 if(!queue||!queue.playing) return message.reply({embeds:[createErrorEmbed(config.MESSAGES.NO_MUSIC)]});
 if(!queue.paused) return message.reply({embeds:[createErrorEmbed("الموسيقى تعزف بالفعل!")]});
 queue._autoPausedOnEmpty=false; queue.player.unpause(); queue.paused=false; if(queue.pausedAt) queue.startTime=Date.now()-(queue.pausedAt-queue.startTime); queue.pausedAt=0; await player.refreshNowPlayingMessage(queue, true); return reactQuietly(message);
}};
