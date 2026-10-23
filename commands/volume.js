const { createSuccessEmbed, createErrorEmbed } = require("../utils/embed");
const config = require("../config");
const { reactQuietly } = require('../utils/quietControl');
const { getPlayer } = require("../utils/playerContext");
module.exports={ name:"صوت", aliases:["volume","vol","v","ص"], description:"ضبط مستوى الصوت (1-200)", usage:"صوت [1-200] | ص [1-200]", async execute(message,args,client){
 const player=getPlayer(client); const queue=player.getQueue(message.guild.id);
 if(!queue||!queue.playing) return message.reply({embeds:[createErrorEmbed(config.MESSAGES.NO_MUSIC)]});
 if(!args[0]) return message.reply({embeds:[createSuccessEmbed("مستوى الصوت",`الصوت الحالي: **${queue.volume}%**\nاستخدم: \`صوت [1-${config.MAX_VOLUME}]\``)]});
 const vol=parseInt(args[0]); if(isNaN(vol)||vol<1||vol>config.MAX_VOLUME) return message.reply({embeds:[createErrorEmbed(`الصوت يجب أن يكون بين 1 و ${config.MAX_VOLUME}`)]});
 const previous=queue.volume; queue.volume=vol; const change=player.applyVolume(queue),requestToken=queue._playRequestToken; if(await change===false){if(queue._playRequestToken===requestToken&&queue.volume===vol)queue.volume=previous;return reactQuietly(message,'❌');} await player.refreshNowPlayingMessage(queue, true); return reactQuietly(message);
}};
