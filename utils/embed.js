const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
} = require('discord.js');
const config = require('../config');
const { MusicPlayer } = require('./musicPlayer');
const uiCards = require('./uiCards');

const BRAND = 'By ! A';

function footerText(text = '') {
    const clean = String(text || '').trim();
    return clean ? `${clean} · ${BRAND}` : BRAND;
}

function cut(text, max = 80) {
    const s = String(text || 'Unknown');
    return s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s;
}

function ltr(text) {
    return `\u200E${text}\u200E`;
}

function getElapsedSeconds(queue) {
    if (!queue) return 0;
    return Math.floor(Math.max(0, queue.getElapsedPrecise?.() ?? queue.getElapsed?.() ?? 0));
}

function getUpcomingTracks(queue, limit = 2) {
    if (!queue?.tracks?.length) return [];
    return queue.tracks.slice((queue.currentIndex || 0) + 1, (queue.currentIndex || 0) + 1 + limit);
}

function queueStats(queue) {
    const upcoming = Math.max(0, (queue?.tracks?.length || 0) - ((queue?.currentIndex || 0) + 1));
    const remainingSeconds = (queue?.tracks || [])
        .slice((queue?.currentIndex || 0) + 1)
        .reduce((acc, t) => acc + (Number(t.duration || 0) || 0), 0);
    return { upcoming, remainingSeconds };
}

function visualFrame(queue) {
    if (queue?.paused) return 'II';
    const frames = ['·', '•', '●', '•'];
    return frames[Math.floor(Date.now() / 1000) % frames.length];
}

function createMusicButtons(queue) {
    const isPaused = queue?.paused;

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('music_previous').setLabel('⏮').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music_rewind').setLabel('«').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music_pause').setLabel(isPaused ? '▶' : '❚❚').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('music_forward').setLabel('»').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music_skip').setLabel('⏭').setStyle(ButtonStyle.Secondary),
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('music_fav_save').setLabel('♡').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music_fav_list').setLabel('Library').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music_lyrics').setLabel('Lyrics').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music_queue').setLabel('☰').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music_more').setLabel('⋯').setStyle(ButtonStyle.Secondary),
    );

    return [row1, row2];
}

function createMoreMessage(queue) {
    const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
    return {
        embeds: [new EmbedBuilder().setColor(config.COLORS.MUSIC).setTitle('More').setDescription('Your listening space · By ! A')],
        components: [
            new ActionRowBuilder().addComponents(button('music_history', 'History'), button('music_discover', 'Discover'), button('music_download', 'Download'), button('music_fav_list', 'Library'), button('music_web', 'Web Player')),
            new ActionRowBuilder().addComponents(button('music_voldown', 'Vol −'), button('music_volup', 'Vol +'), button('music_loop', queue?.loop ? 'Repeat 1' : queue?.loopQueue ? 'Repeat All' : 'Repeat'), button('music_shuffle', 'Shuffle')),
            new ActionRowBuilder().addComponents(button('music_clear_next', 'Clear Queue'), button('music_stop', 'Stop', ButtonStyle.Danger)),
        ],
    };
}

