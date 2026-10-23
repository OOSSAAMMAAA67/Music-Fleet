const config = require('../config');

const DEFAULT_UA =
    config.YTDLP_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const redirectCache = new Map();
const REDIRECT_CACHE_TTL_MS = 10 * 60 * 1000;
const REDIRECT_CACHE_MAX = 128;

function getCachedRedirect(url) {
    const hit = redirectCache.get(url);
    if (!hit) return '';
    if (Date.now() - hit.at > REDIRECT_CACHE_TTL_MS) { redirectCache.delete(url); return ''; }
    redirectCache.delete(url);
    redirectCache.set(url, hit);
    return hit.url;
}

function setCachedRedirect(input, output) {
    if (!input || !output) return;
    if (redirectCache.has(input)) redirectCache.delete(input);
    redirectCache.set(input, { at: Date.now(), url: output });
    while (redirectCache.size > REDIRECT_CACHE_MAX) redirectCache.delete(redirectCache.keys().next().value);
}

function safeUrl(input) {
    try {
        const u = new URL(String(input || '').trim());
        if (!/^https?:$/.test(u.protocol)) return null;
        return u;
    } catch (_) {
        return null;
    }
}

function normalizedHost(u) {
    return String(u?.hostname || '').toLowerCase().replace(/^www\./, '');
}

function classifyUrl(input) {
    const u = safeUrl(input);
    if (!u) return null;
    const host = normalizedHost(u);
    let decodedPath = u.pathname || '';
    try { decodedPath = decodeURIComponent(decodedPath); } catch (_) {}
    const path = decodedPath.replace(/\/+$/, '') || '/';

    const soundcloudHost = ['soundcloud.com', 'm.soundcloud.com', 'api.soundcloud.com', 'api-v2.soundcloud.com', 'w.soundcloud.com', 'player.soundcloud.com', 'p.soundcloud.com'].includes(host);
    const soundcloudShort = host === 'on.soundcloud.com' || host === 'snd.sc' || host === 'soundcloud.app.goo.gl';
    if (soundcloudHost || soundcloudShort) {
        let kind = 'track';
        if (soundcloudShort) kind = 'short';
        else if (/\/sets\/[^/]+/i.test(path)) kind = 'playlist';
        else if (/\/playlists?\/\d+/i.test(path)) kind = 'playlist';
        else if (/\/(likes|reposts|tracks)$/i.test(path)) kind = 'playlist';
        else if (path === '/' || path.split('/').filter(Boolean).length === 1) kind = 'profile';
        return { provider: 'soundcloud', kind, short: soundcloudShort, url: u.toString(), host };
    }

    const spotifyShort = host === 'spotify.link';
    if (host === 'open.spotify.com' || spotifyShort) {
        const parts = path.split('/').filter(Boolean);
        const typeIndex = parts[0] === 'intl-ar' || /^intl-[a-z]{2}$/i.test(parts[0] || '') ? 1 : 0;
        const kind = spotifyShort ? 'short' : (parts[typeIndex] || 'unknown').toLowerCase();
        return { provider: 'spotify', kind, short: spotifyShort, url: u.toString(), host };
    }

    const tidalShort = host === 'tidal.link' || host === 'link.tidal.com';
    const tidalHost = host === 'tidal.com' || host === 'listen.tidal.com';
    if (tidalHost || tidalShort) {
        const parts = path.split('/').filter(Boolean).map(x => x.toLowerCase());
        const browse = parts[0] === 'browse' ? 1 : 0;
        const kind = tidalShort ? 'short' : (parts[browse] || 'unknown');
        return { provider: 'tidal', kind, short: tidalShort, url: u.toString(), host };
    }

    if (/youtube\.com$/.test(host) || host === 'youtu.be' || host === 'music.youtube.com') {
        const kind = u.searchParams.has('list') || /\/playlist$/i.test(path) ? 'playlist' : 'track';
        return { provider: 'youtube', kind, short: false, url: u.toString(), host };
    }

    return { provider: 'generic', kind: 'url', short: false, url: u.toString(), host };
}

