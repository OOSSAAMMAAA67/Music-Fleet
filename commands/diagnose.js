const { EmbedBuilder, GatewayIntentBits, PermissionFlagsBits } = require("discord.js");
const { generateDependencyReport, getVoiceConnection } = require("@discordjs/voice");
const ytDlp = require("../utils/ytDlpProvider");
const config = require("../config");

module.exports = {
    name: "تشخيص",
    aliases: ["diagnose", "diag", "فحص"],
    description: "فحص مكتبات الصوت ومحرك yt-dlp واتصال الروم الصوتي",
    usage: "تشخيص",

    async execute(message, args, client) {
        const lines = [];

        lines.push(`Node: ${process.version}`);
        lines.push(`discord.js: ${require("discord.js").version}`);
        const dependencyReport = generateDependencyReport();
        const voiceVersion = dependencyReport.match(/@discordjs\/voice:\s*([^\n]+)/)?.[1] || "installed";
        lines.push(`@discordjs/voice: ${voiceVersion}`);
        lines.push(`GuildVoiceStates intent: ${client.options.intents.has(GatewayIntentBits.GuildVoiceStates) ? "OK" : "MISSING"}`);
        lines.push("");

        const vc = message.member?.voice?.channel;
        if (vc) {
            const me = message.guild.members.me;
            const perms = vc.permissionsFor(me);
            lines.push(`Voice channel: ${vc.name} (${vc.id})`);
            lines.push(`Bot visible in channel now: ${me.voice.channelId || "not joined"}`);
            lines.push(`Permission ViewChannel: ${perms?.has(PermissionFlagsBits.ViewChannel) ? "OK" : "NO"}`);
            lines.push(`Permission Connect: ${perms?.has(PermissionFlagsBits.Connect) ? "OK" : "NO"}`);
            lines.push(`Permission Speak: ${perms?.has(PermissionFlagsBits.Speak) ? "OK" : "NO"}`);
            lines.push(`Permission UseVAD: ${perms?.has(PermissionFlagsBits.UseVAD) ? "OK" : "NO"}`);
            lines.push(`Bot selfMute=${me.voice.selfMute ?? "?"} serverMute=${me.voice.serverMute ?? "?"} selfDeaf=${me.voice.selfDeaf ?? "?"} serverDeaf=${me.voice.serverDeaf ?? "?"} suppress=${me.voice.suppress ?? "?"}`);
            const conn = getVoiceConnection(message.guild.id, client.player?.group);
            lines.push(`VoiceConnection status: ${conn?.state?.status || "none"}`);
        } else {
            lines.push("Voice channel: أنت لست داخل روم صوتي، ادخل الروم ثم اكتب تشخيص مرة ثانية.");
        }

        lines.push("");
        try {
            const info = await ytDlp.checkAvailability();
            lines.push(`yt-dlp: OK ${info.version}`);
            lines.push(`yt-dlp path: ${info.label}`);
        } catch (err) {
            lines.push("yt-dlp: NOT READY");
            lines.push(String(err.message || err).split("\n")[0]);
        }

        lines.push("");
        lines.push(`Audio quality: ${config.AUDIO_QUALITY}`);
        lines.push(`Search limit: ${config.YTDLP_SEARCH_LIMIT}`);
        lines.push("");
        lines.push(dependencyReport.slice(0, 1800));

        const embed = new EmbedBuilder()
            .setColor(config.COLORS.INFO)
            .setTitle("🧪 تشخيص البوت الصوتي")
            .setDescription("```txt\n" + lines.join("\n").slice(0, 3900) + "\n```")
            .setFooter({ text: "By ! A" })
            .setTimestamp();

        return message.reply({ embeds: [embed] });
    },
};