function createNowPlayingEmbed(track, queue, visual = null) {
    const total = Number(track.duration || 0) || 0;
    const elapsed = total > 0 ? Math.min(getElapsedSeconds(queue), total) : getElapsedSeconds(queue);
    const bar = MusicPlayer.createProgressBar(elapsed, total, Number(config.NOW_PLAYING_BAR_SIZE || 28));
    const elapsedStr = elapsed > 0 ? MusicPlayer.formatDuration(elapsed) : '0:00';
    const totalStr = total ? MusicPlayer.formatDuration(total) : 'LIVE';
    const percent = total ? Math.min(100, Math.max(0, Math.round((elapsed / total) * 100))) : 0;
    const { upcoming } = queueStats(queue);
    const next = getUpcomingTracks(queue, Math.max(1, Number(config.NOW_PLAYING_NEXT_PREVIEW || 1)))[0];
    const requester = cut(track.requester || 'Unknown', 32);
    const stateText = queue?.paused ? 'Paused' : 'Now Playing';
    const frame = visual?.animated ? '♪' : config.NOW_PLAYING_ANIMATION === false ? '•' : visualFrame(queue);

    const description = [
            `**${cut(track.title, 96)}**`,
            `${cut(track.author || 'YouTube', 64)}`,
            `\`${bar}\``,
            `${ltr(elapsedStr)} / ${ltr(totalStr)}  ·  ${percent}%  ·  Vol ${queue?.volume ?? config.DEFAULT_VOLUME}%`,
            `Queue ${upcoming}${next ? `  ·  Next ${cut(next.title, 36)}` : ''}`,
        ].join('\n');

    const embed = new EmbedBuilder()
        .setColor(visual?.accent || (queue?.paused ? config.COLORS.INFO : config.COLORS.MUSIC))
        .setAuthor({ name: `${frame}  ${stateText}` })
        .setDescription(description)
        .setFooter({ text: footerText(requester) });

    if (track.url) embed.setURL(track.url);
    if (visual?.fileName) embed.setImage(`attachment://${visual.fileName}`);
    else if (/^https?:\/\//i.test(String(track.thumbnail || ''))) embed.setThumbnail(track.thumbnail);
    return embed;
}

function createNowPlayingMessage(track, queue) {
    return { embeds: [createNowPlayingEmbed(track, queue)], components: createMusicButtons(queue) };
}

async function createNowPlayingPayload(track, queue, options = {}) {
    let visual = null;
    try { visual = await uiCards.generateNowPlayingCard(track, queue); } catch (_) {}
    options.onVisual?.(visual);
    if (queue && options.commitVisual !== false) {
        queue._playerVisual = visual ? { fileName: visual.fileName, accent: visual.accent, animated: false } : null;
        queue._playerVisualTrackUrl = track?.url || '';
    }
    const payload = { embeds: [createNowPlayingEmbed(track, queue, visual)], components: createMusicButtons(queue) };
    if (visual?.file) payload.files = [visual.file];
    return payload;
}

function createNowPlayingUpdate(track, queue, options = {}) {
    const visual = queue?._playerVisualTrackUrl === track?.url ? queue?._playerVisual || null : null;
    const payload = { embeds: [createNowPlayingEmbed(track, queue, visual)] };
    if (options.controls !== false) payload.components = createMusicButtons(queue);
    return payload;
}

function createQueueEmbed(queue, page = 1) {
    const itemsPerPage = Math.max(1, Number(config.QUEUE_PAGE_SIZE || 8));
    const tracks = queue.tracks || [];
    const totalPages = Math.max(1, Math.ceil(tracks.length / itemsPerPage));
    const safePage = Math.max(1, Math.min(Number(page) || 1, totalPages));
    const start = (safePage - 1) * itemsPerPage;
    const currentTracks = tracks.slice(start, start + itemsPerPage);
    const { upcoming, remainingSeconds } = queueStats(queue);

    const description = currentTracks.map((t, i) => {
        const index = start + i;
        const marker = index === queue.currentIndex ? '▶' : `${index + 1}.`;
        const requester = t.requester ? ` · ${cut(t.requester, 18)}` : '';
        return `${marker} **${cut(t.title, 62)}**\n${MusicPlayer.formatDuration(t.duration)}${requester}`;
    }).join('\n\n');

    return new EmbedBuilder()
        .setColor(config.COLORS.PRIMARY)
        .setTitle('Queue')
        .setDescription(description || 'Queue is empty. Use `ش track name` to start playing.')
        .addFields(
            { name: 'Next', value: `${upcoming}`, inline: true },
            { name: 'Wait', value: MusicPlayer.formatDuration(remainingSeconds), inline: true },
            { name: 'Page', value: `${safePage} / ${totalPages}`, inline: true },
        )
        .setFooter({ text: footerText('remove 4 · move 3 1 · clear · shuffle · jump 5') });
}

function createQueueAddedEmbed(added, queue, startIndex) {
    const one = added[0];
    const many = added.length > 1;
    const { upcoming } = queueStats(queue);
    const list = added.slice(0, 3).map((t, i) => `${startIndex + i + 1}. **${cut(t.title, 58)}**`).join('\n');
    return new EmbedBuilder()
        .setColor(config.COLORS.SUCCESS)
        .setTitle(many ? 'Added to queue' : 'Queued')
        .setDescription(many ? `${list}${added.length > 3 ? `\n+ ${added.length - 3} more tracks` : ''}` : `**${cut(one?.title, 84)}**`)
        .addFields(
            { name: 'Position', value: many ? `#${startIndex + 1} → #${startIndex + added.length}` : `#${startIndex + 1}`, inline: true },
            { name: 'Next', value: `${upcoming}`, inline: true },
        )
        .setFooter({ text: footerText('Starts automatically after the current track') });
}

function createSearchEmbed(results) {
    const description = results.map((r, i) =>
        `${i + 1}. **${cut(r.title, 64)}**\n${MusicPlayer.formatDuration(r.duration)} · ${cut(r.author, 42)}`
    ).join('\n\n');

    return new EmbedBuilder()
        .setColor(config.COLORS.INFO)
        .setTitle('Search Results')
        .setDescription(description)
        .setFooter({ text: footerText('Reply with the track number or cancel') });
}

function createFavoritesLauncherMessage(user) {
    const embed = new EmbedBuilder()
        .setColor(config.COLORS.MUSIC)
        .setTitle('Library')
        .setDescription('Your favorites are private. Open your library or save the current track below.')
        .setFooter({ text: footerText(user?.tag || user?.username || 'Member') });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('music_fav_list').setLabel('Open Library').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('music_fav_save').setLabel('Save Current').setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [row] };
}