function timeoutSignal(timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('request timed out')), Math.max(250, Number(timeoutMs) || 5000));
    timer.unref?.();
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function fetchFollow(url, options = {}) {
    const fetchImpl = options.fetchImpl || global.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');

    const cached = getCachedRedirect(url);
    if (cached) return cached;

    // One total deadline for the entire short-link resolution. The old HEAD->GET
    // flow could spend the full timeout twice. GET-first is also friendlier to
    // SoundCloud share links, which are commonly resolved by the generic GET path.
    const totalTimeoutMs = Math.max(1000, Number(options.timeoutMs || config.SOURCE_LINK_RESOLVE_TIMEOUT_MS || 5000));
    const deadline = Date.now() + totalTimeoutMs;
    const headers = { 'user-agent': DEFAULT_UA, accept: '*/*', ...(options.headers || {}) };
    let lastError = null;

    for (const method of ['GET', 'HEAD']) {
        const remaining = deadline - Date.now();
        if (remaining <= 200) break;
        const attemptBudget = method === 'GET' ? remaining : Math.min(remaining, 1200);
        const guard = timeoutSignal(attemptBudget);
        try {
            const res = await fetchImpl(url, {
                method,
                redirect: 'follow',
                headers,
                signal: guard.signal,
            });
            if (!res || (!res.ok && res.status >= 400)) throw new Error(`HTTP ${res?.status || 'error'}`);
            const finalUrl = res.url || url;
            if (method === 'GET') {
                try { await res.body?.cancel?.(); } catch (_) {}
            }
            setCachedRedirect(url, finalUrl);
            return finalUrl;
        } catch (err) {
            lastError = err;
        } finally {
            guard.clear();
        }
    }
    throw lastError || new Error('could not resolve redirect');
}

