const { createLyricsPayload, createErrorEmbed } = require('../utils/embed');
const lyricsProvider = require('../utils/lyricsProvider');
const config = require('../config');
const lyricsAutoFollow = require('../utils/lyricsAutoFollow');

module.exports = {
    name: 'كلمات',
    aliases: ['lyrics', 'lyric', 'ليريكس', 'كلمات_الاغنية', 'كلمات_الأغنية'],
    description: 'عرض كلمات الأغنية الحالية أو البحث عن كلمات باسم محدد',
    usage: 'كلمات | كلمات artist - song',

    async execute(message, args, client) {
        const player = require('../utils/playerContext').getPlayer(client);
        const queue = player.getQueue(message.guild.id);
        const query = args.join(' ').trim();
        let track = query
            ? { title: query, author: '', thumbnail: null, duration: 0 }
            : queue?.currentTrack;

        if (!track) {
            return message.reply({ embeds: [createErrorEmbed('لا توجد أغنية تعمل حالياً. اكتب مثلاً: `كلمات Justin Bieber - Beauty And A Beat`')] });
        }

        const loading = await message.reply({ embeds: [{ color: 0x5865F2, description: `🎤 جاري جلب كلمات: **${String(track.title || query).substring(0, 90)}**` }] });

        try {
            let lyrics;
            let lyricsTrackKey = '';
            // Current-song lookups can take a moment on LRCLIB/caption fallbacks.
            // If the queue advances meanwhile, resolve the new live track instead
            // of letting stale lyrics flash and then get corrected by Auto later.
            for (let attempt = 0; attempt < (query ? 1 : 3); attempt++) {
                const expected = lyricsAutoFollow._trackIdentity(track);
                lyricsTrackKey = expected;
                const preferredLanguage = lyricsProvider.guessLyricsLanguage?.(track.title, track.author) || undefined;
                lyrics = await lyricsProvider.findLyrics(track, { language: preferredLanguage });
                if (query) break;
                const latest = player.getQueue(message.guild.id)?.currentTrack;
                if (!latest) throw new Error('track changed');
                if (lyricsAutoFollow._trackIdentity(latest) === expected) { track = latest; break; }
                track = latest;
            }
            if (!query && lyricsAutoFollow._trackIdentity(track) !== lyricsTrackKey) throw new Error('track changed during lyrics lookup');
            const elapsed = !query && queue ? Math.max(0, (queue.getElapsedPrecise?.() ?? queue.getElapsed?.() ?? 0) + Number(config.DISCORD_LYRICS_SYNC_OFFSET_MS || 0) / 1000) : 0;
            const payload = await createLyricsPayload(message.author, track, lyrics, {
                page: query ? 1 : 0, elapsed, ownerId: message.author.id, autoFollow: !query, dynamicCard: Boolean(query),
            });
            delete payload.ephemeral;
            let sent;
            try { sent = await loading.edit(payload); }
            catch (_) { sent = await message.reply(payload); }

            // Prefix/message lyrics now truly auto-follow too. Previously the button
            // could say "Auto On" while no timer existed until a component interaction.
            if (!query) {
                // Keep a lightweight background Auto session even when the first
                // lookup only found plain/no lyrics. It will retry and upgrade the
                // same message automatically if synced timings become available.
                lyricsAutoFollow.start({
                    guildId: message.guild.id,
                    channelId: message.channel.id,
                    userId: message.author.id,
                    player,
                    track,
                    lyrics,
                    render: async (current, currentElapsed, activeLyrics = lyrics) => {
                        const next = await createLyricsPayload(message.author, current, activeLyrics, {
                            page: 0,
                            elapsed: currentElapsed,
                            ownerId: message.author.id,
                            autoFollow: true,
                            dynamicCard: false,
                        });
                        delete next.ephemeral;
                        return next;
                    },
                    edit: next => sent.edit(next),
                });
            } else {
                lyricsAutoFollow.stop({ guildId: message.guild.id, channelId: message.channel.id, userId: message.author.id });
            }
            return sent;
        } catch (err) {
            console.error('[lyrics command] failed:', err.message || err);
            return loading.edit({ embeds: [createErrorEmbed('تعذر جلب الكلمات الآن. جرّب اسم أوضح أو اكتب: `كلمات artist - song`')], components: [] }).catch(() => {});
        }
    },
};
