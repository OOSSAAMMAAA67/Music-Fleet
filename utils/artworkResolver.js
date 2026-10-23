'use strict';

const os = require('node:os');
const net = require('node:net');
const config = require('../config');

const CACHE_TTL_MS = Math.max(10 * 60_000, Number(config.ARTWORK_CACHE_TTL_MS || 6 * 60 * 60_000));
const MISS_CACHE_TTL_MS = Math.max(60_000, Number(config.ARTWORK_MISS_CACHE_TTL_MS || 8 * 60_000));
const MISS_BACKGROUND_RETRY_MS = Math.max(30_000, Number(config.ARTWORK_BACKGROUND_RETRY_MS || 60_000));
const PROVIDER_TIMEOUT_MS = Math.max(1200, Math.min(9000, Number(config.ARTWORK_PROVIDER_TIMEOUT_MS || 3400)));
const METADATA_TIMEOUT_MS = Math.max(2500, Math.min(15000, Number(config.ARTWORK_METADATA_TIMEOUT_MS || 7000)));
const CACHE_MAX = Math.max(50, Number(config.ARTWORK_CACHE_MAX || 700));
const HTTP_CONCURRENCY = Math.max(4, Math.min(48, Number(config.ARTWORK_HTTP_CONCURRENCY || Math.max(10, os.availableParallelism?.() || os.cpus().length || 8))));
const MAX_OFFICIAL_CHAIN = Math.max(3, Math.min(24, Number(config.ARTWORK_OFFICIAL_CHAIN_MAX || 14)));
const APPLE_STATIC_SIZE = Math.max(1000, Math.min(6000, Number(config.ARTWORK_STATIC_APPLE_SIZE || 3000)));
const ANIMATED_ENABLED = config.ARTWORK_ANIMATED_ENABLED !== false;
const ANIMATED_APPLE_ENABLED = config.ARTWORK_ANIMATED_APPLE_ENABLED !== false;
const ANIMATED_TIMEOUT_MS = Math.max(2500, Math.min(20000, Number(config.ARTWORK_ANIMATED_TIMEOUT_MS || 9000)));
const ANIMATED_CACHE_TTL_MS = Math.max(30 * 60_000, Number(config.ARTWORK_ANIMATED_CACHE_TTL_MS || 12 * 60 * 60_000));
const ANIMATED_MISS_TTL_MS = Math.max(2 * 60_000, Number(config.ARTWORK_ANIMATED_MISS_TTL_MS || 15 * 60_000));
const ANIMATED_MAX_CANDIDATES = Math.max(1, Math.min(12, Number(config.ARTWORK_ANIMATED_MAX_CANDIDATES || 6)));
const APPLE_STOREFRONTS = (Array.isArray(config.ARTWORK_APPLE_STOREFRONTS) ? config.ARTWORK_APPLE_STOREFRONTS : ['US', 'GB'])
    .map(x => String(x || '').trim().toUpperCase()).filter(Boolean).slice(0, 12);
if (!APPLE_STOREFRONTS.length) APPLE_STOREFRONTS.push('US');

const cache = new Map();
const inflight = new Map();
const motionCache = new Map();
const motionInflight = new Map();
let appleTokenCache = { token: '', exp: 0 };
let mbQueue = Promise.resolve();
let lastMbRequestAt = 0;
let activeHttpRequests = 0;
const httpWaiters = [];

const VERSION_WORDS = '(?:remix|mix|edit|version|vip|bootleg|rework|live|acoustic|radio|extended|instrumental|sped\\s*up|slowed|nightcore|remaster(?:ed)?(?:\\s*\\d{4})?|deluxe|anniversary|demo|mashup|flip|club\\s*mix|original\\s*mix|ريمكس|ريميكس|لايف|مسرع(?:ة)?|مبطأ(?:ة)?)';
const NOISE_RE = /\b(?:official\s+(?:(?:music|lyrics?)\s+)?(?:audio|video|mv)|music\s+(?:video|clip)|lyrics?\s+video|(?:video|audio)\s+release|audio|video|lyrics?|visualizer|mv|hd|hq|4k|8k|topic|provided\s+to\s+youtube\s+by)\b|(?:فيديو\s+كليب\s+رسمي|الفيديو\s+الرسمي|الكليب\s+الرسمي|كلمات\s+الأغنية)/gi;
const BAD_VARIANT_RE = /\b(?:karaoke|tribute|cover\s+version|made\s+famous\s+by|in\s+the\s+style\s+of|8d\s+audio|nightcore)\b/i;