function createFavoriteSavedEmbed(result) {
    const title = result?.track?.title || 'Current Track';
    return new EmbedBuilder()
        .setColor(result?.duplicate ? config.COLORS.INFO : config.COLORS.SUCCESS)
        .setTitle(result?.duplicate ? 'Already Saved' : 'Saved')
        .setDescription(`**${cut(title, 90)}**\nSaved tracks: **${result?.total || 0}**`)
        .setFooter({ text: BRAND });
}

function _favoriteOptions(slice = [], start = 0) {
    return slice.map((track, i) => ({
        label: cut(track.title || 'Unknown', 90),
        description: `${MusicPlayer.formatDuration(track.duration)} · ${cut(track.author || 'Unknown', 54)}`,
        value: String(start + i),
    }));
}

function createFavoritesEmbed(user, tracks = [], page = 1) {
    const perPage = Math.max(1, Math.min(25, Number(config.FAVORITES_PAGE_SIZE || 25)));
    const totalPages = Math.max(1, Math.ceil(tracks.length / perPage));
    const safePage = Math.max(1, Math.min(Number(page) || 1, totalPages));
    const start = (safePage - 1) * perPage;
    const slice = tracks.slice(start, start + perPage);

    const lines = slice.map((track, idx) => {
        const n = start + idx + 1;
        return `${n}. **${cut(track.title, 70)}**\n${MusicPlayer.formatDuration(track.duration)} · ${cut(track.author || 'Unknown', 42)}`;
    }).join('\n\n');

    return new EmbedBuilder()
        .setColor(config.COLORS.MUSIC)
        .setTitle('Library')
        .setDescription(lines || 'Your library is empty.')
        .addFields(
            { name: 'Tracks', value: `${tracks.length}`, inline: true },
            { name: 'Page', value: `${safePage} / ${totalPages}`, inline: true },
            { name: 'Owner', value: cut(user?.tag || user?.username || 'Member', 24), inline: true },
        )
        .setFooter({ text: footerText('Private per user · play / queue / remove / play all') });
}

