const { createSuccessEmbed, createErrorEmbed } = require("../utils/embed");
const config = require("../config");
const { getPlayer } = require("../utils/playerContext");
const { reactQuietly } = require('../utils/quietControl');
module.exports={ name:"صم", aliases:["mute","كتم"], description:"كتم صوت الموسيقى", usage:"صم", async execute(message,args,client){
 const player=getPlayer(client); const queue=player.getQueue(message.guild.id); if(!queue||!queue.playing) return message.reply({embeds:[createErrorEmbed(config.MESSAGES.NO_MUSIC)]});
 const previous=queue.volume;if(queue.volume>0) queue._prevVolume=queue.volume; queue.volume=0; const change=player.applyVolume(queue),requestToken=queue._playRequestToken; if(await change===false){if(queue._playRequestToken===requestToken&&queue.volume===0)queue.volume=previous;return reactQuietly(message,'❌');} await player.refreshNowPlayingMessage(queue, true); return reactQuietly(message);
}};
