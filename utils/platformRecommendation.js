'use strict';

const DAY = 86400000;
const normalized = value => String(value || '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
const recordingKey = item => {
    const isrc = String(item?.isrc || '').replace(/[^a-z\d]/gi, '').toUpperCase();
    if (/^[A-Z]{2}[A-Z\d]{3}\d{7}$/.test(isrc)) return `isrc:${isrc}`;
    return `${normalized(item?.title)}::${normalized(item?.author)}`;
};

function releaseTime(item) {
    const value = String(item?.releaseDate || '');
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))?$/.test(value)) return NaN;
    const time = Date.parse(value), [year, month, date] = value.slice(0, 10).split('-').map(Number);
    if (!Number.isFinite(time) || new Date(Date.UTC(year, month - 1, date)).toISOString().slice(0, 10) !== value.slice(0, 10)) return NaN;
    return time;
}
function isFresh(item, now = Date.now(), windowDays = 120) {
    const date = releaseTime(item);
    return Number.isFinite(date) && date <= now && now - date <= windowDays * DAY;
}

function mergeCandidatePools(pools, { limit = 5000, rrfConstant = 40 } = {}) {
    const merged = new Map();
    for (const pool of pools || []) {
        const channel = String(pool?.channel || 'catalog').slice(0, 80), weight = Math.max(0, Math.min(5, Number(pool?.weight) || 0));
        if (!weight || !Array.isArray(pool?.items)) continue;
        const seenInPool = new Set();
        for (let index = 0; index < pool.items.length; index++) {
            const item = pool.items[index];
            if (!item?.title || !['track', 'video'].includes(item.kind)) continue;
            const key = recordingKey(item);
            if (key === '::' || seenInPool.has(key)) continue;
            seenInPool.add(key);
            let entry = merged.get(key);
            if (!entry) {
                entry = { item: { ...item }, rrfScore: 0, channels: [], profileGenres: new Set(), _channelKeys: new Set() };
                merged.set(key, entry);
            } else {
                const combined = { ...entry.item };
                for (const field of ['isrc', 'artistId', 'albumId', 'album', 'releaseDate', 'duration', 'thumbnail', 'providerUrl', 'url', 'previewUrl', 'genre', 'explicit']) {
                    if ((combined[field] == null || combined[field] === '' || combined[field] === 0) && item[field] != null && item[field] !== '') combined[field] = item[field];
                }
                combined.genres = [...new Set([...(combined.genres || []), ...(item.genres || [])])].slice(0, 12);
                if (item.provenance && !combined.provenance) combined.provenance = item.provenance;
                entry.item = combined;
            }
            entry.rrfScore += weight / (rrfConstant + index + 1);
            if (pool.genre) entry.profileGenres.add(normalized(pool.genre));
            if (!entry._channelKeys.has(channel)) {
                entry._channelKeys.add(channel);
                entry.channels.push({ channel, rank: index + 1, weight });
            }
        }
    }
    const entries = [...merged.values()].sort((a, b) => b.rrfScore - a.rrfScore
        || recordingKey(a.item).localeCompare(recordingKey(b.item))).slice(0, Math.max(0, limit));
    const evidence = new Map();
    for (const entry of entries) {
        delete entry._channelKeys;
        entry.channelCount = entry.channels.length;
        evidence.set(recordingKey(entry.item), { rrfScore: entry.rrfScore, channelCount: entry.channelCount,
            channels: entry.channels, profileGenres: [...entry.profileGenres] });
    }
    return { items: entries.map(entry => entry.item), evidence };
}