function createFavoritesButtons(userId, tracks = [], page = 1) {
    const perPage = Math.max(1, Math.min(25, Number(config.FAVORITES_PAGE_SIZE || 25)));
    const totalPages = Math.max(1, Math.ceil(tracks.length / perPage));
    const safePage = Math.max(1, Math.min(Number(page) || 1, totalPages));
    const start = (safePage - 1) * perPage;
    const slice = tracks.slice(start, start + perPage);
    const rows = [];

    if (slice.length) {
        const options = _favoriteOptions(slice, start);
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`fav_select_play:${userId}:${safePage}`).setPlaceholder('Play a favorite').addOptions(options)
        ));
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`fav_select_queue:${userId}:${safePage}`).setPlaceholder('Queue a favorite').addOptions(options)
        ));
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`fav_select_remove:${userId}:${safePage}`).setPlaceholder('Remove a favorite').addOptions(options)
        ));
    }

    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`fav_page_prev:${userId}:${safePage}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(safePage <= 1),
        new ButtonBuilder().setCustomId(`fav_page_next:${userId}:${safePage}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= totalPages),
        new ButtonBuilder().setCustomId(`fav_playall:${userId}:1`).setLabel('Play All').setStyle(ButtonStyle.Primary).setDisabled(!tracks.length),
        new ButtonBuilder().setCustomId(`fav_queueall:${userId}:1`).setLabel('Queue All').setStyle(ButtonStyle.Secondary).setDisabled(!tracks.length),
        new ButtonBuilder().setCustomId(`fav_refresh:${userId}:${safePage}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
    ));

    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`fav_clear:${userId}:confirm`).setLabel('Clear').setStyle(ButtonStyle.Danger).setDisabled(!tracks.length),
        new ButtonBuilder().setCustomId(`fav_close:${userId}`).setLabel('Close').setStyle(ButtonStyle.Secondary),
    ));
    return rows.slice(0, 5);
}

function createFavoritesMessage(user, tracks = [], page = 1) {
    return {
        embeds: [createFavoritesEmbed(user, tracks, page)],
        components: createFavoritesButtons(user.id, tracks, page),
    };
}

function _lyricsCut(text, max = 3800) {
    const s = String(text || '').trim();
    return s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s;
}

function _lyricsLine(line, active = false) {
    const text = cut(String(line || '♪'), active ? 140 : 120);
    return active ? `**> ${text}**` : `  ${text}`;
}

function createLyricsButtons(ownerId, page = 1, totalPages = 1, hasSynced = false, autoFollow = false) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeTotal = Math.max(1, Number(totalPages) || 1);
    const followPage = autoFollow ? 0 : safePage;
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`lyrics_prev:${ownerId}:${safePage}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(safePage <= 1),
        new ButtonBuilder().setCustomId(`lyrics_next:${ownerId}:${safePage}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= safeTotal),
        new ButtonBuilder().setCustomId(`lyrics_refresh:${ownerId}:${followPage}`).setLabel(hasSynced ? 'Sync' : 'Refresh').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`lyrics_auto:${ownerId}:0`).setLabel(autoFollow ? 'Auto On' : 'Auto').setStyle(autoFollow ? ButtonStyle.Primary : ButtonStyle.Secondary).setDisabled(!hasSynced),
        new ButtonBuilder().setCustomId(`lyrics_close:${ownerId}`).setLabel('Close').setStyle(ButtonStyle.Secondary),
    )];
}

function createLyricsMessage(user, track, lyrics, options = {}) {
    const requestedPage = Number(options.page ?? 0);
    const elapsed = Math.max(0, Number(options.elapsed || 0));
    const ownerId = options.ownerId || user?.id || 'user';
    const autoFollow = options.autoFollow !== false && requestedPage <= 0;
    const title = cut(lyrics?.title || track?.title || 'Current Track', 90);
    const artist = cut(lyrics?.artist || track?.author || 'Unknown', 55);
    const source = lyrics?.source || 'Lyrics';

    if (!lyrics || (!lyrics.plainLyrics && !lyrics.syncedLines?.length)) {
        const embed = new EmbedBuilder()
            .setColor(config.COLORS.WARNING || config.COLORS.INFO)
            .setTitle('Lyrics not found')
            .setDescription(`**${title}**\nNo suitable lyrics were found for this track right now.`)
            .setFooter({ text: footerText(user?.tag || user?.username || 'Member') });
        return { embeds: [embed], components: createLyricsButtons(ownerId, 1, 1, false, false), __lyricsHasSynced: false };
    }

    let description = '';
    let totalPages = 1;
    let displayPage = Math.max(1, requestedPage || 1);
    const hasSynced = Array.isArray(lyrics.syncedLines) && lyrics.syncedLines.length > 0;
    let renderLines = [];

    if (hasSynced && !options.forcePlain) {
        const { getCurrentSyncedIndex, makeSyncedPages, getSyncedWindow } = require('./lyricsProvider');
        const activeIndex = getCurrentSyncedIndex(lyrics.syncedLines, elapsed);
        const pages = makeSyncedPages(lyrics.syncedLines, activeIndex, 3050);
        totalPages = Math.max(1, pages.length);
        if (requestedPage <= 0 && autoFollow) {
            // A small sliding window avoids sending a 20+ line embed on every lyric
            // transition. It is visually the same card, but REST edits are lighter and
            // crossing an old fixed page boundary can no longer look like a huge jump.
            renderLines = getSyncedWindow(lyrics.syncedLines, elapsed, 5, 8).lines;
            displayPage = Math.max(1, Math.min(totalPages, Math.floor(Math.max(0, activeIndex) / 22) + 1));
        } else {
            displayPage = Math.max(1, Math.min(requestedPage || 1, totalPages));
            renderLines = (pages[displayPage - 1] || []);
        }
        description = renderLines.map(l => _lyricsLine(l.text, l.active)).join('\n') || 'No lines in this page.';
        description += `\n\n${MusicPlayer.formatDuration(elapsed)} · ${autoFollow ? 'auto-follow' : 'manual'}`;
    } else {
        const { makePlainPages } = require('./lyricsProvider');
        const pages = makePlainPages(lyrics.plainLyrics || lyrics.syncedLyrics || '', 3200);
        totalPages = Math.max(1, pages.length);
        displayPage = Math.max(1, Math.min(requestedPage || 1, totalPages));
        description = pages[displayPage - 1] || 'No lyrics in this page.';
    }

    const embed = new EmbedBuilder()
        .setColor(config.COLORS.MUSIC)
        .setTitle(`Lyrics · ${title}`)
        .setDescription(_lyricsCut(description, 3900))
        .addFields(
            { name: 'Artist', value: artist || 'Unknown', inline: true },
            { name: 'Source', value: source, inline: true },
            { name: 'Mode', value: `${hasSynced ? (lyrics.estimatedSync || lyrics.timingMode === 'estimated' ? 'Estimated follow' : lyrics.approximateSync || lyrics.timingMode === 'adaptive' ? 'Approximate follow' : 'Synced') : 'Full Text'}${lyrics.romanized ? ' · Romanized' : ''}`, inline: true },
        )
        .setFooter({ text: footerText(`${user?.tag || user?.username || 'Member'} · ${displayPage}/${totalPages}`) });

    if (/^https?:\/\//i.test(String(track?.thumbnail || ''))) embed.setThumbnail(track.thumbnail);
    return {
        embeds: [embed],
        components: createLyricsButtons(ownerId, displayPage, totalPages, hasSynced, autoFollow),
        __lyricsHasSynced: hasSynced,
        __lyricsAutoFollow: autoFollow,
        __lyricsRenderLines: renderLines,
    };
}

async function createLyricsPayload(user, track, lyrics, options = {}) {
    const payload = createLyricsMessage(user, track, lyrics, options);
    // Explicitly clear the previous lyrics attachment. Auto-follow intentionally
    // stays text-only: regenerating/uploading a PNG every lyric line adds variable
    // latency and CPU/network work to the synchronization path. Manual pages can
    // still render the full visual card.
    payload.attachments = [];
    if (!payload?.__lyricsHasSynced || options.dynamicCard === false) return payload;
    try {
        const visual = await uiCards.generateLyricsCard(track, lyrics, { lines: payload.__lyricsRenderLines, elapsed: options.elapsed || 0 });
        if (visual?.file) {
            payload.files = [visual.file];
            payload.embeds[0].setImage(`attachment://${visual.fileName}`);
            if (visual.accent) payload.embeds[0].setColor(visual.accent);
        }
    } catch (_) {}
    return payload;
}