function cleanText(value) {
    return String(value || '')
        .replace(/[_]+/g, ' ')
        .replace(/（/g, '(').replace(/）/g, ')')
        .replace(/[‐‑‒–—−]+/g, '-')
        .replace(/[|•·]+/g, ' ')
        .replace(/\s*[-:]\s*(?=[)\]}]|$)/g, ' ')
        .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalize(value) {
    return cleanText(value)
        .replace(NOISE_RE, ' ')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
        .replace(/\u0640/g, '')
        .normalize('NFC')
        .replace(/[^\p{L}\p{M}\p{N}&+()\[\]{}\-\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenArray(value) {
    return normalize(value)
        .replace(/[()\[\]{}]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

function tokenSet(value) { return new Set(tokenArray(value)); }

function similarity(a, b) {
    const aa = tokenSet(a);
    const bb = tokenSet(b);
    if (!aa.size || !bb.size) return 0;
    let shared = 0;
    for (const x of aa) if (bb.has(x)) shared++;
    const recall = shared / aa.size;
    const precision = shared / bb.size;
    return recall * 0.72 + precision * 0.28;
}

function artistSimilarity(a, b) {
    const stop = new Set(['artist','music','official','records','record','label','band','topic','vevo']);
    const aa = new Set([...tokenSet(a)].filter(x => !stop.has(x)));
    const bb = new Set([...tokenSet(b)].filter(x => !stop.has(x)));
    if (!aa.size || !bb.size) return normalize(a) === normalize(b) ? 1 : 0;
    let shared = 0;
    for (const x of aa) if (bb.has(x)) shared++;
    const recall = shared / aa.size;
    const precision = shared / bb.size;
    const containment = shared / Math.min(aa.size, bb.size);
    // Music services disagree on collaborator formatting. If one provider says
    // "Gryffin" and another says "Gryffin & Audrey Mika", the shared primary
    // artist must remain a strong match when the song title itself agrees.
    return Math.max(recall * 0.82 + precision * 0.18, containment * 0.78);
}

function extractVersionHint(value) {
    const raw = cleanText(value).replace(NOISE_RE, ' ');
    const out = [];
    const inner = new RegExp(`\\(([^)]*${VERSION_WORDS}[^)]*)\\)|\\[([^\\]]*${VERSION_WORDS}[^\\]]*)\\]`, 'ig');
    let m;
    while ((m = inner.exec(raw))) out.push(m[1] || m[2]);
    const suffix = new RegExp(`(?:-|:)\\s*([^\\n]*${VERSION_WORDS}[^\\n]*)$`, 'i').exec(raw);
    if (suffix?.[1]) out.push(suffix[1]);
    return cleanText(out.join(' '));
}

function hasVersion(value) {
    return Boolean(extractVersionHint(value)) || new RegExp(`\\b${VERSION_WORDS}\\b`, 'i').test(String(value || ''));
}

function stripVersion(value) {
    let raw = cleanText(value).replace(NOISE_RE, ' ');
    raw = raw
        .replace(new RegExp(`\\([^)]*${VERSION_WORDS}[^)]*\\)`, 'ig'), ' ')
        .replace(new RegExp(`\\[[^\\]]*${VERSION_WORDS}[^\\]]*\\]`, 'ig'), ' ')
        .replace(new RegExp(`(?:-|:)\\s*[^\\n]*${VERSION_WORDS}[^\\n]*$`, 'ig'), ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return raw;
}

function stripFeaturing(value) {
    return cleanText(value)
        .replace(/\s*[([]?\s*(?:feat\.?|ft\.?|featuring)\s+[^)\]]+[)\]]?/ig, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripLeadingArtist(title, artist) {
    let out = cleanText(title).replace(NOISE_RE, ' ').trim();
    const literalArtist = cleanText(artist);
    if (!literalArtist) return out;
    const escaped = literalArtist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return cleanText(out.replace(new RegExp(`^${escaped}\\s*[-:–—|]\\s*`, 'i'), ''));
}

function cleanProviderArtist(value) {
    return cleanText(value)
        .replace(/\s*[-–—]\s*Topic$/i, '')
        .replace(/\s*VEVO$/i, '')
        .replace(/\s+(?:official(?:\s+youtube)?(?:\s+channel)?|youtube\s+channel)$/i, '')
        .trim();
}


const CURATOR_CHANNEL_RE = /\b(?:proximity|trap nation|chill nation|bass nation|mrsuicidesheep|cloudkid|xkito|7clouds|wave music|ncs|no copyright sounds|monstercat|ukf|liquicity|suicide sheep|dynmk|koala kontrol|illenium edits|future house music)\b/i;

function uploaderLooksLikeCurator(value = '') {
    const v = cleanProviderArtist(value);
    if (!v) return false;
    return CURATOR_CHANNEL_RE.test(v) || /\b(?:records?|music|network|nation|promotion|promotions|premieres?|uploads?|channel|official)\b/i.test(v);
}

function plausibleArtistPrefix(value = '') {
    const v = cleanProviderArtist(value);
    if (!v || v.length > 120) return false;
    const words = tokenArray(v);
    if (!words.length || words.length > 9) return false;
    if (/\b(?:official|audio|video|lyrics?|visualizer|mix 20\d\d|playlist|compilation)\b/i.test(v)) return false;
    return true;
}
function splitArtistTitleArtwork(rawTitle = '', rawArtist = '') {
    const original = String(rawTitle || '');
    // Bilingual upload descriptions repeat the same credits after a pipe. The
    // first explicit Artist - Song credit remains the searchable recording.
    const pieces = original.split(/\s*[|｜]\s*/u);
    const raw = pieces.length > 1 && /\s[-–—]\s/.test(pieces[0]) ? pieces[0] : original;
    const cleanedTitle = cleanText(raw).replace(NOISE_RE, ' ').replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, ' ').replace(/\s+/g, ' ').trim();
    const fallbackArtist = cleanProviderArtist(rawArtist || '');
    // Anime/J-pop lyric channels commonly publish titles like:
    //   Re:Zero ... Opening FULL "Recollect" by Konomi Suzuki feat. ...
    // or: ED Full [Ender Ember] by MYTH & ROID. The uploader is usually a curator,
    // so parse the explicit "by Artist" credit before consulting channel identity.
    const animeBy = raw.match(/["“\[]([^"”\]]{2,120})["”\]]\s*(?:[-–—|:]\s*)?by\s+([^|\[(]{2,140})/iu)
        || raw.match(/\b(?:opening|ending|op|ed)\s+(?:full\s+)?([^|"“\[(]{2,120}?)\s+by\s+([^|\[(]{2,140})/iu);
    if (animeBy) {
        const explicitTitle = cleanText(animeBy[1]);
        const explicitArtist = cleanProviderArtist(cleanText(animeBy[2])
            .replace(/\s+(?:\(|\[)?(?:lyrics?|official|opening|ending|amv|mv)\b.*$/i, '')
            .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, '')
            .trim());
        if (explicitTitle && explicitArtist) return { title: explicitTitle, artist: explicitArtist };
    }
    // Official anime/J-pop uploads frequently use: Artist/credits "TRACK TITLE" xAnime...
    // Preserve the quoted track name instead of letting the promotional suffix poison search.
    const quoted = raw.match(/^(.{1,160}?)\s*["“「『]([^"”」』]{2,120})["”」』](.*)$/u);
    if (quoted) {
        const left = cleanProviderArtist(cleanText(quoted[1]).replace(/[\s:|\-–—]+$/g, ''));
        const qTitle = cleanText(quoted[2]);
        const tail = cleanText(quoted[3] || '');
        const overlap = !fallbackArtist || artistSimilarity(left, fallbackArtist) >= 0.34 || normalize(left).includes(normalize(fallbackArtist));
        if (left && qTitle && overlap) {
            const versionTail = hasVersion(tail) ? ` ${extractVersionHint(tail) || tail}` : '';
            return { title: cleanText(`${qTitle}${versionTail}`), artist: left };
        }
    }
    let parts = cleanedTitle.split(/\s+[-–—|]\s+/).map(x => x.trim()).filter(Boolean);
    if (parts.length < 2 && uploaderLooksLikeCurator(fallbackArtist)) {
        const compact = cleanedTitle.match(/^(.{2,100}?)\s*[-:]\s*(.{2,200})$/u);
        if (compact && plausibleArtistPrefix(compact[1])) parts = [compact[1].trim(), compact[2].trim()];
    }
    if (parts.length < 2) {
        // Some official uploads omit the dash and concatenate the upload year.
        // Remove a leading credit only when it agrees with the actual uploader;
        // never guess an artist by chopping arbitrary title words.
        const words = cleanedTitle.split(/\s+/), artistKey = normalize(fallbackArtist).replace(/\s/g, '');
        for (let count = 1; artistKey && count < Math.min(words.length, 6); count++) {
            if (normalize(words.slice(0, count).join(' ')).replace(/\s/g, '') !== artistKey) continue;
            const title = cleanText(words.slice(count).join(' ').replace(/(?<=\p{L})(?:19|20)\d{2}$/u, ''));
            if (title) return { title, artist: fallbackArtist };
        }
        return { title: cleanedTitle, artist: fallbackArtist };
    }
    const left = parts[0];
    const right = parts.slice(1).join(' - ');
    const leftTokens = tokenSet(left);
    const fallbackTokens = tokenArray(fallbackArtist);
    const overlap = fallbackTokens.length > 0 && fallbackTokens.some(t => leftTokens.has(t));
    const collaboratorLike = /(?:&|,|\bx\b|\bwith\b|\bfeat\.?\b|\bft\.?\b)/i.test(left);
    const curatorUploader = uploaderLooksLikeCurator(fallbackArtist);
    const strongDelimiterArtist = plausibleArtistPrefix(left) && right.length >= 2 && parts.length <= 3;
    const plausible = left.length <= 120 && right.length >= 2 && (
        !fallbackArtist || overlap || artistSimilarity(left, fallbackArtist) >= 0.34 || collaboratorLike || curatorUploader || strongDelimiterArtist
    );
    if (!plausible) return { title: cleanedTitle, artist: fallbackArtist };
    return { title: right, artist: cleanProviderArtist(left) || fallbackArtist };
}

function artistVariants(value = '') {
    const full = cleanProviderArtist(value);
    const parts = full.split(/\s*(?:&|,|\bx\b|\bwith\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)\s*/i).map(cleanProviderArtist).filter(Boolean);
    const out = [full, ...parts].filter(Boolean);
    return [...new Set(out.map(x => cleanText(x)))].slice(0, 5);
}

function targetInfo(track) {
    const fallbackArtist = cleanProviderArtist(track?.lyricsArtist || track?.mediaArtist || track?.artist || track?.author || '');
    const rawTitle = track?.lyricsTitle || track?.mediaTitle || track?.track || track?.title || '';
    const split = splitArtistTitleArtwork(rawTitle, fallbackArtist);
    const artist = cleanProviderArtist(split.artist || fallbackArtist);
    let title = stripLeadingArtist(split.title || rawTitle, artist || fallbackArtist);
    // Generic catalog/YouTube metadata often names the base recording. It must
    // not erase the remix/live/edit identity explicitly selected in the queue.
    const queueVersion = extractVersionHint(track?.linkedTitle || track?.title || '');
    if (queueVersion && !extractVersionHint(title)) title = cleanText(`${title} (${queueVersion})`);
    const version = extractVersionHint(title);
    const base = stripFeaturing(stripVersion(title));
    const album = cleanText(track?.album || track?.collection || '');
    const albumArtist = cleanProviderArtist(track?.albumArtist || track?.album_artist || artist);
    return { title, base, version, artist, album, albumArtist, hasVersion: hasVersion(title) };
}

function versionCompatibility(wanted, got) {
    const a = extractVersionHint(wanted);
    const b = extractVersionHint(got);
    const ah = hasVersion(wanted);
    const bh = hasVersion(got);
    if (!ah && !bh) return 1;
    if (ah !== bh) return 0;
    if (!a || !b) return similarity(wanted, got) >= 0.82 ? 0.78 : 0.28;
    const s = similarity(a, b);
    if (s >= 0.76) return 1;
    if (s >= 0.56) return 0.62;
    return 0;
}

function targetVariants(track, extra = null) {
    const list = [];
    const push = obj => {
        const info = targetInfo(obj);
        if (!info.base || !info.title) return;
        const add = value => {
            const key = `${normalize(value.title)}|${normalize(value.artist)}|${normalize(value.album)}`;
            if (!list.some(x => x.key === key)) list.push({ ...value, key });
        };
        add(info);
        // Only an explicit cross-script parenthetical is a title alias. Do not
        // turn '(Part Two)', subtitles or version names into another recording.
        const alias = !info.version && info.title.match(/^(.+?)\s*\(([^()]+)\)\s*$/u);
        if (alias) {
            const nonLatin = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Cyrillic}]/u;
            const latin = /[\p{Script=Latin}]/u;
            const a = alias[1].trim(), b = alias[2].trim();
            if ((nonLatin.test(a) && !nonLatin.test(b) && latin.test(b)) || (nonLatin.test(b) && !nonLatin.test(a) && latin.test(a))) {
                for (const title of [a, b]) add({ ...info, title, base: title });
            }
        }
    };
    if (extra) push({ ...track, ...extra });
    push(track);
    return list;
}

function candidateMatch(track, title, artist, collection = '', extra = null) {
    const gotTitle = cleanText(title || '');
    const gotArtist = cleanProviderArtist(artist || '');
    const gotCollection = cleanText(collection || '');
    if (!gotTitle) return { score: -1, tier: 0 };
    let best = { score: -1, tier: 0 };

    for (const wanted of targetVariants(track, extra)) {
        let versionTitle = gotTitle;
        if (!extractVersionHint(gotTitle) && hasVersion(gotTitle)) {
            const escaped = cleanText(wanted.base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const flat = new RegExp(`^${escaped}\\s+(.+)$`, 'i').exec(stripLeadingArtist(gotTitle, gotArtist));
            if (flat?.[1] && hasVersion(flat[1])) versionTitle = `${wanted.base} (${flat[1]})`;
        }
        const gotBase = stripFeaturing(stripVersion(stripLeadingArtist(versionTitle, gotArtist)));
        const baseSim = similarity(wanted.base, gotBase);
        const fullSim = similarity(wanted.title, versionTitle);
        const artistSim = wanted.artist && gotArtist ? artistSimilarity(wanted.artist, gotArtist) : 0;
        const versionFit = versionCompatibility(wanted.title, versionTitle);
        const albumSim = wanted.album && gotCollection ? similarity(wanted.album, gotCollection) : 0;

        if (!BAD_VARIANT_RE.test(wanted.title) && BAD_VARIANT_RE.test(`${gotTitle} ${gotCollection}`)) continue;
        if (hasVersion(versionTitle) && versionFit === 0) continue;
        if (wanted.artist && gotArtist && artistSim < 0.58) continue;
        if (baseSim < 0.52 && fullSim < 0.58) continue;

        let tier = 0;
        if (baseSim >= 0.84 && artistSim >= 0.66 && versionFit >= 0.76) tier = 4;
        else if (baseSim >= 0.72 && artistSim >= 0.56 && versionFit >= 0.50) tier = 3;
        else if (baseSim >= 0.78 && artistSim >= 0.58) tier = 2; // same song family; allow album/single art even if this provider omits the remix tag
        else if (baseSim >= 0.66 && artistSim >= 0.62 && albumSim >= 0.55) tier = 2;
        else if (baseSim >= 0.93 && artistSim >= 0.24) tier = 2; // exact song title with partial/collaborator artist metadata
        else if (baseSim >= 0.64 && artistSim >= 0.68) tier = 1;
        if (!tier) continue;

        // Another known release stays a related static fallback. An explicitly
        // different remix/edit was rejected above rather than relabeled exact.
        if (wanted.album && gotCollection && albumSim < 0.70) tier = Math.min(tier, 2);

        let score = Math.round(baseSim * 175 + fullSim * 95 + artistSim * 120 + versionFit * 120 + albumSim * 45 + tier * 65);
        if (normalize(wanted.title) === normalize(versionTitle)) score += 95;
        if (normalize(wanted.artist) && normalize(wanted.artist) === normalize(gotArtist)) score += 40;
        if (wanted.album && gotCollection && normalize(wanted.album) === normalize(gotCollection)) score += 35;
        if (score > best.score || (score === best.score && tier > best.tier)) best = { score, tier, baseSim, fullSim, artistSim, versionFit, albumSim };
    }
    return best;
}

function scoreCandidate(track, title, artist, collection = '', extra = null) {
    return candidateMatch(track, title, artist, collection, extra).score;
}

function albumMatch(track, album, artist, extra = null) {
    const gotAlbum = cleanText(album || '');
    const gotArtist = cleanProviderArtist(artist || '');
    if (!gotAlbum || !gotArtist) return { score: -1, tier: 0 };
    let best = { score: -1, tier: 0 };
    for (const wanted of targetVariants(track, extra)) {
        const artistSim = wanted.albumArtist && gotArtist ? artistSimilarity(wanted.albumArtist, gotArtist) : 0;
        if (hasVersion(gotAlbum) && versionCompatibility(wanted.title, gotAlbum) === 0
            && (!wanted.album || versionCompatibility(wanted.album, gotAlbum) === 0)) continue;
        if (wanted.album) {
            const albumSim = similarity(wanted.album, gotAlbum);
            if (albumSim >= 0.68 && (!wanted.albumArtist || !gotArtist || artistSim >= 0.46)) {
                const tier = albumSim >= 0.86 && artistSim >= 0.58 ? 3 : 2;
                const score = Math.round(albumSim * 240 + artistSim * 120 + tier * 70);
                if (score > best.score) best = { score, tier, albumSim, artistSim };
            }
        }
        // Singles are frequently named exactly like the song. This catches official single art
        // even when YouTube metadata does not expose an album field.
        const singleSim = similarity(wanted.base, stripVersion(gotAlbum));
        if (singleSim >= 0.86 && (!wanted.artist || !gotArtist || artistSimilarity(wanted.artist, gotArtist) >= 0.58)) {
            const asim = wanted.artist && gotArtist ? artistSimilarity(wanted.artist, gotArtist) : 0;
            const score = Math.round(singleSim * 215 + asim * 125 + 120);
            if (score > best.score) best = { score, tier: 2, albumSim: singleSim, artistSim: asim };
        }
    }
    return best;
}

function trackKey(track) {
    const t = targetInfo(track);
    // Keep the playing source in the cache identity. Two uploads can expose the
    // same visible title/artist while yt-dlp discovers different release/album
    // metadata; sharing a previous miss would suppress that deeper lookup and can
    // pin the second upload to YouTube. Per-source keys trade a little extra network
    // work for materially better cover accuracy.
    const source = ytVideoId(track?.url || '') || String(track?.url || '').trim();
    if (!t.title && !source) return '';
    return JSON.stringify([
        normalize(t.title), normalize(t.artist), normalize(t.album), normalize(t.albumArtist), source,
        String(track?.linkedProvider || track?.provider || '').toLowerCase(),
        String(track?.linkedOriginalUrl || ''), String(track?.linkedThumbnail || ''),
        String(track?.thumbnail || ''), Number(track?.duration || 0) || 0,
    ]);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function httpRequest(url, options, consume) {
    if (activeHttpRequests >= HTTP_CONCURRENCY) await new Promise(resolve => httpWaiters.push(resolve));
    else activeHttpRequests++;
    const controller = new AbortController();
    const { timeoutMs = PROVIDER_TIMEOUT_MS, ...requestOptions } = options;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response;
    try {
        response = await fetch(url, { ...requestOptions, signal: controller.signal });
        return await consume(response);
    } finally {
        clearTimeout(timer);
        try { await response?.body?.cancel?.(); } catch (_) {}
        const next = httpWaiters.shift();
        if (next) next();
        else activeHttpRequests--;
    }
}

async function fetchJson(url, { timeoutMs = PROVIDER_TIMEOUT_MS, headers = {}, attempts = 2 } = {}) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await httpRequest(url, {
                timeoutMs,
                headers: {
                    'User-Agent': 'MusicByA/6.4.1 artwork resolver',
                    Accept: 'application/json, text/plain;q=0.8, */*;q=0.5',
                    ...headers,
                },
                redirect: 'follow',
            }, async response => {
                if (!response.ok) {
                    const error = new Error(`HTTP ${response.status}`);
                    error.status = response.status;
                    const retryAfter = Number(response.headers?.get?.('retry-after') || 0);
                    error.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(2500, retryAfter * 1000) : 0;
                    throw error;
                }
                return await response.json();
            });
        } catch (err) {
            lastError = err;
            if (attempt + 1 >= attempts || (err?.status && err.status < 500 && err.status !== 429)) throw err;
            await sleep(err?.retryAfterMs || 160 * (attempt + 1));
        }
    }
    throw lastError || new Error('metadata request failed');
}


async function fetchText(url, { timeoutMs = PROVIDER_TIMEOUT_MS, headers = {}, attempts = 1 } = {}) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await httpRequest(url, {
                timeoutMs,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
                    Accept: 'text/html,application/json,text/plain,*/*;q=0.8',
                    ...headers,
                },
                redirect: 'follow',
            }, async response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return await response.text();
            });
        } catch (err) {
            lastError = err;
            if (attempt + 1 >= attempts) throw err;
            await sleep(120 * (attempt + 1));
        }
    }
    throw lastError || new Error('text request failed');
}

function absoluteUrl(value, base) {
    try { return new URL(String(value || '').trim(), base).toString(); } catch (_) { return ''; }
}

function publicMediaUrl(value, base = '') {
    try {
        const url = new URL(String(value || '').trim(), base || undefined);
        const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return '';
        if (net.isIP(host) || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|onion)$/.test(host)) return '';
        return url.href;
    } catch (_) { return ''; }
}

async function mediaRequest(url, options, consume) {
    let current = publicMediaUrl(url);
    if (!current) throw new Error('blocked motion media target');
    for (let redirects = 0; redirects <= 4; redirects++) {
        const result = await httpRequest(current, { ...options, redirect: 'manual' }, async response => {
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const next = publicMediaUrl(response.headers?.get?.('location'), current);
                if (!next) throw new Error('blocked motion media redirect');
                return { redirect: next };
            }
            if (response.url && !publicMediaUrl(response.url)) throw new Error('blocked motion media response');
            return { value: await consume(response) };
        });
        if (!result.redirect) return result.value;
        current = result.redirect;
    }
    throw new Error('too many motion media redirects');
}

