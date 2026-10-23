const { createErrorEmbed } = require("../utils/embed");
const config = require("../config");
const { reactQuietly } = require('../utils/quietControl');
const { getPlayer } = require("../utils/playerContext");
module.exports={ name:"توقف", aliases:["بوز","pause"], description:"إيقاف مؤقت أو استمرار الموسيقى", usage:"توقف", async execute(message,args,client){
 const player=getPlayer(client); const queue=player.getQueue(message.guild.id);
 if(!queue||!queue.playing) return message.reply({embeds:[createErrorEmbed(config.MESSAGES.NO_MUSIC)]});
 queue._autoPausedOnEmpty=false; if(queue.paused){ queue.player.unpause(); queue.paused=false; if(queue.pausedAt) queue.startTime=Date.now()-(queue.pausedAt-queue.startTime); queue.pausedAt=0; await player.refreshNowPlayingMessage(queue, true); return reactQuietly(message); }
 queue.player.pause(); queue.paused=true; queue.pausedAt=Date.now(); await player.refreshNowPlayingMessage(queue, true); return reactQuietly(message);
}};