function buildTransitionModel(events, signals = [], now = Date.now(), { maxGapMs = 6 * 60 * 60 * 1000 } = {}) {
    const skipped = new Set((signals || []).filter(signal => signal?.type === 'skip' && signal.eventId).map(signal => String(signal.eventId)));
    const ordered = [];
    let sorted = true, previousAt = -Infinity;
    for (const event of events || []) {
        const at = Date.parse(event?.at || ''), seconds = Number(event?.seconds), duration = Number(event?.track?.duration) || 0;
        if (!event?.track?.title || !Number.isFinite(at) || at > now || !Number.isFinite(seconds) || seconds < 10) continue;
        if (at < previousAt) sorted = false;
        previousAt = at;
        ordered.push({ event, at, seconds, duration, key: recordingKey(event.track), skipped: skipped.has(String(event.id || '')) });
    }
    if (!sorted) ordered.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
    const graph = new Map();
    for (let index = 0; index + 1 < ordered.length; index++) {
        const from = ordered[index], to = ordered[index + 1], gap = to.at - from.at;
        if (gap < 0 || gap > maxGapMs || from.skipped || to.skipped || from.key === to.key) continue;
        const fromRatio = from.duration > 0 ? Math.min(1, from.seconds / from.duration) : from.event.completed ? 1 : 0;
        const toRatio = to.duration > 0 ? Math.min(1, to.seconds / to.duration) : to.event.completed ? 1 : 0;
        const fromQualified = from.seconds >= 30 && (from.event.completed || fromRatio >= 0.85)
            && !(from.event.endedAt && !from.event.completed && from.event.endReason !== 'skip' && fromRatio < 0.85);
        const toQualified = to.seconds >= 20 && (to.event.completed || toRatio >= 0.2);
        if (!fromQualified || !toQualified) continue;
        let targets = graph.get(from.key);
        if (!targets) { targets = new Map(); graph.set(from.key, targets); }
        let edge = targets.get(to.key);
        if (!edge) { edge = { track: to.event.track, count: 0, weight: 0, daySet: new Set(), lastAt: '' }; targets.set(to.key, edge); }
        const ageDays = Math.max(0, (now - to.at) / DAY), recency = 0.08 + 0.92 * Math.exp(-ageDays / 180);
        const listeningConfidence = Math.sqrt(Math.max(0, fromRatio) * Math.max(0, toRatio));
        edge.count++;
        edge.weight += Math.max(0.1, listeningConfidence) * recency;
        edge.daySet.add(new Date(to.at).toISOString().slice(0, 10));
        edge.lastAt = new Date(to.at).toISOString();
    }
    for (const targets of graph.values()) for (const edge of targets.values()) {
        edge.days = edge.daySet.size;
        delete edge.daySet;
    }
    return graph;
}

function transitionScore(model, seed, candidate, now = Date.now()) {
    const edge = model?.get(recordingKey(seed))?.get(recordingKey(candidate));
    if (!edge) return 0;
    const ageDays = Math.max(0, (now - Date.parse(edge.lastAt || '')) / DAY);
    const support = 1 - Math.exp(-Math.max(0, edge.count) / 2.5);
    const consistency = 0.55 + 0.45 * (1 - Math.exp(-Math.max(0, edge.days) / 3));
    const recency = 0.08 + 0.92 * Math.exp(-ageDays / 180);
    return 3.5 * support * consistency * recency;
}

function transitionCandidates(model, seed, limit = 12, now = Date.now()) {
    const targets = model?.get(recordingKey(seed));
    if (!targets) return [];
    return [...targets.entries()].map(([key, edge]) => ({ item: edge.track, key, score: transitionScore(model, seed, edge.track, now), count: edge.count }))
        .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, Math.max(0, limit)).map(value => value.item);
}
function artistKey(item) {
    return normalized(item?.author || (item?.kind === 'artist' ? item.title : '')) || `uncredited:${normalized(item?.title)}`;
}
function albumKey(item) {
    const album = normalized(item?.album || (item?.kind === 'album' ? item.title : ''));
    const artist = normalized(item?.author || item?.artist);
    // Catalog providers often assign different IDs to the same release. Use
    // the human-readable album/artist identity first so those copies do not
    // defeat the one-track-per-album diversity rule.
    if (album && artist) return `album:${album}::${artist}`;
    if (album) return `album:${album}`;
    return String(item?.albumId || item?.releaseGroupId || '').trim();
}
function genreKeys(item) { return [...new Set([...(item?.genres || []), item?.genre].filter(Boolean).map(normalized))]; }
function genreSimilarity(a, b) {
    const left = genreKeys(a), right = new Set(genreKeys(b));
    if (!left.length || !right.size) return 0;
    let intersection = 0;
    for (const genre of left) if (right.has(genre)) intersection++;
    return intersection / (left.length + right.size - intersection);
}