async function fetchMotionPlaylist(url) {
    return mediaRequest(url, { timeoutMs: ANIMATED_TIMEOUT_MS, headers: { Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain' } }, async response => {
        if (!response.ok) throw new Error(`motion playlist HTTP ${response.status}`);
        const text = await response.text();
        if (text.length > 1024 * 1024) throw new Error('motion playlist too large');
        return text;
    });
}

function usableMotionPlaylist(text, url) {
    const raw = String(text || '');
    if (!/^#EXTM3U\s*$/m.test(raw) || !/#EXTINF:\s*\d+(?:\.\d+)?\s*,/i.test(raw) || !/#EXT-X-ENDLIST/m.test(raw)) return false;
    if (/#EXT-X-KEY:.*METHOD=(?!NONE(?:,|\s|$))/i.test(raw)) return false;
    for (const line of raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
        if (!line.startsWith('#') && !publicMediaUrl(line, url)) return false;
        for (const match of line.matchAll(/\bURI=(?:"([^"]+)"|([^,\s]+))/g)) {
            if (!publicMediaUrl(match[1] || match[2], url)) return false;
        }
    }
    return true;
}

function motionUrlToMp4(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/\.mp4(?:$|\?)/i.test(raw) || /\.webm(?:$|\?)/i.test(raw)) return raw;
    try {
        const u = new URL(raw);
        if (!/\.m3u8$/i.test(u.pathname)) return '';
        u.pathname = u.pathname.includes('_-.m3u8')
            ? u.pathname.replace(/_-\.m3u8$/i, '_-.mp4')
            : u.pathname.replace(/\.m3u8$/i, '-.mp4');
        return u.toString();
    } catch (_) { return ''; }
}

function parseMotionMaster(text, masterUrl = '') {
    const variants = [];
    let info = '';
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('#EXT-X-STREAM-INF')) { info = line; continue; }
        if (!info || !line || line.startsWith('#')) continue;
        const resolved = publicMediaUrl(line, masterUrl);
        const m = info.match(/RESOLUTION=(\d+)x(\d+)/i);
        const bw = Number(info.match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/i)?.[1] || 0);
        if (resolved && m) {
            const width = Number(m[1]);
            const height = Number(m[2]);
            const mp4 = motionUrlToMp4(resolved);
            if (mp4) variants.push({ url: mp4, playlist: resolved, width, height, bitrate: bw, pixels: width * height,
                codecs: info.match(/CODECS="([^"]+)"/i)?.[1] || '', format: /\.webm(?:$|\?)/i.test(mp4) ? 'webm' : 'mp4',
                mime: /\.webm(?:$|\?)/i.test(mp4) ? 'video/webm' : 'video/mp4' });
        }
        info = '';
    }
    return variants;
}

