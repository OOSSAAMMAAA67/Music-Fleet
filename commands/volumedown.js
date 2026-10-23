const { createErrorEmbed } = require("../utils/embed");
const config = require("../config");
const { reactQuietly } = require('../utils/quietControl');
const { getPlayer } = require("../utils/playerContext");
module.exports={ name:"خفض", aliases:["خفض_صوت","voldown","vd"], description:"خفض الصوت 10%", usage:"خفض", async execute(message,args,client){
 const player=getPlayer(client); const queue=player.getQueue(message.guild.id); if(!queue||!queue.playing) return message.reply({embeds:[createErrorEmbed(config.MESSAGES.NO_MUSIC)]});
 const previous=queue.volume,newVol=Math.max(queue.volume-10,1); queue.volume=newVol; const change=player.applyVolume(queue),requestToken=queue._playRequestToken; if(await change===false){if(queue._playRequestToken===requestToken&&queue.volume===newVol)queue.volume=previous;return reactQuietly(message,'❌');} await player.refreshNowPlayingMessage(queue, true); return reactQuietly(message);
}};
