'use strict';

const provider = require('./ytDlpProvider');
const MB = 'https://musicbrainz.org/ws/2';
const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const cache = new Map();
let mbQueue = Promise.resolve();
let lastMbRequest = 0;

async function mbJson(path) {
    // MusicBrainz asks clients to stay at or below one request per second.
    const request = mbQueue.catch(() => {}).then(async () => {
        const delay = Math.max(0, lastMbRequest + 1100 - Date.now());
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        lastMbRequest = Date.now();
        const response = await fetch(`${MB}${path}${path.includes('?') ? '&' : '?'}fmt=json`, {
            headers: { 'User-Agent': 'MusicByA/5.9.2 (personal Discord music bot; By ! A)', Accept: 'application/json' },
            signal: AbortSignal.timeout(8500),
        });
        if (!response.ok) throw new Error(`Catalog metadata HTTP ${response.status}`);
        return response.json();
    });
    mbQueue = request;
    return request;
}

function cached(key, work, ttl = 15 * 60_000) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = Promise.resolve().then(work).catch(err => { cache.delete(key); throw err; });
    cache.set(key, { value, expires: Date.now() + ttl });
    while (cache.size > 200) cache.delete(cache.keys().next().value);
    return value;
}
function credit(item) {
    return item?.['artist-credit']?.map(x => x.name || x.artist?.name || (typeof x === 'string' ? x : '')).join('') || item?.artist || 'Unknown artist';
}
function albumItem(item) {
    return { kind: 'album', id: item.id, title: item.title, author: credit(item),
        subtitle: [item['primary-type'], item['first-release-date']?.slice(0, 4)].filter(Boolean).join(' · '),
        thumbnail: `https://coverartarchive.org/release-group/${item.id}/front-500` };
}
function artistItem(item) {
    return { kind: 'artist', id: item.id, title: item.name, author: item.disambiguation || item.area?.name || 'Artist',
        subtitle: item.country || '', thumbnail: '' };
}
function trackItem(item) {
    return { kind: 'track', title: item.title, author: item.author, url: item.url,
        thumbnail: item.thumbnail || '', duration: Number(item.duration || 0) };
}

function createCatalog({ metadata = mbJson, tracks = provider.search } = {}) {
    async function search(query, type = 'tracks') {
        const q = String(query || '').trim().slice(0, 120);
        if (q.length < 2) return [];
        if (type === 'tracks') return (await tracks(q, { limit: 25 })).map(trackItem);
        if (type === 'artists') {
            const data = await metadata(`/artist?query=${encodeURIComponent(q)}&limit=12`);
            return (data.artists || []).filter(x => UUID.test(x.id)).map(artistItem);
        }
        if (type === 'albums') {
            const data = await metadata(`/release-group?query=${encodeURIComponent(q)}&limit=20`);
            return (data['release-groups'] || []).filter(x => UUID.test(x.id) && x['primary-type'] === 'Album').map(albumItem);
        }
        throw new Error('Unknown search type.');
    }
    async function detail(type, id) {
        if (!UUID.test(String(id || ''))) throw new Error('Invalid catalog ID.');
        if (type === 'artist') {
            const artist = await metadata(`/artist/${id}`);
            const [albums, topTracks] = await Promise.all([
                metadata(`/release-group?artist=${id}&limit=60`),
                tracks(artist.name, { limit: 12 }).catch(() => []),
            ]);
            return { ...artistItem(artist), albums: (albums['release-groups'] || [])
                .filter(x => UUID.test(x.id) && x['primary-type'] === 'Album').map(albumItem).slice(0, 50),
                tracks: topTracks.map(trackItem) };
        }
        if (type === 'album') {
            const album = await metadata(`/release-group/${id}?inc=releases`);
            const releases = album.releases || [];
            const chosen = releases.find(x => x.status === 'Official') || releases[0];
            let songs = [];
            if (chosen?.id && UUID.test(chosen.id)) {
                const release = await metadata(`/release/${chosen.id}?inc=recordings+artist-credits`);
                songs = (release.media || []).flatMap(m => m.tracks || []).map(x => ({
                    kind: 'track', title: x.title || x.recording?.title || 'Unknown',
                    author: credit(x) === 'Unknown artist' ? credit(album) : credit(x),
                    duration: Number(x.length || x.recording?.length || 0) / 1000,
                    thumbnail: `https://coverartarchive.org/release-group/${id}/front-500`,
                    albumId: id,
                })).slice(0, 100);
            }
            return { ...albumItem(album), tracks: songs };
        }
        throw new Error('Unknown catalog view.');
    }
    async function resolveSong(track) {
        if (track?.url && /^https?:\/\//.test(track.url)) return track;
        const title = String(track?.title || '').trim().slice(0, 180);
        const author = String(track?.author || '').trim().slice(0, 120);
        if (!title || !author) throw new Error('Track is missing title or artist.');
        const candidates = await tracks(`${author} ${title} audio`, { limit: 8 });
        const tokens = s => new Set(String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(x => x.length > 2));
        const expected = tokens(`${title} ${author}`);
        const rank = c => {
            const actual = tokens(`${c.title} ${c.author}`);
            let score = [...expected].filter(w => actual.has(w)).length;
            if (/\b(cover|reaction|karaoke|nightcore|slowed)\b/i.test(c.title) && !/\b(cover|nightcore|slowed)\b/i.test(title)) score -= 3;
            return score;
        };
        candidates.sort((a, b) => rank(b) - rank(a));
        const selected = candidates[0];
        if (!selected?.url) throw new Error('No playable source found for this song.');
        return { ...selected, title, author, thumbnail: track.thumbnail || selected.thumbnail,
            duration: Number(selected.duration || track.duration || 0) };
    }
    return {
        search: (query, type) => cached(`search:${type}:${String(query).toLowerCase()}`, () => search(query, type)),
        detail: (type, id) => cached(`detail:${type}:${id}`, () => detail(type, id)),
        resolveSong,
    };
}

module.exports = createCatalog();
module.exports.createCatalog = createCatalog;
