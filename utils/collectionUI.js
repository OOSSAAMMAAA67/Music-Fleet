'use strict';
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const config = require('../config');
const { MusicPlayer } = require('./musicPlayer');
const { canonicalTrackKey } = require('./trackIdentity');
const { currentClient } = require('./playerContext');

const KINDS = new Set(['favorites', 'history', 'discover']);
const TITLES = { favorites: 'Library', history: 'Recently Played', discover: 'Discover' };
const PAGE_SIZE = 10;
const MAX_ACTIVE_SESSIONS = 800;
const cut = (value, limit) => String(value || 'Unknown').slice(0, limit);
const itemKey = t => canonicalTrackKey(t);

class CollectionSessions {
    constructor() { this.sessions = new Map(); }
    _key(user, kind) {
        if (!KINDS.has(kind)) throw new TypeError('Unknown collection');
        const botKey = currentClient()?.botKey;
        return `${botKey ? `${botKey}:` : ''}${user}:${kind}`;
    }
    _get(user, kind) {
        const key = this._key(user, kind);
        let session = this.sessions.get(key);
        if (session && session.expires < Date.now()) { this.sessions.delete(key); session = null; }
        if (!session) session = { selected: [], snapshot: [], expires: Date.now() + 14 * 60 * 1000 };
        // LRU touch: active sessions stay hot, abandoned sessions age out first.
        this.sessions.delete(key);
        this.sessions.set(key, session);
        if (this.sessions.size > MAX_ACTIVE_SESSIONS) {
            const now = Date.now();
            for (const [k, v] of this.sessions) {
                if (k !== key && v.expires < now) this.sessions.delete(k);
            }
            while (this.sessions.size > MAX_ACTIVE_SESSIONS) {
                const oldest = this.sessions.keys().next().value;
                if (!oldest || oldest === key) break;
                this.sessions.delete(oldest);
            }
        }
        return session;
    }
    setSnapshot(user, kind, tracks) { this._get(user, kind).snapshot = (tracks || []).map(t => ({ ...t })); }
    snapshot(user, kind) { return this._get(user, kind).snapshot.map(t => ({ ...t })); }
    add(user, kind, track) {
        const s = this._get(user, kind);
        if (!track?.url || s.selected.some(t => itemKey(t) === itemKey(track))) return false;
        s.selected.push({ ...track });
        return true;
    }
    list(user, kind) { return this._get(user, kind).selected.map(t => ({ ...t })); }
    clear(user, kind) { this._get(user, kind).selected = []; }
    close(user, kind) { this.sessions.delete(this._key(user, kind)); }
}

function createCollectionMessage(kind, user, tracks = [], page = 1, selected = []) {
    if (!KINDS.has(kind)) throw new TypeError('Unknown collection');
    const totalPages = Math.max(1, Math.ceil(tracks.length / PAGE_SIZE));
    const safePage = Math.max(1, Math.min(totalPages, Number(page) || 1));
    const offset = (safePage - 1) * PAGE_SIZE;
    const slice = tracks.slice(offset, offset + PAGE_SIZE);
    const owner = String(user.id);
    const text = slice.map((track, i) => `**${offset + i + 1}. ${cut(track.title, 125)}**\n${cut(track.author, 85)}  ·  ${MusicPlayer.formatDuration(track.duration)}`).join('\n\n');
    const embed = new EmbedBuilder()
        .setColor(config.COLORS.MUSIC)
        .setTitle(TITLES[kind])
        .setDescription(text || (kind === 'discover' ? 'Play tracks to build your recommendations.' : 'No tracks yet.'))
        .setFooter({ text: `${tracks.length} tracks · ${safePage} / ${totalPages} · Selected ${selected.length} · By ! A` });
    const rows = [];
    if (slice.length) {
        const options = slice.map((track, i) => ({ label: cut(track.title, 100), description: cut(track.author, 100), value: String(offset + i) }));
        rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
            .setCustomId(`coll_add:${kind}:${owner}:${safePage}`).setPlaceholder('Add one track · selection keeps click order')
            .addOptions(options)));
        if (kind === 'favorites') {
            rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
                .setCustomId(`coll_remove:${kind}:${owner}:${safePage}`).setPlaceholder('Remove a song from Library')
                .addOptions(options)));
        }
    }
    const button = (action, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder()
        .setCustomId(`coll_${action}:${kind}:${owner}:${safePage}`).setLabel(label).setStyle(style).setDisabled(disabled);
    rows.push(new ActionRowBuilder().addComponents(
        button('prev', '‹', ButtonStyle.Secondary, safePage === 1),
        button('next', '›', ButtonStyle.Secondary, safePage >= totalPages),
        button('refresh', '↻'),
    ));
    rows.push(new ActionRowBuilder().addComponents(
        button('play', 'Play Selected', ButtonStyle.Primary, !selected.length),
        button('queue', 'Queue Selected', ButtonStyle.Secondary, !selected.length),
        button('all', 'Play All', ButtonStyle.Secondary, !tracks.length),
        button('queueall', 'Queue All', ButtonStyle.Secondary, !tracks.length),
    ));
    rows.push(new ActionRowBuilder().addComponents(button('clear', 'Clear Selection', ButtonStyle.Secondary, !selected.length), button('close', 'Close')));
    return { embeds: [embed], components: rows };
}

const sessions = new CollectionSessions();
module.exports = { CollectionSessions, sessions, createCollectionMessage, PAGE_SIZE, KINDS };