function motionSort(a, b) {
    const squareA = Math.abs((Number(a.width || 1) / Math.max(1, Number(a.height || 1))) - 1);
    const squareB = Math.abs((Number(b.width || 1) / Math.max(1, Number(b.height || 1))) - 1);
    if (Math.abs(squareA - squareB) > 0.08) return squareA - squareB;
    const px = Number(b.pixels || (b.width || 0) * (b.height || 0)) - Number(a.pixels || (a.width || 0) * (a.height || 0));
    if (px) return px;
    return Number(b.bitrate || 0) - Number(a.bitrate || 0);
}

async function appleDeveloperToken() {
    const now = Math.floor(Date.now() / 1000);
    if (appleTokenCache.token && Number(appleTokenCache.exp || 0) - now > 300) return appleTokenCache.token;
    const html = await fetchText('https://music.apple.com/us/browse', {
        timeoutMs: ANIMATED_TIMEOUT_MS,
        headers: { Accept: 'text/html' },
        attempts: 2,
    });
    const bundle = html.match(/\/assets\/index[^"']*\.js/i)?.[0]
        || html.match(/https:\/\/music\.apple\.com\/assets\/index[^"']*\.js/i)?.[0];
    if (!bundle) throw new Error('Apple Music web bundle not found');
    const bundleUrl = absoluteUrl(bundle, 'https://music.apple.com/us/browse');
    const js = await fetchText(bundleUrl, { timeoutMs: Math.max(ANIMATED_TIMEOUT_MS, 12000), attempts: 2 });
    const token = js.match(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0] || '';
    if (!token) throw new Error('Apple Music developer token not found');
    let exp = now + 6 * 60 * 60;
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        if (Number(payload?.exp)) exp = Number(payload.exp);
    } catch (_) {}
    appleTokenCache = { token, exp };
    return token;
}

async function appleMotionMasters(albumId, storefront = 'US', renewToken = true) {
    if (!/^\d{1,20}$/.test(String(albumId || '')) || !ANIMATED_APPLE_ENABLED) return [];
    const token = await appleDeveloperToken();
    const sf = String(storefront || 'US').trim().toLowerCase() || 'us';
    const result = await httpRequest(`https://amp-api.music.apple.com/v1/catalog/${encodeURIComponent(sf)}/albums/${encodeURIComponent(albumId)}?extend=editorialVideo`, {
            timeoutMs: ANIMATED_TIMEOUT_MS,
            headers: {
                Authorization: `Bearer ${token}`,
                Origin: 'https://music.apple.com',
                Accept: 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
            },
            redirect: 'error',
        }, async response => {
        if (response.status === 401) { appleTokenCache = { token: '', exp: 0 }; return null; }
        if (!response.ok) return [];
        const data = await response.json();
        if (data?.data?.[0]?.id && String(data.data[0].id) !== String(albumId)) return [];
        const ev = data?.data?.[0]?.attributes?.editorialVideo || {};
        const out = [];
        for (const [kind, value] of Object.entries(ev)) {
            const url = publicMediaUrl(typeof value?.video === 'string' ? value.video : value?.video?.url);
            if (!url || out.some(x => x.url === url)) continue;
            out.push({ url, kind, width: Number(value.width || 0), height: Number(value.height || 0), codecs: String(value.codecs || '') });
        }
        return out;
        });
    if (result === null && renewToken) return appleMotionMasters(albumId, storefront, false);
    return result || [];
}

async function videoUrlReachable(url) {
    const raw = String(url || '').trim();
    if (!publicMediaUrl(raw)) return false;
    for (const method of ['HEAD', 'GET']) {
        try {
            const headers = { 'User-Agent': 'MusicByA/6.4.1 animated artwork', Accept: 'video/mp4,video/webm,application/octet-stream,*/*;q=0.5' };
            if (method === 'GET') headers.Range = 'bytes=0-4095';
            const reachable = await mediaRequest(raw, { method, headers, timeoutMs: Math.min(5000, ANIMATED_TIMEOUT_MS) }, async response => {
                const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
                return Boolean((response.ok || response.status === 206) && (!type || type.startsWith('video/') || type.includes('octet-stream')));
            });
            if (reachable) return true;
        } catch (_) {
        }
    }
    return false;
}

async function appleMotionForCandidate(candidate) {
    if (!candidate?.collectionId) return [];
    const storefronts = [...new Set([candidate.storefront, ...APPLE_STOREFRONTS])].filter(Boolean).slice(0, 5);
    let masters = [];
    for (const sf of storefronts) {
        try { masters = await appleMotionMasters(candidate.collectionId, sf); } catch (_) { masters = []; }
        if (masters.length) break;
    }
    if (!masters.length) return [];
    const settled = await runTasks(masters.slice(0, 5).map(master => async () => {
        if (/\.mp4(?:$|\?)/i.test(master.url) || /\.webm(?:$|\?)/i.test(master.url)) {
            if (/tall/i.test(master.kind) && !master.width) return [];
            const dimensions = master.width && master.height ? master : dimensionsFromUrl(master.url);
            return [{ url: master.url, playlist: '', width: dimensions.width, height: dimensions.height, pixels: dimensions.width * dimensions.height,
                bitrate: 0, codecs: master.codecs, format: /\.webm(?:$|\?)/i.test(master.url) ? 'webm' : 'mp4',
                mime: /\.webm(?:$|\?)/i.test(master.url) ? 'video/webm' : 'video/mp4' }];
        }
        const text = await fetchMotionPlaylist(master.url);
        const parsed = parseMotionMaster(text, master.url);
        if (parsed.length) return parsed;
        if (/square/i.test(master.kind) && usableMotionPlaylist(text, master.url)) {
            return [{ url: master.url, playlist: master.url, width: master.width, height: master.height, pixels: master.width * master.height,
                bitrate: 0, codecs: master.codecs, format: 'hls', mime: 'application/vnd.apple.mpegurl', playlistValidated: true }];
        }
        return [];
    }), Math.min(5, HTTP_CONCURRENCY));
    const variants = [];
    for (const r of settled) if (r.status === 'fulfilled') variants.push(...r.value);
    const unique = [];
    const seen = new Set();
    for (const item of variants.sort(motionSort)) {
        const key = String(item.url);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const ratio = Number(item.width || 1) / Math.max(1, Number(item.height || 1));
        if (ratio < 0.82 || ratio > 1.22) continue; // main player artwork is square; tall motion is not substituted here
        unique.push({
            ...item,
            source: 'apple-motion',
            official: true,
            collectionId: candidate.collectionId,
            artist: candidate.artist || '',
            collection: candidate.collection || '',
            matchTier: Number(candidate.tier || 0),
            matchScore: Number(candidate.score || 0),
        });
    }
    if (!unique.length) return [];
    // Validate the highest few only. If the direct MP4 derivation changes upstream,
    // a lower Apple variant can still survive and the static artwork remains intact.
    const checks = await runTasks(unique.slice(0, 6).map(item => async () => {
        if (item.format === 'hls' && item.playlistValidated) return item;
        if (await videoUrlReachable(item.url)) return item;
        if (item.playlist && /\.m3u8(?:$|\?)/i.test(item.playlist)) {
            const text = await fetchMotionPlaylist(item.playlist);
            if (usableMotionPlaylist(text, item.playlist)) return { ...item, url: item.playlist, format: 'hls', mime: 'application/vnd.apple.mpegurl' };
        }
        return null;
    }), Math.min(6, HTTP_CONCURRENCY));
    return checks.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value).sort(motionSort);
}

function collectMotionUrls(value, out = [], depth = 0) {
    if (depth > 10 || out.length > 40 || value == null) return out;
    if (typeof value === 'string') {
        const raw = value.trim();
        if (/^https:\/\//i.test(raw) && /\.(?:mp4|webm)(?:$|\?)/i.test(raw)) out.push(raw);
        return out;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectMotionUrls(item, out, depth + 1);
        return out;
    }
    if (typeof value === 'object') {
        for (const item of Object.values(value)) collectMotionUrls(item, out, depth + 1);
    }
    return out;
}

function dimensionsFromUrl(url) {
    const m = String(url || '').match(/(?:^|[/_-])(\d{3,5})x(\d{3,5})(?:[/_.-]|$)/i);
    if (!m) return { width: 0, height: 0 };
    return { width: Number(m[1]), height: Number(m[2]) };
}

function motionCacheKey(track) { return trackKey(track); }

function motionArtworkKey(artwork) {
    return JSON.stringify([artwork?.url || '', artwork?.source || '', artwork?.collection || '', artwork?.collectionId || 0,
        (artwork?._motionHints || []).map(x => `${x.collectionId}:${x.tier}`).sort()]);
}

function getCachedMotion(track, artwork = null) {
    const key = motionCacheKey(track);
    const hit = motionCache.get(key);
    if (!hit) return null;
    if (hit.until <= Date.now()) { motionCache.delete(key); return null; }
    if (artwork && hit.artworkKey !== motionArtworkKey(artwork)) return null;
    motionCache.delete(key); motionCache.set(key, hit);
    return hit.value;
}

function signedMediaExpiresAt(value) {
    try {
        const url = new URL(String(value || ''));
        for (const [key, raw] of url.searchParams) {
            const explicit = /^(?:expires?|expiry)$/i.test(key) ? raw : raw.match(/(?:^|[~&])exp=(\d{9,13})(?:[~&]|$)/i)?.[1];
            if (!explicit || !/^\d{9,13}$/.test(explicit)) continue;
            const stamp = Number(explicit);
            return stamp < 100000000000 ? stamp * 1000 : stamp;
        }
    } catch (_) {}
    return 0;
}

function setCachedMotion(track, value, artwork = null) {
    const key = motionCacheKey(track);
    if (!key) return;
    motionCache.delete(key);
    let until = Date.now() + (value?.url ? ANIMATED_CACHE_TTL_MS : ANIMATED_MISS_TTL_MS);
    for (const url of [value?.url, value?.playlist, ...(value?.fallbacks || [])]) {
        const expiry = signedMediaExpiresAt(url);
        if (expiry) until = Math.min(until, expiry - 30000);
    }
    motionCache.set(key, { value, artworkKey: motionArtworkKey(artwork), until });
    while (motionCache.size > Math.max(100, CACHE_MAX)) motionCache.delete(motionCache.keys().next().value);
}

function attachMotion(track, artwork) {
    if (!artwork || !ANIMATED_ENABLED) return artwork;
    const motion = getCachedMotion(track, artwork);
    if (!motion?.url) return artwork;
    const value = { ...artwork, animated: motion };
    const hints = Object.getOwnPropertyDescriptor(artwork, '_motionHints');
    if (hints) Object.defineProperty(value, '_motionHints', hints);
    return value;
}

function motionCandidateFits(track, artwork, candidate) {
    if (!candidate?.collectionId || Number(candidate.tier || 0) < 3) return false;
    const t = targetInfo(track);
    const album = cleanText(artwork?.collection || t.album);
    const artist = cleanProviderArtist(artwork?.artist || t.albumArtist || t.artist);
    if (album && candidate.collection && normalize(album) !== normalize(candidate.collection)) return false;
    if (artist && candidate.artist && artistSimilarity(artist, candidate.artist) < 0.66) return false;
    if (/^apple-/i.test(String(artwork?.source || '')) && artwork?.collectionId && Number(artwork.collectionId) !== Number(candidate.collectionId)) return false;
    return true;
}

async function resolveAnimatedArtwork(track, artwork) {
    if (!ANIMATED_ENABLED) return null;
    const hints = Array.isArray(artwork?._motionHints) ? artwork._motionHints : [];
    if (artwork?.official && artwork?.matchTier > 0 && artwork.matchTier < 3) return null;
    let candidates = hints.filter(x => motionCandidateFits(track, artwork, x)).sort(candidateSort).slice(0, ANIMATED_MAX_CANDIDATES);
    if (!candidates.length) {
        try { candidates = (await itunesSongCandidates(track, null, true)).filter(x => motionCandidateFits(track, artwork, x)).sort(candidateSort).slice(0, ANIMATED_MAX_CANDIDATES); }
        catch (_) { candidates = []; }
    }
    for (const candidate of candidates) {
        if (ANIMATED_APPLE_ENABLED) {
            try {
                const apple = await appleMotionForCandidate(candidate);
                if (apple.length) return { ...apple[0], fallbacks: apple.slice(1, 8).map(x => x.url), fallbackSources: apple.slice(1, 8).map(x => ({ ...x })) };
            } catch (_) {}
        }
        // The MusicHoarders internal search API rejects direct integrations.
        // Do not fetch it or label recursively collected, unrelated video URLs
        // as official album motion. Only identity-bound provider media qualifies.
    }
    return null;
}

function warmAnimatedArtwork(track, artwork = null, options = {}) {
    if (!ANIMATED_ENABLED) return Promise.resolve(null);
    const snapshot = { ...track };
    const key = motionCacheKey(snapshot);
    if (!key) return Promise.resolve(null);
    const artworkKey = motionArtworkKey(artwork);
    const cached = options.forceRefresh ? null : getCachedMotion(snapshot, artwork);
    if (cached !== null) return Promise.resolve(cached?.url ? cached : null);
    const active = motionInflight.get(key);
    if (active?.artworkKey === artworkKey) return active.work;
    const work = resolveAnimatedArtwork(snapshot, artwork)
        .then(value => {
            if (motionInflight.get(key)?.work === work) setCachedMotion(snapshot, value || {}, artwork);
            return value || null;
        })
        .catch(() => {
            if (motionInflight.get(key)?.work === work) setCachedMotion(snapshot, {}, artwork);
            return null;
        })
        .finally(() => { if (motionInflight.get(key)?.work === work) motionInflight.delete(key); });
    motionInflight.set(key, { work, artworkKey });
    return work;
}

async function mbJson(url) {
    const work = mbQueue.catch(() => {}).then(async () => {
        const wait = Math.max(0, lastMbRequestAt + 1100 - Date.now());
        if (wait) await sleep(wait);
        lastMbRequestAt = Date.now();
        return fetchJson(url, {
            timeoutMs: Math.min(5200, PROVIDER_TIMEOUT_MS + 1400),
            attempts: 2,
            headers: { 'User-Agent': 'MusicByA/6.1.6 (personal music player)', Accept: 'application/json' },
        });
    });
    mbQueue = work.catch(() => {});
    return work;
}

async function runTasks(tasks, limit = HTTP_CONCURRENCY) {
    const out = new Array(tasks.length);
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
        while (true) {
            const i = index++;
            if (i >= tasks.length) return;
            try { out[i] = { status: 'fulfilled', value: await tasks[i]() }; }
            catch (reason) { out[i] = { status: 'rejected', reason }; }
        }
    });
    await Promise.all(workers);
    return out;
}

function ytVideoId(value = '') {
    const s = String(value || '');
    for (const re of [
        /(?:youtube\.com\/watch\?[^#]*\bv=|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{6,})/i,
        /^([A-Za-z0-9_-]{11})$/,
    ]) {
        const m = s.match(re);
        if (m) return m[1];
    }
    return '';
}

function youtubeFallbacks(track) {
    const id = ytVideoId(track?.url || '') || ytVideoId(track?.thumbnail || '');
    if (!id) return track?.thumbnail ? [String(track.thumbnail)] : [];
    return [
        `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
        `https://i.ytimg.com/vi/${id}/hq720.jpg`,
        `https://i.ytimg.com/vi/${id}/sddefault.jpg`,
        `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        String(track?.thumbnail || ''),
    ].filter(Boolean);
}

function highResItunes(url, size = APPLE_STATIC_SIZE) {
    const raw = String(url || '');
    if (!raw) return '';
    const px = Math.max(1000, Math.min(6000, Number(size || APPLE_STATIC_SIZE)));
    return raw
        .replace(/\/([0-9]{2,4})x\1bb(?=[-/.])/i, `/${px}x${px}bb`)
        .replace(/\/([0-9]{2,4})x\1sr(?=[-/.])/i, `/${px}x${px}sr`);
}

function uniqueCandidates(items) {
    const map = new Map();
    for (const item of items || []) {
        if (!item?.url || !/^https:\/\//i.test(item.url)) continue;
        const expiry = signedMediaExpiresAt(item.url);
        if (expiry && expiry <= Date.now() + 30000) continue;
        const key = String(item.url);
        const old = map.get(key);
        if (!old || candidateSort(item, old) < 0) map.set(key, item);
    }
    return [...map.values()];
}

function candidateSort(a, b) {
    const tier = Number(b.tier || 0) - Number(a.tier || 0);
    if (tier) return tier;
    const score = Number(b.score || 0) - Number(a.score || 0);
    // Once two sources agree on the same confidence tier, image quality matters
    // more than a small metadata-score difference. This lets a 2000px Apple cover
    // beat a 1000px copy when both identify the same release.
    if (Math.abs(score) > 90) return score;
    const official = Number(Boolean(b.official)) - Number(Boolean(a.official));
    if (official) return official;
    const quality = Number(b.quality || 0) - Number(a.quality || 0);
    if (quality) return quality;
    return score;
}

function buildQueryVariants(track, extra = null, deep = false) {
    const out = [];
    const add = value => {
        const v = cleanText(value);
        if (!v) return;
        const key = normalize(v);
        if (!key || out.some(x => normalize(x) === key)) return;
        out.push(v);
    };
    for (const t of targetVariants(track, extra)) {
        const artists = artistVariants(t.artist);
        add(`${t.artist} ${t.title}`);
        add(`${t.artist} ${t.base}`);
        for (const a of artists) {
            add(`${a} ${t.title}`);
            add(`${a} ${t.base}`);
        }
        if (deep) {
            add(`${t.title} ${t.artist}`);
            add(t.title);
            add(t.base);
            if (t.version) add(`${t.base} ${t.version}`);
        }
    }
    return out.slice(0, deep ? 16 : 7);
}

function buildAlbumQueries(track, extra = null) {
    const out = [];
    const add = value => {
        const v = cleanText(value);
        if (!v || out.some(x => normalize(x) === normalize(v))) return;
        out.push(v);
    };
    for (const t of targetVariants(track, extra)) {
        const artists = artistVariants(t.albumArtist || t.artist);
        if (t.album) {
            add(`${t.albumArtist || t.artist} ${t.album}`);
            add(`${t.album} ${t.albumArtist || t.artist}`);
            for (const a of artists) add(`${a} ${t.album}`);
        }
        // Song-named singles and base-song releases are valid official art fallbacks.
        add(`${t.artist} ${t.base}`);
        for (const a of artistVariants(t.artist)) add(`${a} ${t.base}`);
    }
    return out.slice(0, 12);
}

async function itunesSongCandidates(track, extra = null, deep = false) {
    const queries = buildQueryVariants(track, extra, deep);
    const storefronts = deep ? APPLE_STOREFRONTS : APPLE_STOREFRONTS.slice(0, 1);
    const tasks = [];
    for (const country of storefronts) for (const query of queries) tasks.push(async () => {
        const json = await fetchJson(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&media=music&limit=${deep ? 40 : 28}&country=${encodeURIComponent(country)}`);
        return { country, results: Array.isArray(json?.results) ? json.results : [] };
    });
    const settled = await runTasks(tasks);
    const out = [];
    for (const r of settled) {
        if (r.status !== 'fulfilled') continue;
        const country = String(r.value?.country || 'US').toUpperCase();
        for (const item of (r.value?.results || [])) {
            if (!recordingDurationFits(track, Number(item.trackTimeMillis || 0) / 1000)) continue;
            const title = item.trackName || '';
            const artist = item.artistName || '';
            const collection = item.collectionName || '';
            const match = candidateMatch(track, title, artist, collection, extra);
            if (match.tier < 1 || match.score < 250) continue;
            const url = highResItunes(item.artworkUrl100 || item.artworkUrl60 || item.artworkUrl30);
            if (url) out.push({ url, score: match.score + 42, tier: match.tier, source: 'apple-track', official: true, quality: APPLE_STATIC_SIZE, title, artist, collection, collectionId: Number(item.collectionId || 0) || 0, trackId: Number(item.trackId || 0) || 0, storefront: country });
        }
    }
    return out;
}

function recordingDurationFits(track, duration) {
    const wanted = Number(track?.duration || 0);
    const got = Number(duration || 0);
    if (!(wanted > 0) || !(got > 0)) return true;
    // Music-video intros/outros differ from album audio, but a doubled runtime
    // is another recording, medley or performance despite the same title.
    return Math.abs(wanted - got) <= Math.max(45, wanted * 0.22);
}

function deezerTrackTitle(item) {
    const title = cleanText(item?.title || item?.title_short || '');
    const version = cleanText(item?.title_version || '');
    if (!version || normalize(title).includes(normalize(version))) return title;
    const base = cleanText(item?.title_short || title);
    // Some clients supply the complete version title; Deezer's actual search
    // response normally supplies only a suffix in title_version.
    if (normalize(version).includes(normalize(base))) return version;
    const suffix = /^[([]/.test(version) ? version : `(${version})`;
    return cleanText(`${base} ${suffix}`);
}

async function itunesAlbumCandidates(track, extra = null) {
    const queries = buildAlbumQueries(track, extra);
    const tasks = [];
    for (const country of APPLE_STOREFRONTS) for (const query of queries) tasks.push(async () => {
        const json = await fetchJson(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=album&media=music&limit=25&country=${encodeURIComponent(country)}`);
        return { country, results: Array.isArray(json?.results) ? json.results : [] };
    });
    const settled = await runTasks(tasks);
    const out = [];
    for (const r of settled) {
        if (r.status !== 'fulfilled') continue;
        const country = String(r.value?.country || 'US').toUpperCase();
        for (const item of (r.value?.results || [])) {
            const collection = item.collectionName || '';
            const artist = item.artistName || '';
            const match = albumMatch(track, collection, artist, extra);
            if (match.tier < 2 || match.score < 250) continue;
            const url = highResItunes(item.artworkUrl100 || item.artworkUrl60 || item.artworkUrl30);
            if (url) out.push({ url, score: match.score + 28, tier: match.tier, source: 'apple-album', official: true, quality: APPLE_STATIC_SIZE, artist, collection, collectionId: Number(item.collectionId || 0) || 0, storefront: country });
        }
    }
    return out;
}

async function deezerSongCandidates(track, extra = null, deep = false) {
    const queries = buildQueryVariants(track, extra, deep);
    const tasks = queries.map(query => async () => {
        const json = await fetchJson(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=${deep ? 45 : 30}&output=json`);
        return Array.isArray(json?.data) ? json.data : [];
    });
    const settled = await runTasks(tasks);
    const out = [];
    for (const r of settled) {
        if (r.status !== 'fulfilled') continue;
        for (const item of r.value) {
            if (!recordingDurationFits(track, item.duration)) continue;
            const title = deezerTrackTitle(item);
            const artist = item.artist?.name || '';
            const collection = item.album?.title || '';
            const match = candidateMatch(track, title, artist, collection, extra);
            if (match.tier < 1 || match.score < 245) continue;
            const url = item.album?.cover_xl || item.album?.cover_big || item.album?.cover_medium || item.album?.cover || '';
            if (url) out.push({ url, score: match.score + 30, tier: match.tier, source: 'deezer-track', official: true, quality: item.album?.cover_xl ? 1000 : 500, title, artist, collection });
        }
    }
    return out;
}

async function deezerAlbumCandidates(track, extra = null) {
    const queries = buildAlbumQueries(track, extra);
    const tasks = queries.map(query => async () => {
        const json = await fetchJson(`https://api.deezer.com/search/album?q=${encodeURIComponent(query)}&limit=30&output=json`);
        return Array.isArray(json?.data) ? json.data : [];
    });
    const settled = await runTasks(tasks);
    const out = [];
    for (const r of settled) {
        if (r.status !== 'fulfilled') continue;
        for (const item of r.value) {
            const collection = item.title || '';
            const artist = item.artist?.name || '';
            const match = albumMatch(track, collection, artist, extra);
            if (match.tier < 2 || match.score < 245) continue;
            const url = item.cover_xl || item.cover_big || item.cover_medium || item.cover || '';
            if (url) out.push({ url, score: match.score + 18, tier: match.tier, source: 'deezer-album', official: true, quality: item.cover_xl ? 1000 : 500, artist, collection });
        }
    }
    return out;
}

function mbQueryValue(value) {
    return String(value || '').replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function musicBrainzRecordingCandidates(track, extra = null, deep = false) {
    const targets = targetVariants(track, extra);
    const queries = [];
    const add = q => { if (q && !queries.includes(q)) queries.push(q); };
    for (const t of targets) {
        add(`recording:"${mbQueryValue(t.title)}"${t.artist ? ` AND artist:"${mbQueryValue(t.artist)}"` : ''}`);
        if (deep) add(`recording:"${mbQueryValue(t.base)}"${t.artist ? ` AND artist:"${mbQueryValue(t.artist)}"` : ''}`);
    }
    const out = [];
    for (const query of queries.slice(0, deep ? 2 : 1)) {
        let json;
        try { json = await mbJson(`https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&limit=${deep ? 18 : 12}&fmt=json`); }
        catch (_) { continue; }
        for (const item of (Array.isArray(json?.recordings) ? json.recordings : [])) {
            if (!recordingDurationFits(track, Number(item.length || 0) / 1000)) continue;
            const title = item.title || '';
            const artist = (item['artist-credit'] || []).map(x => x?.name).filter(Boolean).join(', ');
            const match = candidateMatch(track, title, artist, '', extra);
            if (match.tier < 1 || match.score < 250) continue;
            for (const release of (item.releases || []).slice(0, 6)) {
                if (release?.id) out.push({
                    url: `https://coverartarchive.org/release/${release.id}/front-1200`,
                    score: match.score + 12,
                    tier: match.tier,
                    source: 'musicbrainz-release', official: true, quality: 1200,
                    title, artist, collection: release.title || '',
                });
                const rg = release?.['release-group']?.id;
                if (rg) out.push({
                    url: `https://coverartarchive.org/release-group/${rg}/front-1200`,
                    score: match.score + 18,
                    tier: match.tier,
                    source: 'musicbrainz-release-group', official: true, quality: 1200,
                    title, artist, collection: release?.['release-group']?.title || release.title || '',
                });
            }
        }
    }
    return out;
}

async function musicBrainzAlbumCandidates(track, extra = null) {
    const targets = targetVariants(track, extra).filter(x => x.album);
    const out = [];
    for (const t of targets.slice(0, 1)) {
        const query = `releasegroup:"${mbQueryValue(t.album)}"${(t.albumArtist || t.artist) ? ` AND artist:"${mbQueryValue(t.albumArtist || t.artist)}"` : ''}`;
        let json;
        try { json = await mbJson(`https://musicbrainz.org/ws/2/release-group?query=${encodeURIComponent(query)}&limit=12&fmt=json`); }
        catch (_) { continue; }
        for (const item of (Array.isArray(json?.['release-groups']) ? json['release-groups'] : [])) {
            const artist = (item['artist-credit'] || []).map(x => x?.name).filter(Boolean).join(', ');
            const match = albumMatch(track, item.title || '', artist, extra);
            if (match.tier < 2 || match.score < 250 || !item.id) continue;
            out.push({
                url: `https://coverartarchive.org/release-group/${item.id}/front-1200`,
                score: match.score + 24,
                tier: match.tier,
                source: 'musicbrainz-album', official: true, quality: 1200,
                artist, collection: item.title || '',
            });
        }
    }
    return out;
}

function metadataFromTrack(track) {
    return {
        mediaTitle: cleanText(track?.mediaTitle || track?.track || ''),
        mediaArtist: cleanProviderArtist(track?.mediaArtist || track?.artist || ''),
        album: cleanText(track?.album || ''),
        albumArtist: cleanProviderArtist(track?.albumArtist || track?.album_artist || ''),
        releaseYear: Number(track?.releaseYear || track?.release_year || 0) || 0,
    };
}

function usefulMetadata(meta) {
    return Boolean(meta && (meta.mediaTitle || meta.mediaArtist || meta.album || meta.albumArtist));
}

async function enrichYoutubeMetadata(track) {
    const existing = metadataFromTrack(track);
    const url = String(track?.url || '');
    if (!ytVideoId(url) || config.ARTWORK_YTDLP_METADATA === false) return existing;
    try {
        const provider = require('./ytDlpProvider');
        const data = await provider.runYtDlpJson(['--dump-single-json', '--no-playlist', '--', url], METADATA_TIMEOUT_MS);
        const meta = {
            mediaTitle: cleanText(data?.track || data?.alt_title || existing.mediaTitle || ''),
            mediaArtist: cleanProviderArtist(data?.artist || data?.creator || data?.album_artist || existing.mediaArtist || ''),
            album: cleanText(data?.album || existing.album || ''),
            albumArtist: cleanProviderArtist(data?.album_artist || data?.artist || existing.albumArtist || ''),
            releaseYear: Number(data?.release_year || String(data?.release_date || '').slice(0, 4) || existing.releaseYear || 0) || 0,
        };
        // Ignore the YouTube display title as enrichment unless yt-dlp provided a
        // real track/alt_title field; the original queue title is already available.
        return { ...existing, ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v)) };
    } catch (_) {
        return existing;
    }
}

async function fastCommercialCandidates(track) {
    const settled = await Promise.allSettled([
        itunesSongCandidates(track, null, false),
        deezerSongCandidates(track, null, false),
    ]);
    const all = [];
    for (const r of settled) if (r.status === 'fulfilled') all.push(...r.value);
    return uniqueCandidates(all).sort(candidateSort);
}

async function deepOfficialCandidates(track, extra) {
    const settled = await Promise.allSettled([
        itunesSongCandidates(track, extra, true),
        deezerSongCandidates(track, extra, true),
        itunesAlbumCandidates(track, extra),
        deezerAlbumCandidates(track, extra),
        musicBrainzRecordingCandidates(track, extra, true),
        musicBrainzAlbumCandidates(track, extra),
    ]);
    const all = [];
    for (const r of settled) if (r.status === 'fulfilled') all.push(...r.value);
    return uniqueCandidates(all).sort(candidateSort);
}

async function resolveOfficialCandidates(track) {
    // Start metadata/MB work in parallel with the fast commercial pass. A strong
    // Apple/Deezer hit returns immediately. For misses, launch the broad search
    // using the existing title while yt-dlp continues extracting album metadata.
    const enrichPromise = enrichYoutubeMetadata(track);
    const mbFastPromise = musicBrainzRecordingCandidates(track, null, false).catch(() => []);
    const fast = await fastCommercialCandidates(track);
    const strong = fast[0] && Number(fast[0].tier || 0) >= 4 && Number(fast[0].score || 0) >= 520;
    if (strong) return fast;

    const deepBasePromise = deepOfficialCandidates(track, null);
    const [extra, mbFast, deepBase] = await Promise.all([enrichPromise, mbFastPromise, deepBasePromise]);
    let merged = uniqueCandidates([...fast, ...(mbFast || []), ...(deepBase || [])]).sort(candidateSort);

    const alreadyGood = merged[0] && Number(merged[0].tier || 0) >= 3;
    const baseMeta = metadataFromTrack(track);
    const enrichedAddsIdentity = usefulMetadata(extra) && (
        normalize(extra.mediaTitle) !== normalize(baseMeta.mediaTitle) ||
        normalize(extra.mediaArtist) !== normalize(baseMeta.mediaArtist) ||
        normalize(extra.album) !== normalize(baseMeta.album) ||
        normalize(extra.albumArtist) !== normalize(baseMeta.albumArtist)
    );
    if (!alreadyGood && enrichedAddsIdentity) {
        const deepEnriched = await deepOfficialCandidates(track, extra);
        merged = uniqueCandidates([...merged, ...deepEnriched]).sort(candidateSort);
    }
    return merged;
}

function getCachedArtwork(track) {
    const key = trackKey(track);
    const hit = cache.get(key);
    if (!hit) return null;
    const now = Date.now();
    if (hit.until <= now) {
        cache.delete(key);
        return null;
    }
    cache.delete(key);
    cache.set(key, hit);
    // Official artwork is safely reusable for the same normalized song identity.
    // Motion has its own shorter miss TTL: if a provider was temporarily unavailable,
    // retry motion in the background without throwing away the already-correct static art.
    if (hit.value?.official) {
        if (ANIMATED_ENABLED && getCachedMotion(track, hit.value) === null) {
            queueMicrotask(() => { void warmAnimatedArtwork(track, hit.value).catch(() => {}); });
        }
        return attachMotion(track, hit.value);
    }

    // Non-official artwork is only a temporary safety net. Keep showing the
    // current source fallback, but periodically launch a full official lookup in
    // the background so a transient Apple/Deezer/MusicBrainz outage cannot pin a
    // song to YouTube for the entire miss TTL.
    if (now >= Number(hit.retryAt || 0)) {
        hit.retryAt = now + MISS_BACKGROUND_RETRY_MS;
        queueMicrotask(() => { void warmArtwork(track, { forceRefresh: true }).catch(() => {}); });
    }
    return attachMotion(track, buildResult(track, []));
}

function setCachedArtwork(track, value) {
    const key = trackKey(track);
    cache.delete(key);
    const now = Date.now();
    const ttl = value?.official ? CACHE_TTL_MS : MISS_CACHE_TTL_MS;
    let until = now + ttl;
    for (const url of [value?.url, ...(value?.fallbacks || [])]) {
        const expiry = signedMediaExpiresAt(url);
        if (expiry) until = Math.min(until, expiry - 30000);
    }
    cache.set(key, { value, until, retryAt: value?.official ? 0 : now + MISS_BACKGROUND_RETRY_MS });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function sourceArtworkCandidate(track) {
    const provider = String(track?.linkedProvider || track?.provider || '').toLowerCase();
    const url = String(track?.linkedThumbnail || track?.thumbnail || '').trim();
    const hosts = {
        spotify: ['scdn.co'], tidal: ['tidal.com'], apple: ['mzstatic.com'],
        applemusic: ['mzstatic.com'], 'apple-music': ['mzstatic.com'],
        deezer: ['dzcdn.net'], soundcloud: ['sndcdn.com'],
    }[provider];
    if (!hosts || !url) return null;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) return null;
        if (!hosts.some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) return null;
    } catch (_) { return null; }
    const t = targetInfo(track);
    return {
        url, tier: 4, score: 1200, official: true, quality: 0, source: `${provider}-source`,
        title: t.title, artist: t.artist, collection: t.album,
        provenance: { provider, method: 'original-source-cover' },
    };
}

function buildResult(track, officialCandidates) {
    const official = uniqueCandidates(officialCandidates).sort(candidateSort).slice(0, MAX_OFFICIAL_CHAIN);
    const youtube = youtubeFallbacks(track).map((url, i) => ({
        url,
        score: 0,
        tier: 0,
        source: i === 0 ? 'youtube-maxres' : 'youtube-fallback',
        official: false,
        quality: i === 0 ? 1280 : i === 1 ? 1280 : i === 2 ? 640 : 480,
    }));
    const preferredSourceThumb = String(track?.linkedThumbnail || track?.thumbnail || '');
    const preferSourceArtwork = Boolean(
        track?.linkedProvider || (track?.provider && String(track.provider).toLowerCase() !== 'youtube')
    );
    const sourceCover = sourceArtworkCandidate(track);
    const existing = preferredSourceThumb && !/^(?:https?:\/\/)?(?:i\.ytimg\.com|img\.youtube\.com)\//i.test(preferredSourceThumb)
        ? [{ url: preferredSourceThumb, score: 0, tier: 0, source: track?.linkedProvider ? `${track.linkedProvider}-source` : 'source-existing', official: false, quality: 0 }]
        : [];

    // Every verified official/album source remains first. For a Spotify/TIDAL link
    // resolved to a playable YouTube match (or a direct SoundCloud item), preserve
    // the originating provider's artwork before generic YouTube thumbnails.
    const chain = uniqueCandidates(preferSourceArtwork
        ? [...(sourceCover ? [sourceCover] : []), ...official, ...existing, ...youtube]
        : [...official, ...existing, ...youtube]);
    const first = chain[0] || null;
    const alternatives = chain.slice(1);
    const lastResort = alternatives.filter(x => /^youtube-/i.test(x.source)).slice(0, 4);
    const coverAlternatives = alternatives.filter(x => !/^youtube-/i.test(x.source)).slice(0, 18 - lastResort.length);
    const result = {
        url: first?.url || '',
        source: first?.source || 'none',
        official: Boolean(first?.official),
        quality: Number(first?.quality || 0),
        matchTier: Number(first?.tier || 0),
        title: String(first?.title || ''),
        artist: String(first?.artist || ''),
        collection: String(first?.collection || ''),
        collectionId: Number(first?.collectionId || 0) || 0,
        provenance: first?.provenance || (first?.official ? { provider: String(first.source || '').split('-')[0], method: 'metadata-match' } : null),
        fallbacks: [...coverAlternatives, ...lastResort].map(x => x.url),
    };
    Object.defineProperty(result, '_motionHints', {
        value: official.filter(x => /^apple-/i.test(String(x.source || '')) && x.collectionId && motionCandidateFits(track, result, x))
            .slice(0, ANIMATED_MAX_CANDIDATES)
            .map(x => ({ ...x })),
        enumerable: false,
        configurable: false,
        writable: false,
    });
    return result;
}


async function imageUrlStatus(url) {
    const raw = String(url || '').trim();
    if (!/^https:\/\//i.test(raw)) return 'invalid';
    const headers = { 'User-Agent': 'MusicByA/6.4.1 artwork validator', Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' };
    let invalid = false;
    for (const method of ['HEAD', 'GET']) {
        try {
            const options = { method, redirect: 'follow', timeoutMs: Math.min(3600, PROVIDER_TIMEOUT_MS), headers: { ...headers } };
            if (method === 'GET') options.headers.Range = 'bytes=0-2047';
            const status = await httpRequest(raw, options, async response => {
                const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
                if ((response.ok || response.status === 206) && (!type || type.startsWith('image/'))) return 'verified';
                if ([400, 401, 403, 404, 410].includes(response.status) || (response.ok && type && !type.startsWith('image/'))) return 'invalid';
                return 'unavailable';
            });
            if (status === 'verified') return status;
            if (status === 'invalid') invalid = true;
        } catch (_) {
        }
    }
    return invalid ? 'invalid' : 'unavailable';
}

async function imageUrlReachable(url) {
    return (await imageUrlStatus(url)) === 'verified';
}

async function validateOfficialCandidates(candidates) {
    const official = uniqueCandidates(candidates).sort(candidateSort).slice(0, Math.max(MAX_OFFICIAL_CHAIN + 4, 12));
    if (!official.length || config.ARTWORK_VALIDATE_OFFICIAL === false) return official;
    const checks = await runTasks(official.map(item => async () => ({ item, validation: await imageUrlStatus(item.url) })), Math.min(12, HTTP_CONCURRENCY));
    const good = [];
    for (const r of checks) if (r?.status === 'fulfilled' && r.value?.validation !== 'invalid') good.push({ ...r.value.item, validation: r.value.validation });
    return good;
}

async function computeArtwork(track) {
    const discovered = await resolveOfficialCandidates(track);
    let official = await validateOfficialCandidates(discovered);
    if (discovered.length && !official.length) {
        // A strong metadata match with dead image URLs is still an artwork miss.
        // Keep searching albums and CAA rather than jumping directly to YouTube.
        const extra = await enrichYoutubeMetadata(track);
        official = await validateOfficialCandidates(await deepOfficialCandidates(track, extra));
    }
    return buildResult(track, official);
}

function warmArtwork(track, options = {}) {
    const snapshot = { ...track };
    const key = trackKey(snapshot);
    if (!key) return Promise.resolve({ url: '', source: 'none', official: false, quality: 0, matchTier: 0, fallbacks: [] });
    if (!options.forceRefresh) {
        const cached = getCachedArtwork(snapshot);
        if (cached) return Promise.resolve(cached);
    }
    if (inflight.has(key)) return inflight.get(key);
    const work = computeArtwork(snapshot)
        .then(result => {
            setCachedArtwork(snapshot, result);
            // Motion discovery never blocks static-art delivery or audio startup.
            // Once cached, /api/state automatically upgrades the main cover to video.
            void warmAnimatedArtwork(snapshot, result).catch(() => {});
            return attachMotion(snapshot, result);
        })
        .catch(() => {
            // Even if every official-art provider fails, preserve the originating
            // SoundCloud/Spotify/TIDAL artwork ordering instead of collapsing a
            // linked track back to a generic YouTube thumbnail.
            const fallback = buildResult(snapshot, []);
            setCachedArtwork(snapshot, fallback);
            void warmAnimatedArtwork(snapshot, fallback).catch(() => {});
            return attachMotion(snapshot, fallback);
        })
        .finally(() => inflight.delete(key));
    inflight.set(key, work);
    return work;
}

function peekArtwork(track) {
    const key = trackKey(track);
    const hit = cache.get(key);
    if (!hit || hit.until <= Date.now()) return null;
    // Pure cache read: collection/history serialization must not trigger hundreds
    // of provider requests. Current playback uses resolveArtworkSync(), which owns
    // the aggressive official-art warm-up/retry policy.
    if (hit.value?.official) return attachMotion(track, hit.value);
    return attachMotion(track, buildResult(track, []));
}

function resolveArtworkSync(track) {
    const hit = getCachedArtwork(track);
    if (hit) return hit;
    void warmArtwork(track);
    const provider = String(track?.provider || '').toLowerCase();
    if (track?.linkedProvider || (provider && provider !== 'youtube')) {
        // External providers already supplied a meaningful cover. Show it instantly
        // while the higher-confidence Apple/Deezer/MusicBrainz lookup warms in the
        // background; do not flash a blank cover on Web for SoundCloud/Spotify/TIDAL.
        return attachMotion(track, buildResult(track, []));
    }
    return {
        url: '',
        source: 'pending',
        official: false,
        quality: 0,
        matchTier: 0,
        fallbacks: [],
    };
}

module.exports = {
    identifyTrack: targetInfo,
    resolveArtworkSync,
    peekArtwork,
    warmArtwork,
    warmAnimatedArtwork,
    getCachedArtwork,
    getCachedMotion,
    computeArtwork,
    _test: {
        targetInfo,
        scoreCandidate,
        candidateMatch,
        albumMatch,
        versionCompatibility,
        highResItunes,
        youtubeFallbacks,
        buildQueryVariants,
        buildAlbumQueries,
        buildResult,
        metadataFromTrack,
        imageUrlReachable,
        splitArtistTitleArtwork,
        uploaderLooksLikeCurator,
        parseMotionMaster,
        motionUrlToMp4,
        motionSort,
        collectMotionUrls,
        dimensionsFromUrl,
        attachMotion,
        resolveAnimatedArtwork,
        appleMotionForCandidate,
        itunesSongCandidates,
        itunesAlbumCandidates,
        candidateSort,
    },
};