async function fetchText(url, options = {}) {
    const fetchImpl = options.fetchImpl || global.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
    const guard = timeoutSignal(options.timeoutMs || config.SOURCE_LINK_RESOLVE_TIMEOUT_MS || 5000);
    try {
        const res = await fetchImpl(url, {
            redirect: 'follow',
            headers: { 'user-agent': DEFAULT_UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
            signal: guard.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { text: await res.text(), url: res.url || url };
    } finally {
        guard.clear();
    }
}

async function fetchJson(url, options = {}) {
    const fetchImpl = options.fetchImpl || global.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
    const guard = timeoutSignal(options.timeoutMs || config.SOURCE_LINK_RESOLVE_TIMEOUT_MS || 5000);
    try {
        const res = await fetchImpl(url, {
            redirect: 'follow',
            headers: { 'user-agent': DEFAULT_UA, accept: 'application/json,*/*;q=0.8' },
            signal: guard.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        guard.clear();
    }
}

function decodeHtml(value = '') {
    return String(value)
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');
}

function extractMeta(html, key) {
    const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
    for (const tag of tags) {
        const attrs = {};
        for (const m of tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gi)) attrs[m[1].toLowerCase()] = decodeHtml(m[3]);
        if (attrs.property === key || attrs.name === key) return attrs.content || '';
    }
    return '';
}

function extractOEmbedHref(html) {
    const links = String(html || '').match(/<link\b[^>]*>/gi) || [];
    for (const tag of links) {
        const attrs = {};
        for (const m of tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gi)) attrs[m[1].toLowerCase()] = decodeHtml(m[3]);
        if (String(attrs.type || '').toLowerCase() === 'application/json+oembed' && attrs.href) return attrs.href;
    }
    return '';
}

function compactSearchTitle(value = '') {
    return String(value || '')
        .replace(/^spotify embed:\s*/i, '')
        .replace(/\s*[|·]\s*(spotify|tidal)\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 320);
}

async function resolveSpotifyTrack(url, options = {}) {
    const endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
    const data = await fetchJson(endpoint, options);
    const rawTitle = compactSearchTitle(data?.title || '');
    const author = compactSearchTitle(data?.author_name || '');
    const title = author && rawTitle && !rawTitle.toLowerCase().includes(author.toLowerCase()) ? `${author} - ${rawTitle}` : rawTitle;
    if (!title) throw new Error('Spotify oEmbed returned no title');
    return { title, thumbnail: data.thumbnail_url || '' };
}

function tidalTrackId(url = '') {
    try {
        const u = new URL(String(url));
        const m = u.pathname.match(/\/(?:browse\/)?track\/(\d+)/i);
        return m?.[1] || '';
    } catch (_) { return ''; }
}

async function resolveTidalTrack(url, options = {}) {
    // TIDAL exposes a public oEmbed endpoint. Query it directly first instead of
    // scraping tidal.com, which can be JS/edge protected and was the main reason
    // perfectly valid shared track links intermittently failed in Discord.
    const canonical = (() => {
        const id = tidalTrackId(url);
        return id ? `https://tidal.com/track/${id}` : String(url);
    })();
    for (const endpoint of [
        `https://oembed.tidal.com/?url=${encodeURIComponent(canonical)}`,
        `https://oembed.tidal.com/?url=${encodeURIComponent(url)}`,
    ]) {
        try {
            const data = await fetchJson(endpoint, options);
            const rawTitle = compactSearchTitle(data?.title || '');
            const author = compactSearchTitle(data?.author_name || '');
            const title = author && rawTitle && !rawTitle.toLowerCase().includes(author.toLowerCase()) ? `${author} - ${rawTitle}` : rawTitle;
            if (title) return { title, thumbnail: data.thumbnail_url || data.thumbnail || '' };
        } catch (_) {}
    }

    // Secondary public embed route: its HTML normally carries OG metadata even
    // when the main TIDAL SPA refuses a server-side fetch.
    const trackId = tidalTrackId(url);
    if (trackId) {
        try {
            const embed = await fetchText(`https://embed.tidal.com/tracks/${trackId}?layout=gridify`, options);
            const ogTitle = compactSearchTitle(extractMeta(embed.text, 'og:title'));
            const ogDescription = compactSearchTitle(extractMeta(embed.text, 'og:description'));
            const title = [ogTitle, ogDescription].filter(Boolean).join(' ').slice(0, 320);
            if (title) return { title, thumbnail: extractMeta(embed.text, 'og:image') || '' };
        } catch (_) {}
    }

    // Last resort: preserve the previous page-discovery path.
    const page = await fetchText(url, options);
    const oembedHref = extractOEmbedHref(page.text);
    if (oembedHref) {
        try {
            const data = await fetchJson(new URL(oembedHref, page.url).toString(), options);
            const rawTitle = compactSearchTitle(data?.title || '');
            const author = compactSearchTitle(data?.author_name || '');
            const title = author && rawTitle && !rawTitle.toLowerCase().includes(author.toLowerCase()) ? `${author} - ${rawTitle}` : rawTitle;
            if (title) return { title, thumbnail: data.thumbnail_url || '' };
        } catch (_) {}
    }
    const ogTitle = compactSearchTitle(extractMeta(page.text, 'og:title'));
    const ogDescription = compactSearchTitle(extractMeta(page.text, 'og:description'));
    const title = [ogTitle, ogDescription].filter(Boolean).join(' ').slice(0, 320);
    if (!title) throw new Error('TIDAL metadata lookup returned no usable track identity');
    return { title, thumbnail: extractMeta(page.text, 'og:image') || '' };
}

async function resolveInput(input, options = {}) {
    const raw = String(input || '').trim();
    const initial = classifyUrl(raw);
    if (!initial) return { mode: 'query', provider: 'youtube', kind: 'search', target: raw, original: raw };

    if (initial.provider === 'soundcloud') {
        if (config.SOURCES?.SOUNDCLOUD === false) throw new Error('SoundCloud links are disabled in config.SOURCES');
        let target = raw;
        if (initial.short) {
            try {
                const resolved = await fetchFollow(raw, options);
                const resolvedInfo = classifyUrl(resolved);
                target = resolvedInfo?.provider === 'soundcloud' ? resolved : raw;
            } catch (_) { target = raw; } // yt-dlp's generic extractor can still follow the share redirect.
        }
        const info = classifyUrl(target) || initial;
        return { mode: 'direct', provider: 'soundcloud', kind: info.kind, target, original: raw };
    }

    if (initial.provider === 'spotify') {
        if (config.SOURCES?.SPOTIFY === false) throw new Error('Spotify links are disabled in config.SOURCES');
        let target = raw;
        if (initial.short) {
            const resolved = await fetchFollow(raw, options);
            const resolvedInfo = classifyUrl(resolved);
            if (resolvedInfo?.provider !== 'spotify') throw new Error('Spotify short link resolved outside Spotify');
            target = resolved;
        }
        const info = classifyUrl(target) || initial;
        if (info.kind !== 'track') throw new Error('Spotify link support currently accepts track links; SoundCloud/YouTube playlists remain native playlists.');
        const meta = await resolveSpotifyTrack(target, options);
        return {
            mode: 'search', provider: 'spotify', kind: 'track', target, original: raw,
            searchQuery: meta.title, thumbnail: meta.thumbnail,
        };
    }

    if (initial.provider === 'tidal') {
        if (config.SOURCES?.TIDAL === false) throw new Error('TIDAL links are disabled in config.SOURCES');
        let target = raw;
        if (initial.short) {
            const resolved = await fetchFollow(raw, options);
            const resolvedInfo = classifyUrl(resolved);
            if (resolvedInfo?.provider !== 'tidal') throw new Error('TIDAL short link resolved outside TIDAL');
            target = resolved;
        }
        const info = classifyUrl(target) || initial;
        if (info.kind !== 'track') throw new Error('TIDAL link support currently accepts track links; SoundCloud/YouTube playlists remain native playlists.');
        const meta = await resolveTidalTrack(target, options);
        return {
            mode: 'search', provider: 'tidal', kind: 'track', target, original: raw,
            searchQuery: meta.title, thumbnail: meta.thumbnail,
        };
    }

    return { mode: 'direct', provider: initial.provider, kind: initial.kind, target: raw, original: raw };
}

module.exports = {
    classifyUrl,
    resolveInput,
    fetchFollow,
    extractOEmbedHref,
    extractMeta,
    compactSearchTitle,
    tidalTrackId,
};