// Diversity quotas reserve room across artists and albums before relevance
// breaks ties. Mixes and Explore shelves keep hard quotas; radio can relax them.
function diversify(ranked, { id = 'daily-discovery', limit = 40 } = {}) {
    const mix = id.startsWith('mix-'), explore = id.startsWith('explore:');
    const staff = id.startsWith('staff:');
    const albumShelf = id === 'albums-youll-enjoy' || id === 'staff:albums';
    const strict = id === 'new-arrivals' || mix || explore;
    const artistLimit = id === 'new-arrivals' || albumShelf ? 1
        : id === 'daily-discovery' || mix || explore || staff ? 2 : id === 'radio' ? 4 : Infinity;
    const albumLimit = id === 'new-arrivals' || mix || explore || albumShelf || staff ? 1 : id === 'radio' ? 2 : Infinity;
    const diversityWeight = id === 'daily-discovery' ? 0.42 : id === 'new-arrivals' ? 0.38
        : mix ? 0.44 : explore ? 0.46 : albumShelf ? 0.4 : staff ? 0.36
            : id === 'radio' ? 0.32 : id.startsWith('genre:') ? 0.28 : 0.22;
    const selected = [], artistCounts = new Map(), albumCounts = new Map(), remaining = [...ranked];
    const scores = remaining.map(value => Number(value.score) || 0);
    const minScore = scores.length ? Math.min(...scores) : 0, maxScore = scores.length ? Math.max(...scores) : 0, scoreRange = maxScore - minScore || 1;
    while (remaining.length && selected.length < limit) {
        const artistsWithRoom = new Set();
        for (const value of remaining) {
            const artist = artistKey(value.item);
            if ((artistCounts.get(artist) || 0) < artistLimit) artistsWithRoom.add(artist);
        }
        const albumsWithRoom = new Set();
        for (const value of remaining) {
            const artist = artistKey(value.item), album = albumKey(value.item);
            const artistAvailable = (artistCounts.get(artist) || 0) < artistLimit || !artistsWithRoom.size;
            if (artistAvailable && album && (albumCounts.get(album) || 0) < albumLimit) albumsWithRoom.add(album);
        }
        let best = -1, bestScore = -Infinity;
        for (let index = 0; index < remaining.length; index++) {
            const item = remaining[index].item, artist = artistKey(item), album = albumKey(item);
            const artistCount = artistCounts.get(artist) || 0, albumCount = album ? albumCounts.get(album) || 0 : 0;
            if (artistCount >= artistLimit && (strict || artistsWithRoom.size)) continue;
            if (album && albumCount >= albumLimit && (strict || albumsWithRoom.size)) continue;
            const relevance = ((Number(remaining[index].score) || 0) - minScore) / scoreRange;
            const redundancy = selected.reduce((maximum, chosen) => {
                const sameArtist = artistKey(item) === artistKey(chosen.item) ? 1 : 0;
                const sameAlbum = album && album === albumKey(chosen.item) ? 1 : 0;
                return Math.max(maximum, sameArtist * 0.9, sameAlbum * 0.82, genreSimilarity(item, chosen.item) * 0.72);
            }, 0);
            const score = relevance * (1 - diversityWeight) - redundancy * diversityWeight;
            if (score > bestScore) { best = index; bestScore = score; }
        }
        if (best < 0) break;
        const [value] = remaining.splice(best, 1), item = value.item;
        const artist = artistKey(item), album = albumKey(item);
        artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
        if (album) albumCounts.set(album, (albumCounts.get(album) || 0) + 1);
        selected.push(value);
    }
    return selected;
}

module.exports = { releaseTime, isFresh, recordingKey, mergeCandidatePools, buildTransitionModel, transitionScore, transitionCandidates, diversify };
