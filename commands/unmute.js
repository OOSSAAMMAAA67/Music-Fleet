const { createSuccessEmbed, createErrorEmbed } = require("../utils/embed");
const config = require("../config");
const { getPlayer } = require("../utils/playerContext");
const { reactQuietly } = require('../utils/quietControl');
module.exports={ name:"فك_صم", aliases:["unmute","unfk","رفع_كتم"], description:"رفع كتم صوت الموسيقى", usage:"فك_صم", async execute(message,args,client){
 const player=getPlayer(client); const queue=player.getQueue(message.guild.id); if(!queue||!queue.playing) return message.reply({embeds:[createErrorEmbed(config.MESSAGES.NO_MUSIC)]});
 const previous=queue.volume,vol=queue._prevVolume||config.DEFAULT_VOLUME; queue.volume=vol; const change=player.applyVolume(queue),requestToken=queue._playRequestToken; if(await change===false){if(queue._playRequestToken===requestToken&&queue.volume===vol)queue.volume=previous;return reactQuietly(message,'❌');} await player.refreshNowPlayingMessage(queue, true); return reactQuietly(message);
}};
