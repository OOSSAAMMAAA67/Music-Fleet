'use strict';
const crypto = require('node:crypto');
const cache = new Map();
const TTL = 10 * 60 * 1000;
const MAX_CACHE = 128;

function words(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2 &&
            !['official','video','audio','lyrics','music','song','topic','اغنية','اغنيه','رسمي'].includes(w));
}
function queriesFromHistory(history) {
    const all = history.filter(t => t?.title && t?.url);
    const counts = new Map();
    for (const t of all) {
        const artist = String(t.author || '').trim();
        if (artist && !/^(unknown|direct link)$/i.test(artist)) counts.set(artist, (counts.get(artist) || 0) + 1);
    }
    const artists = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name);
    // Sample the whole listening history, including older tastes, instead of
    // making every discovery depend on the currently playing song.
    const selected = [0, 1, Math.floor(all.length * .25), Math.floor(all.length * .5), Math.floor(all.length * .75)]
        .map(i => all[i]).filter(Boolean);
    return [...new Set([
        ...artists.map(a => `${a} similar music`),
        ...selected.map(t => `${t.author || ''} ${t.title} similar songs`),
    ])].slice(0, 8);
}
function scoreTrack(track, recent, wanted) {
    const title = new Set(words(track.title));
    const artist = new Set(words(track.author));
    let score = 0;
    const step = Math.max(1, Math.floor(recent.length / 120));
    for (let i = 0; i < recent.length; i += step) {
        const t = recent[i];
        for (const w of words(t.author)) if (artist.has(w)) score += 4 / Math.sqrt(1 + i / 15);
        for (const w of words(t.title)) if (title.has(w)) score += .5 / Math.sqrt(1 + i / 15);
    }
    if (track.thumbnail) score += 2;
    if (track.duration >= 60 && track.duration < 900) score += 2;
    return score + Math.max(0, 4 - wanted);
}
async function recommendFromHistory(history, { search, limit = 100 } = {}) {
    const recent = (history || []).filter(t => t?.url && t?.title);
    if (!recent.length) return [];
    const provider = search || require('./ytDlpProvider').search;
    const queries = queriesFromHistory(recent);
    const results = await Promise.allSettled(queries.map(q => provider(q, { limit: 25 })));
    const listened = new Set(recent.map(t => t.url));
    const seen = new Set();
    const found = [];
    results.forEach((result, q) => {
        if (result.status !== 'fulfilled' || !Array.isArray(result.value)) return;
        for (const item of result.value) {
            if (!item?.url || !/^https?:\/\//.test(item.url) || seen.has(item.url) || listened.has(item.url)) continue;
            seen.add(item.url);
            found.push({ track: { ...item }, score: scoreTrack(item, recent, q), group: q });
        }
    });
    const groups = queries.map((_, index) => found.filter(x => x.group === index)
        .sort((a, b) => b.score - a.score));
    const mixed = [];
    while (groups.some(g => g.length) && mixed.length < 100) {
        for (const group of groups) if (group.length && mixed.length < 100) mixed.push(group.shift().track);
    }
    return mixed.slice(0, Math.min(100, Math.max(1, Number(limit) || 100)));
}
async function recommendForUser(userId, history, options = {}) {
    const signature = crypto.createHash('sha1').update(JSON.stringify((history || []).map(x => x.url))).digest('hex');
    const key = `${userId}:${signature}:${options.limit || 100}`;
    const old = cache.get(key);
    if (old && old.until > Date.now()) return old.value.map(t => ({ ...t }));
    const value = await recommendFromHistory(history, options);
    cache.set(key, { value, until: Date.now() + TTL });
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return value.map(t => ({ ...t }));
}
module.exports = { recommendFromHistory, recommendForUser, queriesFromHistory };
