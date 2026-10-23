const { spawn } = require("child_process");
const {
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    StreamType,
    NoSubscriberBehavior,
    entersState,
} = require("@discordjs/voice");
const { createErrorEmbed, createSuccessEmbed } = require("../utils/embed");
const config = require("../config");
const { resolveFfmpegPath } = require("../utils/ffmpegResolver");

module.exports = {
    name: "اختبار_صوت",
    aliases: ["اختبار", "tone", "soundtest", "voicetest", "testvoice"],
    description: "يشغل صفارة اختبار من FFmpeg بدون يوتيوب لمعرفة هل Discord Voice يعمل أم لا",
    usage: "اختبار_صوت",

    async execute(message, args, client) {
        if (!message.member.voice.channel) {
            return message.reply({ embeds: [createErrorEmbed("ادخل روم صوتي أولاً ثم اكتب: اختبار_صوت")] });
        }

        const playerManager = require("./play")._player;
        let queue;
        try {
            queue = await playerManager.join(message.member.voice.channel, message.channel);
            client.queues.set(message.guild.id, queue);
        } catch (err) {
            return message.reply({ embeds: [createErrorEmbed(
                "❌ فشل اختبار الاتصال الصوتي قبل يوتيوب.\n" +
                "هذا يؤكد أن المشكلة ليست cookies ولا yt-dlp.\n" +
                "التفصيل: " + (err.message || err)
            )] });
        }

        const connection = queue.connection;
        const previousPlayer = queue.player;
        const playToken = queue._playToken;
        let ffmpeg, audioPlayer, subscription, timer;
        let ffErr = "", ffmpegClosed = false, cleaned = false, pausedPrevious = false;
        let rejectStartup;
        const startupFailure = new Promise((_, reject) => { rejectStartup = reject; });
        startupFailure.catch(() => {});

        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            clearTimeout(timer);
            const ownsSubscription = connection?.state?.subscription?.player === audioPlayer ||
                (subscription && connection?.state?.subscription === subscription);
            try { audioPlayer?.stop(true); } catch (_) {}
            try { subscription?.unsubscribe(); } catch (_) {}
            if (!ffmpegClosed) { try { ffmpeg?.kill("SIGKILL"); } catch (_) {} }
            const current = typeof playerManager.getQueue === "function" ? playerManager.getQueue(message.guild.id) : queue;
            if (current === queue && queue.connection === connection &&
                queue.player === previousPlayer && queue._playToken === playToken &&
                connection?.state?.status !== "destroyed" && previousPlayer) {
                if (ownsSubscription) { try { connection.subscribe(previousPlayer); } catch (_) {} }
                if (pausedPrevious && !queue.paused && (ownsSubscription || !subscription ||
                    connection?.state?.subscription?.player === previousPlayer)) {
                    try { previousPlayer.unpause(); } catch (_) {}
                }
            }
        };
        const fail = err => {
            console.error("[VoiceTest] pipeline error:", err.message || err);
            rejectStartup(err);
            cleanup();
        };

        try {
            audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
            audioPlayer.on("error", fail);
            audioPlayer.once(AudioPlayerStatus.Idle, cleanup);
            ffmpeg = spawn(resolveFfmpegPath(), [
                "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi",
                "-i", "sine=frequency=880:duration=5", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1",
            ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
            ffmpeg.once("error", fail);
            ffmpeg.once("close", code => {
                ffmpegClosed = true;
                if (!cleaned && code !== 0) fail(new Error(`FFmpeg exited ${code}: ${ffErr}`));
            });
            ffmpeg.stderr.setEncoding("utf8");
            ffmpeg.stderr.on("data", d => { ffErr = (ffErr + d).slice(-2000); });
            const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw, inlineVolume: true });
            resource.volume?.setVolume(0.25);
            // The music player uses NoSubscriberBehavior.Play. Hold its resource
            // while the temporary tone owns the connection, then restore it.
            pausedPrevious = Boolean(queue.playing && !queue.paused && previousPlayer?.pause());
            subscription = connection.subscribe(audioPlayer);
            if (!subscription) throw new Error("connection.subscribe returned null");
            timer = setTimeout(cleanup, 20000);
            timer.unref?.();
            audioPlayer.play(resource);
            await Promise.race([entersState(audioPlayer, AudioPlayerStatus.Playing, 15000), startupFailure]);
            await message.reply({ embeds: [createSuccessEmbed(
                "اختبار الصوت بدأ",
                "إذا سمعت صفارة لمدة 5 ثوانٍ فمشكلة Discord Voice محلولة، وبعدها جرّب أمر ش.\nإذا لم تسمع شيئاً رغم ظهور نجاح، فافحص Server Mute/Client Volume للبوت."
            )] });
        } catch (err) {
            cleanup();
            return message.reply({ embeds: [createErrorEmbed(
                "❌ فشل اختبار الصوت المحلي.\n" +
                "هذا يعني أن المشكلة في اتصال Discord Voice أو إعدادات الروم، وليس في يوتيوب.\n" +
                "التفصيل: " + (err.message || err) + (ffErr ? "\nffmpeg: " + ffErr.slice(-500) : "")
            )] });
        }
    },
};
