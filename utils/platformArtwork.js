'use strict';

// Shelf artwork has its own small HTTP budget. It must never borrow the current
// player's artwork engine, source extractor, or audio-startup workers.
const net = require('node:net');

const ARTWORK_IMAGE_HOSTS = Object.freeze([
    'dzcdn.net', 'mzstatic.com', 'coverartarchive.org', 'archive.org',
    'scdn.co', 'tidal.com', 'sndcdn.com', 'wikimedia.org',
    'i.ytimg.com', 'img.youtube.com',
]);
const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const RASTER = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp', 'image/x-ms-bmp']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const USER_AGENT = 'MusicByA/7.2 (catalog artwork; https://musicbrainz.org)';
const text = value => String(value ?? '').trim();
const copy = value => structuredClone(value);
const norm = value => text(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const year = value => /^(\d{4})/.exec(text(value))?.[1] || '';
const array = value => Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];
const error = (message, code = 'ARTWORK_UNAVAILABLE') => Object.assign(new Error(message), { code });

function isAllowedArtworkUrl(input) {
    if (typeof input !== 'string' || !input || input.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(input)) return false;
    try {
        const u = new URL(input), host = u.hostname.toLowerCase();
        if (u.protocol !== 'https:' || u.username || u.password || u.port || net.isIP(host.replace(/^\[|\]$/g, ''))) return false;
        // URL removes an explicit default port; reject it in the input as well.
        if (/^https:\/\/[^/?#]*:/i.test(input) || host.endsWith('.')) return false;
        return ARTWORK_IMAGE_HOSTS.some(base => host === base || host.endsWith(`.${base}`));
    } catch (_) { return false; }
}

function selectedRelease(item) {
    for (const value of [item?.releaseId, item?.albumId]) {
        const id = text(value).replace(/^musicbrainz:release:/, '');
        if (UUID.test(id)) return id.toLowerCase();
    }
    return '';
}
function identity(item) {
    const match = /^(deezer|itunes|musicbrainz|youtube):(track|album|artist|video|release|playlist):([^:]+)$/.exec(text(item?.id));
    if (!match || item?.kind && item.kind !== match[2] && !(match[1] === 'musicbrainz' && match[2] === 'release' && item.kind === 'album')) return null;
    const [, provider, kind, id] = match;
    if (kind === 'playlist' && provider !== 'deezer') return null;
    if (provider === 'musicbrainz' ? !UUID.test(id) : provider === 'youtube' ? !/^[\w-]{11}$/.test(id) || !['track', 'video'].includes(kind) : !/^\d{1,20}$/.test(id) || kind === 'release') return null;
    const key = `${provider}:${kind}:${provider === 'musicbrainz' ? id.toLowerCase() : id}`;
    return { provider, kind: kind === 'release' ? 'album' : kind, entityKind: kind,
        id: provider === 'musicbrainz' ? id.toLowerCase() : id, key,
        cacheKey: provider === 'musicbrainz' && kind === 'track' ? JSON.stringify([key, selectedRelease(item), text(item.releaseDate)])
            : provider === 'youtube' ? JSON.stringify([key, text(item.mediaTitle || item.title), text(item.mediaArtist || item.author), text(item.album), text(item.releaseDate), Number(item.duration || 0)]) : key };
}

function videoId(input) {
    try {
        const u = new URL(text(input)), host = u.hostname.toLowerCase();
        if (u.protocol !== 'https:' || u.username || u.password || u.port) return '';
        let id = '';
        if (host === 'youtu.be') id = /^\/([\w-]{11})\/?$/.exec(u.pathname)?.[1] || '';
        else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
            id = u.pathname === '/watch' ? u.searchParams.get('v') || '' : /^\/(?:shorts|live)\/([\w-]{11})\/?$/.exec(u.pathname)?.[1] || '';
        }
        return /^[\w-]{11}$/.test(id) ? id : '';
    } catch (_) { return ''; }
}

function exactVideo(item, ident) {
    const ids = [videoId(item?.providerUrl), videoId(item?.url)].filter(Boolean);
    return ident?.provider === 'youtube' ? ids.find(id => id === ident.id) || '' : ids[0] || '';
}

function credit(value) {
    return array(value?.['artist-credit']).map(x => typeof x === 'string' ? x : `${x.name || x.artist?.name || ''}${x.joinphrase || ''}`).join('');
}
function deezerTitle(value) {
    const title = text(value?.title), version = text(value?.title_version);
    return version && !norm(title).endsWith(norm(version)) ? `${text(value?.title_short) || title} ${version}` : title;
}
function appleImage(input) {
    return isAllowedArtworkUrl(input) ? input.replace(/\/\d+x\d+bb(?=[-.\/])/, '/1200x1200bb') : '';
}
function youtubeTarget(item) {
    const clean = value => text(value).replace(/（/g, '(').replace(/）/g, ')').replace(/[‐‑‒–—−]/g, '-')
        .replace(/\b(?:official\s+(?:(?:music|lyrics?)\s+)?(?:audio|video|mv)|music\s+(?:video|clip)|lyrics?\s+video|(?:video|audio)\s+release|audio|video|lyrics?|visualizer|mv|hd|hq|4k|8k)\b/gi, ' ')
        .replace(/[([]\s*[)\]]/g, ' ').replace(/\s+/g, ' ').trim();
    const artist = value => clean(value).replace(/\s*-\s*Topic$/i, '').replace(/\s*VEVO$/i, '').replace(/\s+(?:official(?:\s+youtube)?(?:\s+channel)?|youtube\s+channel)$/i, '').trim();
    let title = clean(item.mediaTitle || item.title), author = artist(item.mediaArtist || item.author);
    const raw = text(item.mediaTitle || item.title), pieces = raw.split(/\s*[|｜]\s*/u);
    if (pieces.length > 1 && /\s[-–—]\s/.test(pieces[0])) title = clean(pieces[0]);
    const by = raw.match(/["“\[]([^"”\]]{2,120})["”\]]\s*(?:[-–—|:]\s*)?by\s+([^|\[(]{2,140})/iu)
        || raw.match(/\b(?:opening|ending|op|ed)\s+(?:full\s+)?([^|"“\[(]{2,120}?)\s+by\s+([^|\[(]{2,140})/iu);
    if (by) { title = clean(by[1]); author = artist(by[2]).replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, '').trim(); }
    else {
        const split = title.match(/^(.{1,120}?)\s+-\s+(.{2,200})$/u);
        if (split && !/\b(?:opening|ending|season|playlist|compilation)\b/i.test(split[1])) { author = artist(split[1]); title = clean(split[2]); }
        else {
            const words = title.split(/\s+/), key = norm(author).replace(/\s/g, '');
            for (let count = 1; key && count < Math.min(words.length, 6); count++) if (norm(words.slice(0, count).join(' ')).replace(/\s/g, '') === key) {
                title = clean(words.slice(count).join(' ').replace(/(?<=\p{L})(?:19|20)\d{2}$/u, '')); break;
            }
        }
    }
    return { ...item, title, author };
}
function targetFrom(item, value, provider, kind) {
    if (provider === 'deezer') return { ...item, title: kind === 'artist' ? value.name : deezerTitle(value),
        author: kind === 'artist' ? value.name : value.artist?.name || item.author,
        album: kind === 'album' ? value.title : value.album?.title || item.album,
        albumId: value.album?.id ? `deezer:album:${value.album.id}` : item.albumId,
        artistId: value.artist?.id ? `deezer:artist:${value.artist.id}` : item.artistId,
        duration: Number(value.duration || item.duration || 0), releaseDate: value.release_date || item.releaseDate };
    if (provider === 'itunes') return { ...item, title: kind === 'artist' ? value.artistName : kind === 'album' ? value.collectionName : value.trackName,
        author: value.artistName, album: value.collectionName || item.album,
        albumId: value.collectionId ? `itunes:album:${value.collectionId}` : item.albumId,
        artistId: value.artistId ? `itunes:artist:${value.artistId}` : item.artistId,
        duration: Number(value.trackTimeMillis || 0) / 1000 || item.duration,
        releaseDate: value.releaseDate || item.releaseDate };
    return { ...item, title: kind === 'artist' ? value.name : value.title,
        author: kind === 'artist' ? value.name : credit(value) || item.author,
        duration: Number(value.length || 0) / 1000 || item.duration,
        releaseDate: value['first-release-date'] || value.date || item.releaseDate };
}

// Cross-provider artwork is useful only when every supplied identity constraint
// agrees. In particular, a clean recording cannot stand in for a named remix.
function exactMatch(target, value, provider, kind, youtube = false) {
    const candidate = provider === 'itunes' ? {
        title: kind === 'album' ? value.collectionName : value.trackName, author: value.artistName,
        album: value.collectionName, releaseDate: value.releaseDate, duration: Number(value.trackTimeMillis || 0) / 1000,
    } : { title: kind === 'album' ? value.title : deezerTitle(value), author: value.artist?.name,
        album: kind === 'album' ? value.title : value.album?.title, releaseDate: value.release_date || value.album?.release_date,
        duration: Number(value.duration || 0) };
    const sameArtist = norm(target.author) === norm(candidate.author) || youtube && /^(.+?)\s*(?:&|,|\bfeat\.?|\bft\.?|\bfeaturing\b)\s*/i.test(candidate.author || '')
        && norm(target.author) === norm(/^(.+?)\s*(?:&|,|\bfeat\.?|\bft\.?|\bfeaturing\b)\s*/i.exec(candidate.author)[1]);
    const titleKey = value => norm(youtube ? text(value).replace(/\s*[([]?\s*(?:feat\.?|ft\.?|featuring)\s+[^)\]]+[)\]]?/ig, ' ').replace(/[([]\s*[)\]]/g, '') : value);
    if (!titleKey(target.title) || titleKey(target.title) !== titleKey(candidate.title) || !norm(target.author) || !sameArtist) return false;
    if (target.album && norm(target.album) !== norm(candidate.album)) return false;
    const version = text(target.version || target.title_version);
    if (version && !norm(candidate.title).includes(norm(version))) return false;
    const targetYear = year(target.releaseDate || target.year);
    if (targetYear && targetYear !== year(candidate.releaseDate)) return false;
    const duration = Number(target.duration || 0);
    return kind === 'album' || !duration || candidate.duration > 0 && Math.abs(duration - candidate.duration) <= (youtube ? Math.max(45, duration * 0.22) : Math.min(3, Math.max(1, duration * 0.01)));
}

function imageBytes(buffer) {
    if (!buffer?.length) return false;
    const b = Buffer.from(buffer);
    return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
        || b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || /^GIF8[79]a$/.test(b.subarray(0, 6).toString('ascii'))
        || b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP'
        || b.subarray(4, 8).toString('ascii') === 'ftyp' && /avif|avis/.test(b.subarray(8, 32).toString('ascii'))
        || b[0] === 0x42 && b[1] === 0x4d;
}

function createPlatformArtwork(options = {}) {
    const fetchImpl = options.fetch || globalThis.fetch;
    const now = options.now || Date.now;
    const timeoutMs = Math.max(10, Math.min(18000, Number(options.timeoutMs) || 18000));
    const maxConcurrent = Math.max(1, Math.min(3, Math.floor(Number(options.maxConcurrent) || 3)));
    const maxQueue = Math.max(1, Math.min(36, Math.floor(Number(options.maxQueue) || 36)));
    const intervals = { deezer: 100, itunes: 150, musicbrainz: 1000, wikidata: 150, wikimedia: 100, image: 0, ...options.providerIntervalsMs };
    const queue = [], nextAt = new Map(), contexts = new Set();
    const cache = new Map(), inflight = new Map(), failures = new Map(), metadataCache = new Map(), validationCache = new Map();
    let active = 0, pumpTimer = null, closed = false;

    function boundedSet(map, key, value, limit = 500) {
        if (closed) return;
        map.delete(key); map.set(key, value);
        while (map.size > limit) map.delete(map.keys().next().value);
    }
    function pump() {
        if (closed) return;
        if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
        while (queue.length && active < maxConcurrent) {
            const at = Date.now();
            const index = queue.findIndex(job => (nextAt.get(job.provider) || 0) <= at);
            if (index < 0) {
                const wait = Math.max(1, Math.min(...queue.map(job => nextAt.get(job.provider) || at)) - at);
                pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, wait); return;
            }
            const job = queue.splice(index, 1)[0];
            if (job.context.signal.aborted) { job.abort(); continue; }
            job.started = true; active++;
            nextAt.set(job.provider, at + Math.max(0, Number(intervals[job.provider]) || 0));
            // The physical slot belongs to the real operation, not its visible
            // deadline. Even a fetch implementation ignoring AbortSignal must
            // finish before another HTTP operation can take this slot.
            Promise.resolve().then(() => {
                if (closed || job.context.signal.aborted) throw error('Artwork work was cancelled.', 'ARTWORK_CANCELLED');
                return job.work(job.context.signal);
            }).then(job.resolve, job.reject).finally(() => {
                job.context.signal.removeEventListener('abort', job.abort); active--; pump();
            });
        }
    }
    function schedule(provider, context, work) {
        if (closed || context.signal.aborted) return Promise.reject(error('Artwork work was cancelled.', 'ARTWORK_CANCELLED'));
        if (queue.length >= maxQueue) return Promise.reject(error('Artwork HTTP queue is full.', 'ARTWORK_BUSY'));
        return new Promise((resolve, reject) => {
            const job = { provider, context, work, resolve, reject, started: false };
            job.abort = () => {
                if (!job.started) { const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1); context.signal.removeEventListener('abort', job.abort); }
                reject(error('Artwork deadline expired or work was cancelled.', 'ARTWORK_CANCELLED'));
                pump();
            };
            context.signal.addEventListener('abort', job.abort, { once: true });
            queue.push(job); pump();
        });
    }
    async function cancelBody(response) {
        try { await response.body?.cancel?.(); } catch (_) { /* a consumed response has no body to cancel */ }
    }
    function metadataUrl(input, provider) {
        try {
            const u = new URL(input);
            const hosts = { deezer: ['api.deezer.com'], itunes: ['itunes.apple.com'], musicbrainz: ['musicbrainz.org'],
                wikidata: ['www.wikidata.org', 'wikidata.org'], wikimedia: ['commons.wikimedia.org'] };
            return u.protocol === 'https:' && !u.username && !u.password && !u.port && hosts[provider]?.includes(u.hostname);
        } catch (_) { return false; }
    }
    async function metadata(provider, input, context) {
        context.metadataKeys.add(input);
        const cached = metadataCache.get(input);
        if (cached && cached.expires > now()) return copy(cached.value);
        let target = input;
        for (let hop = 0; hop <= 3; hop++) {
            if (!metadataUrl(target, provider)) throw error('Metadata redirect left its provider.');
            const response = await schedule(provider, context, async signal => {
                const r = await fetchImpl(target, { signal, redirect: 'manual', headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } });
                if (r.url && !metadataUrl(r.url, provider)) { await cancelBody(r); throw error('Metadata returned an unexpected URL.'); }
                const status = Number(r.status), location = r.headers?.get?.('location');
                if ([301, 302, 303, 307, 308].includes(status)) { await cancelBody(r); return { location }; }
                if (status < 200 || status >= 300 || Number(r.headers?.get?.('content-length') || 0) > 5 * 1024 * 1024) { await cancelBody(r); throw error('Catalog metadata is unavailable.'); }
                try { const value = await r.json(); if (value?.error) throw error('Catalog metadata is unavailable.'); return { value }; }
                finally { await cancelBody(r); }
            });
            if (response.location) { target = new URL(response.location, target).href; continue; }
            if (!context.signal.aborted) boundedSet(metadataCache, input, { value: response.value, expires: now() + 30 * 60_000 });
            return response.value;
        }
        throw error('Metadata redirected too many times.');
    }
    async function imageRequest(input, method, context) {
        let target = input;
        for (let hop = 0; hop <= 5; hop++) {
            if (!isAllowedArtworkUrl(target)) return { validation: 'failed' };
            const response = await schedule('image', context, async signal => {
                const r = await fetchImpl(target, { method, signal, redirect: 'manual', headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif', 'User-Agent': USER_AGENT,
                    ...(method === 'GET' ? { Range: 'bytes=0-1023' } : {}) } });
                const actualUrl = r.url || target;
                if (!isAllowedArtworkUrl(actualUrl)) { await cancelBody(r); return { validation: 'failed' }; }
                const status = Number(r.status), location = r.headers?.get?.('location');
                if ([301, 302, 303, 307, 308].includes(status)) { await cancelBody(r); return { location, base: actualUrl }; }
                const mime = text(r.headers?.get?.('content-type')).split(';')[0].toLowerCase();
                const length = Number(r.headers?.get?.('content-length') || 0);
                if (method === 'HEAD' && [405, 501].includes(status)) { await cancelBody(r); return { validation: 'get', finalUrl: actualUrl }; }
                if (status >= 500 || status === 408 || status === 429) { await cancelBody(r); return { validation: 'unavailable', finalUrl: actualUrl }; }
                if (status < 200 || status >= 300 || length > MAX_IMAGE_BYTES || mime === 'image/svg+xml') { await cancelBody(r); return { validation: 'failed' }; }
                if (method === 'HEAD') {
                    await cancelBody(r);
                    return { validation: RASTER.has(mime) ? 'verified' : !mime || mime === 'application/octet-stream' ? 'get' : 'failed', finalUrl: actualUrl };
                }
                if (mime && !RASTER.has(mime) && mime !== 'application/octet-stream') { await cancelBody(r); return { validation: 'failed' }; }
                let bytes;
                try {
                    if (r.body?.getReader) {
                        const reader = r.body.getReader(); const parts = []; let count = 0;
                        try {
                            while (count < 1024) { const part = await reader.read(); if (part.done) break; parts.push(Buffer.from(part.value).subarray(0, 1024 - count)); count += parts.at(-1).length; }
                            bytes = Buffer.concat(parts);
                        } finally { await reader.cancel().catch(() => {}); }
                    } else if (r.arrayBuffer) bytes = Buffer.from(await r.arrayBuffer()).subarray(0, 1024);
                    else bytes = Buffer.alloc(0);
                } finally { await cancelBody(r); }
                return { validation: imageBytes(bytes) ? 'verified' : 'failed', finalUrl: actualUrl };
            });
            if (response.location) {
                if (hop === 5) return { validation: 'failed' };
                try { target = new URL(response.location, response.base || target).href; } catch (_) { return { validation: 'failed' }; }
                continue;
            }
            return response;
        }
        return { validation: 'failed' };
    }
    async function validate(input, context) {
        const hit = validationCache.get(input);
        if (hit && hit.expires > now()) return hit.value;
        let result;
        try {
            result = await imageRequest(input, 'HEAD', context);
            if (result.validation === 'get') result = await imageRequest(input, 'GET', context);
        } catch (_) { result = { validation: 'unavailable' }; }
        if (!context.signal.aborted) boundedSet(validationCache, input, { value: result, expires: now() + (result.validation === 'verified' ? 30 * 60_000 : result.validation === 'failed' ? 60_000 : 5000) });
        return result;
    }
    function getFailed(key, urls) {
        let record = failures.get(key);
        if (!record || record.expires <= now()) record = { urls: new Set(), expires: now() + 30 * 60_000 };
        for (const url of array(urls).slice(0, 36)) if (isAllowedArtworkUrl(url)) { record.urls.add(url); validationCache.delete(url); }
        while (record.urls.size > 36) record.urls.delete(record.urls.values().next().value);
        // Keep the empty record too: a concurrent failed-image report must
        // update the very same set used by an already running identity job.
        boundedSet(failures, key, record);
        return record.urls;
    }
    function candidate(url, provider, source, context, details = {}) {
        if (!isAllowedArtworkUrl(url) || context.failed.has(url)) return null;
        const host = new URL(url).hostname;
        if (provider !== 'youtube' && /(?:^|\.)(?:ytimg\.com|youtube\.com)$/.test(host)) return null;
        if (context.ident.kind === 'artist' && (/(?:^|\.)(?:coverartarchive\.org|archive\.org|ytimg\.com|youtube\.com)$/.test(host) || details.artworkRole !== 'portrait')) return null;
        if (context.ident.kind === 'artist' && provider === 'deezer' && (!/(?:^|\.)dzcdn\.net$/.test(host) || !/\/images\/artist\//i.test(new URL(url).pathname))) return null;
        return { url, provider, source, official: provider !== 'youtube', priority: Number(details.priority || 0),
            provenance: { provider, identityId: context.ident.key, endpoint: details.endpoint || '', match: details.match || 'provider-id',
                artworkRole: details.artworkRole || (context.ident.kind === 'artist' ? 'portrait' : 'cover'), ...details } };
    }
    async function add(urls, provider, source, context, details = {}) {
        const unique = [...new Set(array(urls).filter(Boolean))].slice(0, 6);
        for (const url of unique) {
            if (context.signal.aborted || context.candidates.length >= 18) break;
            const value = candidate(url, provider, source, context, details);
            if (!value || context.candidates.some(x => x.url === url)) continue;
            const checked = await validate(url, context);
            if (checked.validation !== 'failed' && !context.failed.has(checked.finalUrl)) context.candidates.push({ ...value, ...checked });
        }
    }
    const deezCovers = value => [value?.cover_xl, value?.cover_big, value?.cover_medium, value?.cover];
    const deezPortraits = value => [value?.picture_xl, value?.picture_big, value?.picture_medium, value?.picture];
    function verified(context) { return context.candidates.some(x => x.official && x.validation === 'verified' && !context.failed.has(x.url)); }
    async function attempt(work, fallback = null) { try { return await work(); } catch (_) { return fallback; } }

    async function exactDeezer(item, context) {
        const { id, kind } = context.ident, endpoint = `https://api.deezer.com/${kind}/${id}`;
        const data = await attempt(() => metadata('deezer', endpoint, context));
        if (!data || String(data.id) !== id) return item;
        context.authoritative = true;
        const target = targetFrom(item, data, 'deezer', kind);
        if (kind === 'playlist') {
            await add(deezPortraits(data), 'deezer', 'deezer-playlist', context, { endpoint, artworkRole: 'cover', linkedId: `deezer:playlist:${id}` });
            return target;
        }
        if (kind === 'artist') {
            await add(deezPortraits(data), 'deezer', 'deezer-artist', context, { endpoint, artworkRole: 'portrait', linkedId: `deezer:artist:${id}` });
            return target;
        }
        if (kind === 'album') await add(deezCovers(data), 'deezer', 'deezer-album', context, { endpoint, linkedId: `deezer:album:${id}` });
        if (kind === 'track') {
            await add(deezCovers(data.album), 'deezer', 'deezer-album', context, { endpoint, linkedId: data.album?.id ? `deezer:album:${data.album.id}` : '' });
            // Recording responses sometimes contain stale CDN URLs or no cover.
            // Its actual album ID is authoritative; another song's cover is not.
            if (!verified(context) && /^\d{1,20}$/.test(String(data.album?.id || ''))) {
                const albumEndpoint = `https://api.deezer.com/album/${data.album.id}`;
                const album = await attempt(() => metadata('deezer', albumEndpoint, context));
                if (String(album?.id) === String(data.album.id)) {
                    await add(deezCovers(album), 'deezer', 'deezer-album', context, { endpoint: albumEndpoint, match: 'linked-album-id', linkedId: `deezer:album:${album.id}` });
                    if (album.release_date) target.releaseDate = album.release_date;
                }
            }
        }
        return target;
    }
    async function exactApple(item, context) {
        const { id, kind } = context.ident;
        const endpoint = `https://itunes.apple.com/lookup?${new URLSearchParams({ id, entity: kind === 'artist' ? 'album' : kind === 'video' ? 'musicVideo' : 'song', limit: '200', country: 'US' })}`;
        const data = await attempt(() => metadata('itunes', endpoint, context));
        const values = array(data?.results);
        const raw = values.find(x => String(kind === 'artist' ? x.artistId : kind === 'album' ? x.collectionId : x.trackId) === id
            && (kind === 'artist' ? x.wrapperType === 'artist' || x.artistType : kind === 'album' ? x.wrapperType === 'collection' || x.collectionType === 'Album' : kind === 'video' ? x.kind === 'music-video' : x.kind === 'song'));
        if (!raw) return item;
        context.authoritative = true;
        const target = targetFrom(item, raw, 'itunes', kind);
        if (kind === 'artist') {
            target.albums = values.filter(x => (x.wrapperType === 'collection' || x.collectionType === 'Album') && String(x.artistId) === id);
            // Apple's song/collection images are never artist portraits. A
            // Deezer portrait is acceptable only after two shared releases.
            await discographyPortrait(target, context);
        } else {
            await add([appleImage(raw.artworkUrl100), raw.artworkUrl100, raw.artworkUrl60], 'itunes', kind === 'video' ? 'apple-video' : 'apple-album', context,
                { endpoint, linkedId: raw.collectionId ? `itunes:album:${raw.collectionId}` : context.ident.key });
            if (!verified(context) && raw.collectionId && kind === 'track') {
                const albumEndpoint = `https://itunes.apple.com/lookup?id=${raw.collectionId}&entity=album&country=US`;
                const albumData = await attempt(() => metadata('itunes', albumEndpoint, context));
                const album = array(albumData?.results).find(x => String(x.collectionId) === String(raw.collectionId) && x.wrapperType === 'collection');
                if (album) await add([appleImage(album.artworkUrl100), album.artworkUrl100, album.artworkUrl60], 'itunes', 'apple-album', context,
                    { endpoint: albumEndpoint, match: 'linked-album-id', linkedId: `itunes:album:${album.collectionId}` });
            }
        }
        return target;
    }
    async function discographyPortrait(target, context) {
        const appleAlbums = array(target.albums).filter(x => x.collectionId && x.collectionName && norm(x.artistName) === norm(target.title));
        if (new Set(appleAlbums.map(x => String(x.collectionId))).size < 2) return;
        const endpoint = `https://api.deezer.com/search/artist?${new URLSearchParams({ q: target.title, limit: '8' })}`;
        const found = await attempt(() => metadata('deezer', endpoint, context));
        for (const artist of array(found).filter(x => /^\d{1,20}$/.test(String(x.id)) && norm(x.name) === norm(target.title)).slice(0, 3)) {
            const albumsEndpoint = `https://api.deezer.com/artist/${artist.id}/albums?limit=100`;
            const albums = array(await attempt(() => metadata('deezer', albumsEndpoint, context)));
            const shared = new Set();
            for (const apple of appleAlbums) {
                if (albums.some(album => album.id && norm(album.title) === norm(apple.collectionName)
                    && (!album.artist?.id || String(album.artist.id) === String(artist.id))
                    && norm(album.artist?.name || artist.name) === norm(apple.artistName)
                    && (!year(apple.releaseDate) || year(album.release_date) === year(apple.releaseDate)))) shared.add(norm(apple.collectionName));
            }
            if (shared.size < 2) continue;
            const portraitEndpoint = `https://api.deezer.com/artist/${artist.id}`;
            const raw = await attempt(() => metadata('deezer', portraitEndpoint, context));
            if (String(raw?.id) === String(artist.id)) await add(deezPortraits(raw), 'deezer', 'deezer-artist', context,
                { endpoint: portraitEndpoint, artworkRole: 'portrait', match: 'verified-discography', linkedId: `deezer:artist:${artist.id}`, sharedAlbums: [...shared] });
            if (verified(context)) return;
        }
    }
    async function linkedArtist(data, context) {
        const relations = array(data?.relations);
        for (const relation of relations) {
            const resource = text(relation.url?.resource);
            const linked = /^https:\/\/(?:www\.)?deezer\.com\/(?:[a-z]{2}\/)?artist\/(\d{1,20})\/?(?:\?.*)?$/.exec(resource);
            if (linked) {
                const endpoint = `https://api.deezer.com/artist/${linked[1]}`;
                const raw = await attempt(() => metadata('deezer', endpoint, context));
                if (String(raw?.id) === linked[1]) await add(deezPortraits(raw), 'deezer', 'deezer-artist', context,
                    { endpoint, artworkRole: 'portrait', match: 'linked-artist-id', linkedId: `deezer:artist:${linked[1]}`, relation: resource });
            }
        }
        if (verified(context)) return;
        for (const relation of relations) {
            const resource = text(relation.url?.resource);
            if (relation.type === 'image' && isAllowedArtworkUrl(resource) && /(?:^|\.)wikimedia\.org$/.test(new URL(resource).hostname)) {
                await add([resource], 'wikimedia', 'wikimedia-artist', context, { endpoint: resource, artworkRole: 'portrait', match: 'identity-image-relation' });
            }
            const wikidata = /^https:\/\/(?:www\.)?wikidata\.org\/wiki\/(Q\d+)\/?$/.exec(resource);
            if (!wikidata || relation.type !== 'wikidata') continue;
            const endpoint = `https://www.wikidata.org/wiki/Special:EntityData/${wikidata[1]}.json`;
            const entity = await attempt(() => metadata('wikidata', endpoint, context));
            const filename = entity?.entities?.[wikidata[1]]?.claims?.P18?.find(x => x.mainsnak?.datavalue?.value)?.mainsnak?.datavalue?.value;
            if (typeof filename !== 'string' || filename.length > 400 || /[\u0000-\u001f]/.test(filename)) continue;
            const commonsEndpoint = `https://commons.wikimedia.org/w/api.php?${new URLSearchParams({ action: 'query', titles: `File:${filename}`, prop: 'imageinfo', iiprop: 'url', format: 'json' })}`;
            const commons = await attempt(() => metadata('wikimedia', commonsEndpoint, context));
            const urls = Object.values(commons?.query?.pages || {}).flatMap(page => array(page.imageinfo).map(x => x.url)).filter(url => isAllowedArtworkUrl(url) && /(?:^|\.)wikimedia\.org$/.test(new URL(url).hostname));
            await add(urls, 'wikimedia', 'wikimedia-artist', context, { endpoint, artworkRole: 'portrait', match: 'identity-wikidata-image', linkedId: wikidata[1], image: filename });
        }
    }
    async function releaseArtwork(release, context, priority = 0) {
        if (!UUID.test(text(release?.id)) || release.status !== 'Official') return;
        const endpoint = `https://coverartarchive.org/release/${release.id}`;
        await add([`${endpoint}/front-500`, `${endpoint}/front-250`, `${endpoint}/front`], 'musicbrainz', 'musicbrainz-release', context,
            { endpoint, match: 'linked-official-release-id', linkedId: `musicbrainz:release:${release.id}`, releaseStatus: release.status, priority });
    }
    async function exactMusicBrainz(item, context) {
        const { id, kind, entityKind } = context.ident;
        const entity = entityKind === 'release' ? 'release' : kind === 'track' ? 'recording' : kind === 'album' ? 'release-group' : kind;
        const inc = entityKind === 'release' ? 'artist-credits+recordings+release-groups+url-rels' : kind === 'artist' ? 'url-rels+release-groups' : kind === 'album' ? 'releases+artist-credits+url-rels' : 'artist-credits+releases+release-groups+url-rels';
        const endpoint = `https://musicbrainz.org/ws/2/${entity}/${id}?${new URLSearchParams({ inc, fmt: 'json' })}`;
        const data = await attempt(() => metadata('musicbrainz', endpoint, context));
        if (!data || text(data.id).toLowerCase() !== id) return item;
        context.authoritative = true;
        const target = targetFrom(item, data, 'musicbrainz', kind);
        if (kind === 'artist') { await linkedArtist(data, context); return target; }
        if (entityKind === 'release') { await releaseArtwork(data, context); return target; }
        if (kind === 'album') {
            const group = `https://coverartarchive.org/release-group/${id}`;
            await add([`${group}/front-500`, `${group}/front-250`, `${group}/front`], 'musicbrainz', 'musicbrainz-release-group', context,
                { endpoint: group, match: 'release-group-id', linkedId: context.ident.key });
        }
        const edition = kind === 'track' ? selectedRelease(item) : '';
        let releases = array(data.releases).filter(x => UUID.test(text(x.id)) && (edition ? text(x.id).toLowerCase() === edition : !target.album || norm(x.title) === norm(target.album)));
        if (edition && !releases.length) { context.invalidEdition = true; return target; }
        const selectedYear = year(item.releaseDate);
        releases.sort((a, b) => Number(b.status === 'Official') - Number(a.status === 'Official')
            || (selectedYear ? Number(year(b.date) === selectedYear) - Number(year(a.date) === selectedYear) : 0) || text(a.date).localeCompare(text(b.date)));
        // Cover Art Archive release-group images can disappear while a linked
        // official release still has its real cover. Follow those IDs first.
        for (const release of releases.slice(0, 4)) {
            if (verified(context)) break;
            let chosen = release;
            if (!chosen.status) {
                const releaseEndpoint = `https://musicbrainz.org/ws/2/release/${release.id}?inc=artist-credits+release-groups&fmt=json`;
                const raw = await attempt(() => metadata('musicbrainz', releaseEndpoint, context));
                if (text(raw?.id).toLowerCase() !== text(release.id).toLowerCase()) continue;
                chosen = raw;
            }
            if (edition) {
                target.album = chosen.title || target.album;
                target.albumId = target.releaseId = `musicbrainz:release:${edition}`;
                target.releaseDate = chosen.date || item.releaseDate || '';
            }
            await releaseArtwork(chosen, context);
            if (!target.album && chosen.title) target.album = chosen.title;
            if (!target.releaseDate && chosen.date) target.releaseDate = chosen.date;
        }
        return target;
    }
    async function crossApple(target, context) {
        const kind = context.ident.kind === 'album' ? 'album' : 'track';
        const raw = `${target.title} ${target.author} ${context.item.title || ''}`;
        const region = /\p{Script=Arabic}/u.test(raw) ? 'AE' : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|\b(?:opening|ending)\s+full\b/iu.test(raw) ? 'JP' : 'GB';
        const countries = ['US', region], terms = [...new Set([`${target.author || ''} ${target.title || ''}`.trim(), text(target.title)])];
        // Storefront availability and search indexing differ. These four bounded
        // queries still require the same recording/release constraints on every
        // result, including title-only searches.
        for (const term of terms) for (const country of countries) {
            if (context.signal.aborted) return;
            const endpoint = `https://itunes.apple.com/search?${new URLSearchParams({ term, media: 'music', entity: kind === 'album' ? 'album' : 'song', limit: '25', country })}`;
            const data = await attempt(() => metadata('itunes', endpoint, context));
            const matches = array(data?.results).filter(x => (kind === 'album' ? x.collectionId && (x.wrapperType === 'collection' || x.collectionType === 'Album') : x.trackId && x.kind === 'song') && exactMatch(target, x, 'itunes', kind, context.ident.provider === 'youtube'));
            for (const value of matches.slice(0, 3)) {
                await add([appleImage(value.artworkUrl100), value.artworkUrl100, value.artworkUrl60], 'itunes', 'apple-album', context,
                    { endpoint, match: 'exact-metadata', linkedId: `itunes:${kind}:${kind === 'album' ? value.collectionId : value.trackId}`, priority: 10 });
                if (verified(context)) return;
            }
        }
    }
    async function crossDeezer(target, context) {
        const kind = context.ident.kind === 'album' ? 'album' : 'track';
        const endpoint = `https://api.deezer.com/search${kind === 'album' ? '/album' : ''}?${new URLSearchParams({ q: `${target.author || ''} ${target.title || ''}`.trim(), limit: '25' })}`;
        const found = array(await attempt(() => metadata('deezer', endpoint, context)));
        const withoutYear = { ...target, releaseDate: '', year: '' };
        for (const original of found.filter(x => x.id && exactMatch(withoutYear, x, 'deezer', kind, context.ident.provider === 'youtube')).slice(0, 3)) {
            let value = original, resolvedAlbum = null;
            // Deezer search results omit release dates even when the exact
            // album endpoint knows them. Hydrate that ID before judging year.
            if (year(target.releaseDate || target.year) && !year(value.release_date || value.album?.release_date)) {
                const albumId = kind === 'album' ? value.id : value.album?.id;
                if (!/^\d{1,20}$/.test(String(albumId || ''))) continue;
                const albumEndpoint = `https://api.deezer.com/album/${albumId}`;
                const album = await attempt(() => metadata('deezer', albumEndpoint, context));
                if (String(album?.id) !== String(albumId) || norm(album.title) !== norm(kind === 'album' ? value.title : value.album?.title)) continue;
                resolvedAlbum = album;
                value = kind === 'album' ? { ...value, ...album } : { ...value, release_date: album.release_date, album: { ...value.album, ...album } };
            }
            if (!exactMatch(target, value, 'deezer', kind, context.ident.provider === 'youtube')) continue;
            await add(deezCovers(kind === 'album' ? value : value.album), 'deezer', 'deezer-album', context,
                { endpoint, match: 'exact-metadata', linkedId: `deezer:${kind}:${value.id}`, priority: 10 });
            if (!verified(context) && kind === 'track' && value.album?.id) {
                const albumEndpoint = `https://api.deezer.com/album/${value.album.id}`;
                const album = resolvedAlbum || await attempt(() => metadata('deezer', albumEndpoint, context));
                if (String(album?.id) === String(value.album.id)) await add(deezCovers(album), 'deezer', 'deezer-album', context,
                    { endpoint: albumEndpoint, match: 'exact-metadata-linked-album-id', linkedId: `deezer:album:${album.id}`, priority: 10 });
            }
            if (verified(context)) return;
        }
    }
    async function youtubeFallback(item, context) {
        if (!['track', 'video'].includes(context.ident.kind)) return;
        const id = exactVideo(item, context.ident);
        if (!id) return;
        await add([`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, `https://img.youtube.com/vi/${id}/hqdefault.jpg`], 'youtube', 'youtube-video', context,
            { match: 'exact-video-url', endpoint: `https://www.youtube.com/watch?v=${id}`, artworkRole: 'video-thumbnail', priority: 100 });
    }
    function result(ident, candidates, failed, status) {
        const ranked = candidates.filter(x => !failed.has(x.url) && !failed.has(x.finalUrl)).sort((a, b) =>
            Number(b.official) - Number(a.official) || Number(b.validation === 'verified') - Number(a.validation === 'verified') || a.priority - b.priority);
        const first = ranked[0];
        return { url: first?.url || '', source: first?.source || '', official: Boolean(first?.official && first.validation === 'verified'),
            kind: ident?.kind || '', provider: first?.provider || ident?.provider || '', provenance: first ? { ...first.provenance, identityVerified: first.official } : { identityId: ident?.key || '' },
            fallbacks: [...new Set(ranked.slice(1).map(x => x.url))], validation: first?.validation || 'unavailable', status: status || (first ? 'ready' : 'unavailable') };
    }
    function peek(item, args = {}) {
        const ident = identity(item); if (!ident || closed) return null;
        const failed = getFailed(ident.cacheKey, args.failedUrls), hit = cache.get(ident.cacheKey);
        if (!hit || hit.expires <= now()) return null;
        const value = result(ident, hit.candidates, failed);
        return value.url || !hit.candidates.length && !failed.size ? copy(value) : null;
    }
    async function perform(item, context) {
        let target = context.ident.provider === 'youtube' ? youtubeTarget(item) : item;
        if (context.ident.provider === 'deezer') target = await exactDeezer(item, context);
        if (context.ident.provider === 'itunes') target = await exactApple(item, context);
        if (context.ident.provider === 'musicbrainz') target = await exactMusicBrainz(item, context);
        if (!context.invalidEdition && !verified(context) && (context.authoritative || context.ident.provider === 'youtube' && exactVideo(item, context.ident))
            && ['track', 'album', 'video'].includes(context.ident.kind) && norm(target.title) && norm(target.author)) {
            if (context.ident.provider !== 'itunes') await crossApple(target, context);
            if (!verified(context) && context.ident.provider !== 'deezer') await crossDeezer(target, context);
        }
        if (!context.invalidEdition && !context.signal.aborted) await youtubeFallback(item, context);
        return result(context.ident, context.candidates, context.failed);
    }
    function resolve(item, args = {}) {
        const ident = identity(item);
        if (!ident) return Promise.resolve(result(null, [], new Set(), 'invalid'));
        const failed = getFailed(ident.cacheKey, args.failedUrls);
        if (closed) return Promise.resolve(result(ident, [], failed, 'closed'));
        const cached = peek(item, args);
        if (cached) return Promise.resolve(cached);
        const previous = inflight.get(ident.cacheKey);
        if (previous) return previous.then(value => {
            const hit = cache.get(ident.cacheKey);
            return hit ? result(ident, hit.candidates, failed) : value.url && failed.has(value.url) ? result(ident, [], failed) : value;
        });
        if (inflight.size >= maxConcurrent + maxQueue) return Promise.resolve(result(ident, [], failed, 'unavailable'));
        const snapshot = copy(item), controller = new AbortController();
        const context = { ident, item: snapshot, controller, signal: controller.signal, candidates: [], failed, metadataKeys: new Set() };
        contexts.add(context);
        let timer;
        const deadline = new Promise(resolveDeadline => {
            context.cancel = () => { controller.abort(); resolveDeadline(result(ident, context.candidates, failed, closed ? 'closed' : undefined)); };
            timer = setTimeout(context.cancel, timeoutMs);
        });
        const operation = perform(snapshot, context).catch(() => result(ident, context.candidates, failed));
        const promise = Promise.race([operation, deadline]).then(value => {
            // Empty catalog responses and a verified video thumbnail are misses
            // for original cover art. Retry the provider metadata along with the
            // cover, rather than recycling a thirty-minute stale miss.
            if (!value.official) for (const key of context.metadataKeys) metadataCache.delete(key);
            if (!closed && !context.signal.aborted) boundedSet(cache, ident.cacheKey, { candidates: copy(context.candidates.filter(x => !failed.has(x.url) && !failed.has(x.finalUrl))),
                expires: now() + (value.official ? 6 * 3600_000 : value.url && value.validation !== 'verified' ? 5000 : 30_000) });
            return copy(value);
        }).finally(() => { clearTimeout(timer); contexts.delete(context); if (inflight.get(ident.cacheKey) === promise) inflight.delete(ident.cacheKey); });
        inflight.set(ident.cacheKey, promise);
        return promise;
    }
    function warm(item, args = {}) { return resolve(item, args); }
    function provisional(item) {
        const ident = identity(item); if (!ident) return result(null, [], new Set(), 'invalid');
        let url = isAllowedArtworkUrl(item.thumbnail) ? item.thumbnail : '';
        if (ident.kind === 'artist' && !(ident.provider === 'deezer' && url && /(?:^|\.)dzcdn\.net$/.test(new URL(url).hostname) && /\/images\/artist\//i.test(url))) url = '';
        const thumbnailVideo = /\/(?:vi|vi_webp)\/([\w-]{11})\//.exec(url)?.[1];
        if (/\/(?:vi|vi_webp)\//.test(url) && (ident.kind === 'artist' || thumbnailVideo !== exactVideo(item, ident))) url = '';
        return { ...result(ident, [], new Set(), closed ? 'closed' : 'pending'), url, validation: 'pending', provenance: { identityId: ident.key, artworkRole: ident.kind === 'artist' ? 'portrait' : 'cover' } };
    }
    function enrich(items, args = {}) {
        let budget = Math.max(0, Math.min(12, Number.isFinite(Number(args.warmLimit)) ? Number(args.warmLimit) : 12));
        return array(items).map(item => {
            if (!item || typeof item !== 'object') return item;
            const cached = peek(item), artwork = cached || provisional(item);
            if (!cached && budget > 0 && !closed) { budget--; warm(item).catch(() => {}); }
            return { ...item, thumbnail: artwork.url, artwork, artworkProvider: artwork.provider };
        });
    }
    function close() {
        if (closed) return;
        closed = true; clearTimeout(pumpTimer); pumpTimer = null;
        for (const context of contexts) context.cancel();
        for (const job of queue.splice(0)) { job.context.signal.removeEventListener('abort', job.abort); job.reject(error('Artwork service closed.', 'ARTWORK_CANCELLED')); }
        cache.clear(); metadataCache.clear(); validationCache.clear(); failures.clear();
    }
    return { resolve, warm, peek, enrich, close };
}

module.exports = { ...createPlatformArtwork(), createPlatformArtwork, isAllowedArtworkUrl, ARTWORK_IMAGE_HOSTS };