function createSuccessEmbed(title, description) {
    return new EmbedBuilder().setColor(config.COLORS.SUCCESS).setTitle(title).setDescription(description).setFooter({ text: BRAND });
}

function createErrorEmbed(description) {
    return new EmbedBuilder().setColor(config.COLORS.ERROR).setTitle('Error').setDescription(description).setFooter({ text: BRAND });
}

function createInfoEmbed(title, description, fields = []) {
    const embed = new EmbedBuilder().setColor(config.COLORS.INFO).setTitle(title).setDescription(description).setFooter({ text: BRAND });
    if (fields.length) embed.addFields(fields);
    return embed;
}

function createEndEmbed() {
    return new EmbedBuilder()
        .setColor(config.COLORS.PRIMARY)
        .setTitle('Queue Finished')
        .setDescription('All queued tracks have finished. Use `ش track name` to start again.')
        .setFooter({ text: BRAND });
}

function createControlPanel(track, queue) {
    return { embeds: [createNowPlayingEmbed(track, queue)], components: createMusicButtons(queue) };
}

function createHelpEmbed(client, prefix = config.PREFIX, userId) {
    const permissions = require('./permissions');
    const owner = permissions.isOwner(userId, client);
    const rootOwner = permissions.isRootOwner(userId, client);
    const embed = new EmbedBuilder().setColor(config.COLORS.PRIMARY).setTitle('Music — Commands')
        .setDescription('البريفكس: ' + (prefix || config.PREFIX) + ' · أوامر الموسيقى تعمل في قناة رومك النصية وبوت رومك الصوتي فقط. اكتب ويب لفتح واجهتك الخاصة.');
    if (client.user?.displayAvatarURL) embed.setThumbnail(client.user.displayAvatarURL());

    const commands = [...(client.commands?.values?.() || [])];
    const rootOrder = ['اونر', 'avatarall'];
    const ownerOrder = ['الحق', 'اخرج', 'تشخيص', 'اختبار_صوت', 'اصلاح', 'بريفكس', 'activity'];
    const musicOrder = [
        'ش', 'ش_الان', 'اضف', 'بحث', 'قائمة', 'ماشغل', 'توقف', 'كمل',
        'تخطى', 'السابق', 'اعد', 'رجع', 'قدم', 'انتقل', 'تخطى_لـ',
        'نقل', 'حذف', 'امسح', 'خلط', 'كرر', 'كرر_قائمة', 'صوت', 'رفع',
        'خفض', 'صم', 'فك_صم', 'احبها', 'مفضلة', 'كلمات', 'ويب', 'لوحة', 'help',
    ];
    const order = (items, priority) => [...items].sort((a, b) => {
        const ai = priority.indexOf(a.name), bi = priority.indexOf(b.name);
        if (ai < 0 && bi < 0) return String(a.name).localeCompare(String(b.name));
        if (ai < 0) return 1;
        if (bi < 0) return -1;
        return ai - bi;
    });
    const sections = [];
    if (rootOwner) sections.push(['👑 أوامر المالك الأساسي', order(commands.filter(c => c.rootOwnerOnly), rootOrder)]);
    if (owner) sections.push(['🎚️ أوامر تشغيل الموسيقى للمالك', order(commands.filter(c => c.ownerOnly && !c.rootOwnerOnly), ownerOrder)]);
    sections.push(['🎵 أوامر الموسيقى', order(commands.filter(c => !c.ownerOnly), musicOrder)]);

    const tick = String.fromCharCode(96);
    for (const [label, selected] of sections) {
        const rows = selected.map(c => tick + String(c.usage || c.name).replace(/^-/, '').slice(0, 100) + tick);
        let chunk = '', page = 1;
        for (const row of rows) {
            if ((chunk + row).length > 950) {
                embed.addFields({ name: label + ' · ' + page++, value: chunk });
                chunk = '';
            }
            chunk += row + '\n';
        }
        if (chunk) embed.addFields({ name: label + (page > 1 ? ' · ' + page : ''), value: chunk });
    }
    return embed.setFooter({ text: footerText('مكتبتك وسجلك مشتركان عبر جميع البوتات') });
}

module.exports = {
    createNowPlayingEmbed,
    createNowPlayingMessage,
    createNowPlayingPayload,
    createNowPlayingUpdate,
    createMusicButtons,
    createMoreMessage,
    createQueueEmbed,
    createQueueAddedEmbed,
    createFavoritesLauncherMessage,
    createFavoriteSavedEmbed,
    createFavoritesEmbed,
    createFavoritesButtons,
    createFavoritesMessage,
    createLyricsMessage,
    createLyricsPayload,
    createLyricsButtons,
    createSearchEmbed,
    createSuccessEmbed,
    createErrorEmbed,
    createInfoEmbed,
    createEndEmbed,
    createControlPanel,
    createHelpEmbed,
};
