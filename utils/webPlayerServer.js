'use strict';

const http = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');
const { currentClient, runWithClient } = require('./playerContext');
const https = require('node:https');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
const config = require('../config');
const favorites = require('./favoritesStore');
const history = require('./historyStore');
const lyricsProvider = require('./lyricsProvider');
const { recommendForUser } = require('./recommendations');
const catalog = require('./musicCatalog');
const playlists = require('./playlistsStore');
const { downloadAudio } = require('./audioDownload');
const performanceProfile = require('./performanceProfile');
const artworkResolver = require('./artworkResolver');
const { canonicalTrackKey } = require('./trackIdentity');
const { skipPlayback } = require('./skipControl');
const { fleetPlaybackTarget } = require('./fleetRouting');
const platformService = require('./platformService');
const platformSources = require('./platformSources');
const uploadsStore = require('./uploadsStore');
const { PlatformMedia, validatePublicUrl } = require('./platformMedia');
const { createPlatformHttp } = require('./platformHttp');

const ROOT = path.join(__dirname, '..');
const WEB_ROOT = path.join(ROOT, 'web');
const KEY_FILE = path.join(require('./dataPaths').dataDirectory(), '.web-player.key');
const MAX_BODY = 2 * 1024 * 1024;
const paletteCache = new Map();
const paletteInflight = new Map();
const lyricsCache = new Map();
const downloadJobs = new Map();
const downloadWrites = new Set();
let tlsState;
let server = null;
let runtime = null;
const requestContext = new AsyncLocalStorage();
function getRuntime() { return requestContext.getStore() || runtime; }
function runtimeForSession(session) {
    if (!runtime) throw Object.assign(new Error('Web service is unavailable.'), { status: 503 });
    if (!getRuntime().fleet) return runtime;
    const record = getRuntime().fleet.resolveSession(session);
    if (!record?.client || !record.player) throw Object.assign(new Error('Bot is unavailable.'), { status: 503 });
    let selected = getRuntime().targets.get(record.client);
    if (!selected) { selected = { ...runtime, client: record.client, player: record.player, actions: new Map(), baseRuntime: runtime }; getRuntime().targets.set(record.client, selected); }
    return selected;
}
function assertRuntimeTarget(selected, session, queue) {
    if (runtime !== (selected.baseRuntime || selected) || selected.player?.closed || selected.fleet?._closed
        || (selected.client?.player && selected.client.player !== selected.player)
        || (queue && (selected.player.getQueue(session.g) !== queue || queue._intentionalDestroy))) {
        throw Object.assign(new Error('Playback request was superseded by a newer player.'), { status: 409 });
    }
    if (typeof selected.fleet?.recordForClient === 'function') {
        const record = selected.fleet.recordForClient(selected.client);
        if (!record || record.player !== selected.player || ['restarting', 'failed', 'closed'].includes(record.status)) {
            throw Object.assign(new Error('Playback request was superseded by a bot restart.'), { status: 409 });
        }
    }
}
function assertVoiceAuthorization(selected, session, member, queue) {
    assertRuntimeTarget(selected, session, queue);
    const guild = selected.client.guilds.cache.get(session.g);
    const voiceId = liveVoiceId(guild, session.u, member);
    if (!voiceId || (queue?.currentTrack && !queue.voiceChannel?.id)
        || (queue?.voiceChannel?.id && queue.voiceChannel.id !== voiceId)
        || (selected.fleet && !fleetPlaybackTarget(selected.fleet, session.g, voiceId, selected.client, null, queue))) {
        throw Object.assign(new Error('Your voice room changed during this request.'), { status: 403 });
    }
}
function liveVoiceId(guild, userId, member) {
    const state = guild?.voiceStates?.cache?.get(userId);
    return state ? state.channelId : member?.voice?.channelId;
}

let secret = null;
let runtimePublicUrl = '';
let ready = false;
let startPromise = null;


function httpsOptions() {
    if (tlsState !== undefined) return tlsState;
    const keyPath = String(process.env.WEB_PLAYER_HTTPS_KEY_PATH || config.WEB_PLAYER_HTTPS_KEY_PATH || '').trim();
    const certPath = String(process.env.WEB_PLAYER_HTTPS_CERT_PATH || config.WEB_PLAYER_HTTPS_CERT_PATH || '').trim();
    if (!keyPath || !certPath) return (tlsState = null);
    try {
        const out = { key: fs.readFileSync(path.resolve(keyPath)), cert: fs.readFileSync(path.resolve(certPath)) };
        const caPath = String(process.env.WEB_PLAYER_HTTPS_CA_PATH || config.WEB_PLAYER_HTTPS_CA_PATH || '').trim();
        if (caPath) out.ca = fs.readFileSync(path.resolve(caPath));
        return (tlsState = out);
    } catch (err) {
        console.warn(`[WebPlayer] HTTPS disabled: ${err.message}`);
        return (tlsState = null);
    }
}

function secureHeaders(res, secure = false) {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function trustProxyEnabled() {
    const env = String(process.env.WEB_PLAYER_TRUST_PROXY || '').trim().toLowerCase();
    if (env) return ['1', 'true', 'yes', 'on'].includes(env);
    return config.WEB_PLAYER_TRUST_PROXY === true;
}

function requestIsSecure(req) {
    if (req?.socket?.encrypted) return true;
    if (trustProxyEnabled()) {
        const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
        if (proto === 'https') return true;
    }
    return false;
}

function responseIsSecure(res) {
    return Boolean(res.__musicSecure ?? res.socket?.encrypted);
}

function configuredPublicUrl() {
    return String(process.env.WEB_PLAYER_PUBLIC_URL || config.WEB_PLAYER_PUBLIC_URL || '').trim().replace(/\/$/, '');
}

function setRuntimePublicUrl(value) {
    const next = String(value || '').trim().replace(/\/$/, '');
    if (next && !/^https:\/\//i.test(next)) throw new Error('Runtime public Web Player URL must use HTTPS');
    runtimePublicUrl = next;
    return runtimePublicUrl;
}

function effectivePublicUrl() {
    return runtimePublicUrl || configuredPublicUrl();
}

function cleanupDownloadJob(id, job = downloadJobs.get(id)) {
    if (!job) return false;
    if (downloadJobs.get(id) === job) downloadJobs.delete(id);
    if (job.expiryTimer) clearTimeout(job.expiryTimer);
    job.cleanup?.().catch?.(() => {});
    return true;
}

function cleanupDownloadJobs() {
    const now = Date.now();
    for (const [id, job] of downloadJobs) {
        if (!job || job.expiresAt <= now) cleanupDownloadJob(id, job);
    }
}

function b64url(input) { return Buffer.from(input).toString('base64url'); }
function unb64url(input) { return Buffer.from(String(input), 'base64url').toString('utf8'); }

function loadSecret() {
    if (secret) return secret;
    const configured = String(config.WEB_PLAYER_SECRET || '').trim();
    if (configured.length >= 24) return (secret = Buffer.from(configured));
    try {
        const existing = fs.readFileSync(KEY_FILE);
        if (existing.length >= 32) return (secret = existing);
    } catch (_) {}
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    secret = crypto.randomBytes(48);
    fs.writeFileSync(KEY_FILE, secret, { mode: 0o600 });
    return secret;
}

function sign(payload) {
    return crypto.createHmac('sha256', loadSecret()).update(payload).digest('base64url');
}

function createToken(userId, guildId, view = 'player', botKey = currentClient()?.botKey || '') {
    const ttl = Math.max(5 * 60_000, Number(config.WEB_PLAYER_SESSION_TTL_MS || 12 * 60 * 60_000));
    const body = b64url(JSON.stringify({ u: String(userId), g: String(guildId), v: String(view), b: String(botKey || ''), e: Date.now() + ttl, n: crypto.randomBytes(8).toString('hex') }));
    return `${body}.${sign(body)}`;
}

function verifyToken(token) {
    const [body, signature] = String(token || '').split('.');
    if (!body || !signature) throw new Error('invalid session');
    const expected = sign(body);
    const a = Buffer.from(signature); const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('invalid session');
    const data = JSON.parse(unb64url(body));
    if (!/^\d{5,32}$/.test(String(data.u || '')) || !/^\d{5,32}$/.test(String(data.g || '')) || Number(data.e || 0) < Date.now()) throw new Error('expired session');
    return data;
}

function firstReachableLanAddress() {
    try {
        const all = os.networkInterfaces();
        const candidates = [];
        for (const entries of Object.values(all)) {
            for (const entry of entries || []) {
                const family = typeof entry.family === 'string' ? entry.family : (entry.family === 4 ? 'IPv4' : '');
                if (family !== 'IPv4' || entry.internal || !entry.address || /^169\.254\./.test(entry.address)) continue;
                const address = String(entry.address);
                const privateRank = /^192\.168\./.test(address) ? 0 : /^10\./.test(address) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 2 : 3;
                candidates.push({ address, privateRank });
            }
        }
        candidates.sort((a, b) => a.privateRank - b.privateRank);
        return candidates[0]?.address || '';
    } catch (_) {
        return '';
    }
}

function publicBaseUrl() {
    const configured = effectivePublicUrl();
    if (configured) return configured;
    const port = Number(process.env.WEB_PLAYER_PORT || config.WEB_PLAYER_PORT || 3780);
    const protocol = httpsOptions() ? 'https' : 'http';
    const bindHost = String(process.env.WEB_PLAYER_HOST || config.WEB_PLAYER_HOST || '0.0.0.0').trim();
    if (bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '') {
        const lan = firstReachableLanAddress();
        if (lan) return `${protocol}://${lan}:${port}`;
        return `${protocol}://127.0.0.1:${port}`;
    }
    const printableHost = bindHost.includes(':') && !bindHost.startsWith('[') ? `[${bindHost}]` : bindHost;
    return `${protocol}://${printableHost}:${port}`;
}

function createSessionUrl(userId, guildId, view = 'player', botKey = currentClient()?.botKey || '') {
    if (!ready) throw new Error('Web Player is still starting');
    const base = publicBaseUrl();
    const requireGlobal = String(process.env.WEB_PLAYER_REQUIRE_GLOBAL_HTTPS || '').trim().toLowerCase();
    const mustBeGlobal = requireGlobal ? ['1', 'true', 'yes', 'on'].includes(requireGlobal) : config.WEB_PLAYER_REQUIRE_GLOBAL_HTTPS !== false;
    if (mustBeGlobal && !/^https:\/\//i.test(base)) throw new Error('Web Player global HTTPS is not ready');
    return `${base}/player?token=${encodeURIComponent(createToken(userId, guildId, view, botKey))}&view=${encodeURIComponent(view)}`;
}

function json(res, status, value) {
    const body = JSON.stringify(value);
    secureHeaders(res, responseIsSecure(res));
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
    secureHeaders(res, responseIsSecure(res));
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
}

function isPrivateHost(host) {
    const h = String(host || '').toLowerCase();
    return h === 'localhost' || h === '::1' || h === '0.0.0.0' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

function clampByte(n) { return Math.max(0, Math.min(255, Math.round(n))); }
function rgbHex(c) { return `#${[c.r,c.g,c.b].map(x => clampByte(x).toString(16).padStart(2, '0')).join('')}`; }
function mixRgb(c, factor, lift = 0) { return { r: c.r * factor + lift, g: c.g * factor + lift, b: c.b * factor + lift }; }
function rgbDistance(a, b) { return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b); }

function extractArtworkColors(data, channels = 3) {
    const bins = new Map();
    for (let i = 0; i + 2 < data.length; i += channels) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const light = (max + min) / 510;
        const sat = max === 0 ? 0 : (max - min) / max;
        // Ignore nearly black/white pixels that would wash out the animated field.
        if (light < .035 || light > .965) continue;
        const key = `${r >> 4}|${g >> 4}|${b >> 4}`;
        const hit = bins.get(key) || { count: 0, r: 0, g: 0, b: 0, score: 0 };
        hit.count++; hit.r += r; hit.g += g; hit.b += b;
        hit.score += .45 + sat * 1.7 + Math.min(.65, light);
        bins.set(key, hit);
    }
    const candidates = [...bins.values()].map(x => ({
        r: x.r / x.count, g: x.g / x.count, b: x.b / x.count,
        weight: x.count * (x.score / x.count),
    })).sort((a, b) => b.weight - a.weight);
    const picked = [];
    for (const c of candidates) {
        if (picked.every(p => rgbDistance(p, c) >= 72)) picked.push(c);
        if (picked.length >= 6) break;
    }
    for (const c of candidates) {
        if (picked.length >= 6) break;
        if (!picked.includes(c)) picked.push(c);
    }
    while (picked.length < 6) picked.push(picked[picked.length - 1] || { r: 72, g: 82, b: 105 });
    return picked;
}

async function artworkPalette(url) {
    const key = String(url || '');
    if (!key) return ['#151923', '#29303f', '#667085', '#0a0c10', '#1b202b', '#3f526b'];
    const cached = paletteCache.get(key);
    if (cached && cached.until > Date.now()) return cached.value;
    try {
        const parsed = new URL(key);
        if (!['http:', 'https:'].includes(parsed.protocol) || isPrivateHost(parsed.hostname)) throw new Error('blocked artwork host');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000); timeout.unref?.();
        let raw;
        try {
            const opened = await require('./publicMedia').openPublicMedia(parsed.href, { signal: controller.signal });
            let size = 0; const chunks = [];
            for await (const chunk of opened.response) { size += chunk.length; if (size > 16 * 1024 * 1024) { opened.cleanup(); throw new Error('artwork too large'); } chunks.push(chunk); }
            raw = Buffer.concat(chunks);
        } finally { clearTimeout(timeout); }
        const sharp = require('sharp');
        performanceProfile.configureSharp(sharp);
        const sample = await sharp(raw, { failOn: 'none' }).resize(64, 64, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const colors = extractArtworkColors(sample.data, sample.info.channels || 3);
        // Use real, distinct cover colors but darken them into a TIDAL-style
        // animated ambient field. The cover itself is never used as a background.
        const value = [
            rgbHex(mixRgb(colors[0], .56, 5)),
            rgbHex(mixRgb(colors[1], .78, 12)),
            rgbHex(mixRgb(colors[2], .86, 15)),
            rgbHex(mixRgb(colors[3], .22, 1)),
            rgbHex(mixRgb(colors[4] || colors[1], .64, 8)),
            rgbHex(mixRgb(colors[5] || colors[2], .72, 10)),
        ];
        paletteCache.set(key, { value, until: Date.now() + 30 * 60_000 });
        while (paletteCache.size > 300) paletteCache.delete(paletteCache.keys().next().value);
        return value;
    } catch (_) {
        const fallback = ['#151923', '#29303f', '#667085', '#0a0c10', '#1b202b', '#3f526b'];
        paletteCache.set(key, { value: fallback, until: Date.now() + 5 * 60_000 });
        return fallback;
    }
}

function paletteForState(url) {
    const key = String(url || '');
    const cached = paletteCache.get(key);
    if (cached?.until > Date.now()) return cached.value;
    if (!paletteInflight.has(key)) {
        const work = artworkPalette(key).finally(() => paletteInflight.delete(key));
        paletteInflight.set(key, work);
    }
    return ['#151923', '#29303f', '#667085', '#0a0c10', '#1b202b', '#3f526b'];
}

function publicTrack(track, options = {}) {
    if (!track) return null;
    const resolveArtwork = options.resolveArtwork !== false;
    const artwork = track.source === 'upload' || track.provider === 'local-upload'
        ? { url: track.thumbnail || '', source: 'embedded-upload', official: false, fallbacks: [] }
        : resolveArtwork
        ? artworkResolver.resolveArtworkSync(track)
        : (artworkResolver.peekArtwork?.(track) || { url: String(track.thumbnail || ''), source: 'stored', official: false, fallbacks: [] });
    const artworkPending = artwork?.source === 'pending';
    const motion = artwork?.animated || {};
    const candidates = Array.isArray(motion.sources) && motion.sources.length ? motion.sources
        : [{ ...motion, url: motion.url }, ...(motion.fallbackSources || []), ...(motion.fallbacks || []).map(url => ({ url }))];
    const animatedArtworkSources = [];
    const seen = new Set();
    for (const candidate of candidates) {
        if (!candidate?.url || seen.has(candidate.url)) continue;
        seen.add(candidate.url);
        const url = options.session && getRuntime()?.media?.issueMotion(candidate.url, options.session);
        if (!url) continue;
        const format = candidate.format || (/\.m3u8(?:$|\?)/i.test(candidate.url) ? 'hls' : 'mp4');
        animatedArtworkSources.push({ url, format, mime: candidate.mime || (format === 'hls' ? 'application/vnd.apple.mpegurl' : 'video/mp4'),
            codecs: String(candidate.codecs || ''), width: Number(candidate.width || motion.width || 0), height: Number(candidate.height || motion.height || 0), bitrate: Number(candidate.bitrate || motion.bitrate || 0) });
    }
    return {
        kind: track.kind || 'track', id: String(track.id || ''), provider: String(track.provider || ''), source: String(track.source || ''),
        providerUrl: String(track.providerUrl || ''), metadataOnly: Boolean(track.metadataOnly),
        album: String(track.album || ''), albumId: String(track.albumId || ''),
        releaseId: String(track.releaseId || ''), releaseGroupId: String(track.releaseGroupId || ''),
        artistId: String(track.artistId || ''), albumArtist: String(track.albumArtist || ''),
        genres: Array.isArray(track.genres) ? track.genres : [], releaseDate: String(track.releaseDate || ''), explicit: track.explicit,
        linkedProvider: String(track.linkedProvider || ''), linkedOriginalUrl: String(track.linkedOriginalUrl || ''),
        linkedResolvedUrl: String(track.linkedResolvedUrl || ''), linkedThumbnail: String(track.linkedThumbnail || ''), linkedTitle: String(track.linkedTitle || ''),
        mediaTitle: String(track.mediaTitle || ''), mediaArtist: String(track.mediaArtist || ''),
        title: String(track.title || 'Unknown').slice(0, 220),
        author: String(track.author || 'Unknown').slice(0, 160),
        url: String(track.url || '').slice(0, 1000),
        // Do not flash the YouTube thumbnail while official providers are still
        // resolving. YouTube is exposed only by artworkResolver after the full
        // official/album chain has failed.
        thumbnail: artworkPending ? '' : String(artwork?.url || track.thumbnail || '').slice(0, 1000),
        artworkFallbacks: Array.isArray(artwork?.fallbacks)
            ? artwork.fallbacks.slice(0, 18).map(x => String(x || '').slice(0, 1000)).filter(Boolean)
            : [],
        duration: Math.max(0, Number(track.duration || 0) || 0),
        artworkSource: String(artwork?.source || ''),
        officialArtwork: Boolean(artwork?.official),
        artworkQuality: Math.max(0, Number(artwork?.quality || 0)),
        artworkMatchTier: Math.max(0, Number(artwork?.matchTier || 0)),
        animatedArtwork: animatedArtworkSources[0]?.url || '',
        animatedArtworkFallbacks: animatedArtworkSources.slice(1).map(x => x.url),
        animatedArtworkSources,
        animatedArtworkSource: String(artwork?.animated?.source || ''),
        animatedArtworkWidth: Math.max(0, Number(artwork?.animated?.width || 0)),
        animatedArtworkHeight: Math.max(0, Number(artwork?.animated?.height || 0)),
        animatedArtworkBitrate: Math.max(0, Number(artwork?.animated?.bitrate || 0)),
    };
}

async function stateFor(session) {
    const selected = getRuntime();
    const [historyCount, favoriteCount] = await Promise.all([
        selected.history.count(session.u),
        typeof selected.favorites.countAsync === 'function' ? selected.favorites.countAsync(session.u) : selected.favorites.count(session.u),
    ]);
    const player = getRuntime().player;
    const queue = player.getQueue(session.g);
    const track = queue?.currentTrack || null;
    const publicCurrentTrack = publicTrack(track, { session });
    const palette = paletteForState(publicCurrentTrack?.thumbnail || '');
    return {
        serverNow: Date.now(),
        guildId: session.g,
        userId: session.u,
        botKey: getRuntime().client.botKey || session.b || '',
        botId: getRuntime().client.user?.id || '',
        botName: getRuntime().client.user?.username || '',
        voiceChannelId: queue?.voiceChannel?.id || '',
        voiceChannelName: queue?.voiceChannel?.name || '',
        track: publicCurrentTrack,
        paused: Boolean(queue?.paused),
        playing: Boolean(queue?.playing),
        elapsed: queue?.getElapsedPrecise?.() || 0,
        // New play/seek/recovery resources get a new token. The browser uses it
        // to avoid smoothing a fresh playback clock against a superseded one.
        playToken: Number(queue?._playToken || 0),
        startTime: Number(queue?.startTime || 0),
        pausedAt: Number(queue?.pausedAt || 0),
        volume: Number(queue?.volume || config.DEFAULT_VOLUME || 100),
        loop: Boolean(queue?.loop), loopQueue: Boolean(queue?.loopQueue), shuffle: Boolean(queue?.shuffle),
        index: Number(queue?.currentIndex || 0),
        queueLength: Number(queue?.tracks?.length || 0),
        queueRevision: Number(queue?._queueRevision || 0),
        palette,
        lyricsAdvanceMs: Number(config.WEB_LYRICS_SYNC_OFFSET_MS || 0),
        seekSeconds: Number(config.SEEK_SECONDS || 20),
        favorited: Boolean(track && await (typeof selected.favorites.hasAsync === 'function' ? selected.favorites.hasAsync(session.u, track) : selected.favorites.has(session.u, track))),
        counts: { favorites: favoriteCount, history: historyCount },
    };
}

function webTrackKey(track) {
    if (!track) return '';
    return `${String(track.url || '')}|${String(track.title || '')}`;
}

function lyricsCacheKey(track) {
    if (!track) return '';
    return `${String(track.url || '')}|${String(track.title || '')}|${String(track.author || '')}|${Math.round(Number(track.duration || 0))}`;
}

async function currentLyrics(session, expectedTrackKey = '', forceRefresh = false) {
    const queue = getRuntime().player.getQueue(session.g);
    const track = queue?.currentTrack;
    if (!track) return { trackKey: '', syncedLines: [], plainLyrics: '', title: '', artist: '' };
    const initialTrackKey = webTrackKey(track);
    if (expectedTrackKey && expectedTrackKey !== initialTrackKey) throw new Error('track changed');
    const key = lyricsCacheKey(track);
    const hit = lyricsCache.get(key);
    if (hit && hit.until > Date.now()) {
        const hasSyncedLyrics = Boolean((hit.value?.syncedLines || []).length) && !hit.value?.approximateSync && !hit.value?.estimatedSync && !hit.value?.needsUpgrade;
        // Normal polling reuses every cached result. A scheduled/explicit refresh
        // may bypass empty or plain-only results to look for synchronized timings;
        // once synced lyrics exist we keep them hot for the session.
        if (hasSyncedLyrics || !forceRefresh) return { ...hit.value, trackKey: initialTrackKey };
        lyricsCache.delete(key);
    }
    const preferredLanguage = lyricsProvider.guessLyricsLanguage?.(track.title, track.author) || undefined;
    const found = await lyricsProvider.findLyrics(track, { language: preferredLanguage, forceRefresh });

    // The lyrics request can be much slower than a track skip. Never return lyrics
    // for the old track after the queue has already advanced to the next one.
    const currentAfter = getRuntime().player.getQueue(session.g)?.currentTrack;
    if (!currentAfter || webTrackKey(currentAfter) !== initialTrackKey) throw new Error('track changed');

    const value = publicLyrics(found, track);
    const hasLyrics = Boolean(value.plainLyrics || value.syncedLines.length);
    // Successful lyrics can stay hot for a long session. Empty/transient misses
    // get a short TTL so a provider/network hiccup does not hide lyrics for 20 min.
    lyricsCache.set(key, { value, until: Date.now() + (hasLyrics ? 20 * 60_000 : 15_000) });
    while (lyricsCache.size > 100) lyricsCache.delete(lyricsCache.keys().next().value);
    return { ...value, trackKey: initialTrackKey };
}

function publicLyrics(found, track) {
    return {
        title: String(found?.title || track.title || '').slice(0, 220),
        artist: String(found?.artist || track.author || '').slice(0, 160),
        source: String(found?.source || ''),
        syncedLines: lyricLines(found?.syncedLines),
        plainLyrics: String(found?.plainLyrics || '').slice(0, 50_000),
        approximateSync: Boolean(found?.approximateSync || found?.estimatedSync),
        estimatedSync: Boolean(found?.estimatedSync),
        timingMode: String(found?.timingMode || (found?.estimatedSync ? 'estimated' : found?.approximateSync ? 'adaptive' : found?.syncedLines?.length ? 'synced' : 'plain')),
        romanized: Boolean(found?.romanized), language: String(found?.language || ''),
        nativePlainLyrics: String(found?.nativePlainLyrics || '').slice(0, 50_000),
        nativeSyncedLines: lyricLines(found?.nativeSyncedLines),
        offsetMs: Number(found?.offsetMs || 0), alignmentOffsetMs: Number(found?.alignmentOffsetMs || 0),
        timingSource: String(found?.timingSource || ''), timingCalibrated: Boolean(found?.timingCalibrated), timingOffsetMs: Number(found?.timingOffsetMs || 0),
        romanizationStatus: String(found?.romanizationStatus || ''), romanizationMethod: String(found?.romanizationMethod || ''), romanizationSource: String(found?.romanizationSource || ''),
        needsUpgrade: Boolean(found?.needsUpgrade),
    };
}

function lyricLines(lines) {
    return Array.isArray(lines) ? lines.slice(0, 3000).map(x => ({ time: Number(x.time ?? x.start ?? 0), text: String(x.text ?? x.line ?? '').slice(0, 500), ...(Number.isFinite(Number(x.endTime)) && x.endTime != null ? { endTime: Number(x.endTime) } : {}) })) : [];
}

async function collectionFor(session, kind) {
    if (kind === 'queue') return getRuntime().player.getQueue(session.g)?.tracks || [];
    if (kind === 'favorites') return getRuntime().favorites.list(session.u);
    if (kind === 'history') return getRuntime().history.list(session.u);
    if (kind === 'discover') {
        const recent = await getRuntime().history.list(session.u);
        const saved = getRuntime().favorites.list(session.u);
        const seen = new Set(recent.map(t => t.url));
        const seeds = [...recent, ...saved.filter(t => !seen.has(t.url))];
        return recommendForUser(session.u, seeds);
    }
    if (/^playlist:[a-f\d-]{36}$/i.test(String(kind))) {
        const list = await getRuntime().playlists.get(session.u, kind.slice(9));
        if (!list) throw new Error('Playlist not found.');
        return list.tracks;
    }
    throw new Error('unknown collection');
}

async function memberAndQueue(session) {
    const selected = getRuntime();
    assertRuntimeTarget(selected, session);
    const guild = selected.client.guilds.cache.get(session.g);
    if (!guild) throw new Error('Guild is unavailable.');
    const member = guild.members.cache.get(session.u) || await guild.members.fetch(session.u);
    assertRuntimeTarget(selected, session);
    const voiceId = liveVoiceId(guild, session.u, member);
    if (!member?.voice?.channel || !voiceId) throw Object.assign(new Error('Join a voice channel first.'), { status: 403 });
    let pinnedText = null;
    if (selected.fleet) {
        const target = fleetPlaybackTarget(selected.fleet, session.g, voiceId, selected.client, null, null);
        if (!target) throw Object.assign(new Error('Join the assigned voice room for this player.'), { status: 403 });
        pinnedText = guild.channels.cache.get(target.pin.textChannelId)
            || await guild.channels.fetch(target.pin.textChannelId).catch(() => null);
        if (!pinnedText?.isTextBased?.()) throw Object.assign(new Error('The assigned music text channel is unavailable.'), { status: 403 });
    }
    let queue = getRuntime().player.getQueue(session.g);
    if ((queue?.currentTrack && !queue.voiceChannel?.id)
        || (queue?.voiceChannel?.id && queue.voiceChannel.id !== voiceId)) {
        throw Object.assign(new Error('Join the same voice channel as the player.'), { status: 403 });
    }
    if (queue && pinnedText && queue.textChannel?.id !== pinnedText.id) queue.textChannel = pinnedText;
    if (!queue || !queue.connection || queue.connection.state?.status === 'destroyed') {
        const channel = pinnedText || queue?.textChannel || guild.systemChannel || guild.channels.cache.find(c => c.isTextBased?.());
        queue = await getRuntime().player.join(member.voice.channel, channel);
        assertVoiceAuthorization(selected, session, member, queue);
        getRuntime().client.queues.set(session.g, queue);
    }
    assertVoiceAuthorization(selected, session, member, queue);
    return { member, queue };
}

function trackForUser(track, member) {
    return { ...track, requester: member.user.tag || member.user.username, requesterId: member.id };
}

async function action(session, body) {
    const player = getRuntime().player;
    const name = String(body.action || '');
    let authorizedMember;
    const actionRuntime = getRuntime();
    const mutation = ['pause','previous','next','rewind','forward','seekTo','jumpQueue','removeQueue','clear','stop','playTrack','queueTrack','playTracks','queueTracks','playCollection','queueCollection'].includes(name);
    // Reserve arrival order separately: a rejected authorization must not
    // cancel an already accepted request in the same voice room.
    const issued = actionRuntime.issuedActions ||= new Map();
    const actionId = mutation ? (issued.get(session.g) || actionRuntime.actions.get(session.g) || 0) + 1 : 0;
    if (mutation) issued.set(session.g, actionId);
    // Every Web Player action needs a live voice check, including single-bot
    // mode. A signed session is not proof that its owner is still in the room.
    authorizedMember = (await memberAndQueue(session)).member;
    if (mutation) {
        if ((actionRuntime.actions.get(session.g) || 0) > actionId) throw Object.assign(new Error('Playback request was superseded by a newer action.'), { status: 409 });
        actionRuntime.actions.set(session.g, actionId);
    }
    const guard = (q, token) => {
        assertRuntimeTarget(actionRuntime, session, q);
        if (authorizedMember) assertVoiceAuthorization(actionRuntime, session, authorizedMember, q);
        if (getRuntime() !== actionRuntime || runtime !== (actionRuntime.baseRuntime || actionRuntime) || (mutation && actionRuntime.actions.get(session.g) !== actionId) || (token != null && Number(q?._playRequestToken || 0) !== token)) throw Object.assign(new Error('Playback request was superseded by a newer action.'), { status: 409 });
    };
    const playbackFailure = () => Object.assign(new Error('تعذر تشغيل هذه الأغنية. جرّب رابطًا أو مصدرًا آخر.'), { status: 502, code: 'PLAYBACK_FAILED' });
    const guardedPlay = async (q, track, position) => {
        const pending = player.play(q, track, position), token = Number(q._playRequestToken || 0);
        const started = await pending;
        guard(q, token);
        if (q.currentTrack !== track) throw Object.assign(new Error('Playback request was superseded by a newer action.'), { status: 409 });
        return started;
    };
    let queue = player.getQueue(session.g);
    const publicMessage = queue?.nowPlayingMessage;
    guard(queue);
    if (['pause','previous','next','rewind','forward','seekTo','volume','loop','shuffle','clear','favorite','jumpQueue','removeQueue'].includes(name) && !queue?.currentTrack) throw new Error('Nothing is playing.');
    if (name === 'pause') {
        queue._autoPausedOnEmpty = false;
        if (queue.paused) { queue.player?.unpause(); queue.paused = false; queue.startTime = Date.now() - ((queue.pausedAt || Date.now()) - queue.startTime); queue.pausedAt = 0; }
        else { queue.player?.pause(); queue.paused = true; queue.pausedAt = Date.now(); }
    } else if (name === 'previous') {
        if (queue.currentIndex <= 0) throw new Error('No previous track.');
        const previousIndex = queue.currentIndex;
        queue.currentIndex--;
        if (!await guardedPlay(queue, queue.currentTrack, 0)) {
            guard(queue);
            queue.currentIndex = previousIndex;
            throw playbackFailure();
        }
    } else if (name === 'next') {
        const pending = skipPlayback(queue, player, actionRuntime.client, session.g), token = Number(queue._playRequestToken || 0);
        const outcome = await pending;
        guard(queue, token);
        if (outcome.unavailable) throw playbackFailure();
    } else if (name === 'rewind' || name === 'forward') {
        const now = queue.getElapsedPrecise?.() || 0; const delta = Number(config.SEEK_SECONDS || 20) * (name === 'rewind' ? -1 : 1);
        const duration = Number(queue.currentTrack.duration || 0); let target = Math.max(0, now + delta); if (duration > 0) target = Math.min(target, Math.max(0, duration - 1));
        if (!await guardedPlay(queue, queue.currentTrack, target)) throw playbackFailure();
    } else if (name === 'seekTo') {
        const duration = Number(queue.currentTrack.duration || 0);
        if (!(duration > 0)) throw new Error('This track cannot be seeked.');
        const requested = Number(body.value);
        if (!Number.isFinite(requested)) throw new Error('Invalid seek position.');
        const target = Math.max(0, Math.min(requested, Math.max(0, duration - 0.25)));
        if (!await guardedPlay(queue, queue.currentTrack, target)) throw playbackFailure();
    } else if (name === 'volume') {
        queue.volume = Math.max(1, Math.min(Number(config.MAX_VOLUME || 150), Number(body.value || queue.volume || 100))); await player.applyVolume(queue);
    } else if (name === 'loop') {
        if (!queue.loop && !queue.loopQueue) { queue.loop = true; queue.loopQueue = false; } else if (queue.loop) { queue.loop = false; queue.loopQueue = true; } else { queue.loop = false; queue.loopQueue = false; }
    } else if (name === 'shuffle') { player.shuffleUpcoming(queue); }
    else if (name === 'jumpQueue') {
        const index = Number(body.index);
        if (!Number.isInteger(index) || index < 0 || index >= queue.tracks.length) throw new Error('Queue track not found.');
        const previous = queue.currentIndex;
        queue.currentIndex = index;
        if (!await guardedPlay(queue, queue.currentTrack, 0)) { guard(queue); queue.currentIndex = previous; throw playbackFailure(); }
    } else if (name === 'removeQueue') {
        const result = player.removeTrack(queue, Number(body.index) + 1);
        if (!result || result.current) throw new Error('Cannot remove the active track.');
    }
    else if (name === 'clear') { player.clearUpcoming(queue); }
    else if (name === 'stop') { player.stopPlayback(queue, true); }
    else if (name === 'favorite') {
        const guild = getRuntime().client.guilds.cache.get(session.g);
        const member = guild?.members.cache.get(session.u) || await guild?.members.fetch(session.u);
        const list = getRuntime().favorites.list(session.u);
        const currentKey = canonicalTrackKey(queue.currentTrack);
        const index = list.findIndex(item => canonicalTrackKey(item) === currentKey);
        if (index >= 0) getRuntime().favorites.remove(member?.user || session.u, index);
        else getRuntime().favorites.add(member?.user || { id: session.u, username: 'Web Player' }, queue.currentTrack);
        getRuntime().favorites.saveNow?.(session.u);
    } else if (name === 'playTrack' || name === 'queueTrack' || name === 'playTracks' || name === 'queueTracks') {
        const input = body.track || {};
        const inputs = name.endsWith('Tracks') ? (Array.isArray(body.tracks) ? body.tracks.slice(0, 2000) : []) : [input];
        if (!inputs.length) throw new Error('No songs selected.');
        const resolved = inputs.map(t => ({ ...getRuntime().sources.sanitize(t), _platformUnresolved: true }));
        if (resolved.some(t => !t.url && (!t.title || !t.author))) throw new Error('A track URL or title and artist are required.');
        const { member, queue: q } = await memberAndQueue(session); queue = q;
        guard(queue);
        const sourceToken = Number(queue._playRequestToken || 0);
        const active = player.hasActivePlayback(queue);
        const force = name.startsWith('play');
        // Resolve only the first source before changing the active queue. Future
        // catalog tracks are resolved by MusicPlayer when they become current.
        if (!active || force) resolved[0] = { ...await getRuntime().sources.resolve(resolved[0], session.u), _platformUnresolved: false };
        guard(queue, sourceToken);
        if (force) player.stopPlayback(queue, true, { preserveNowPlayingMessage: true });
        if (!active || force) { queue.tracks = []; queue.currentIndex = 0; }
        const { added } = player.addTracks(queue, resolved.map(t => trackForUser(t, member)));
        if (!added.length) throw new Error('Queue is full.');
        if (!active || force) {
            queue.currentIndex = 0;
            if (!await guardedPlay(queue, added[0], 0)) throw playbackFailure();
        }
    } else if (name === 'playCollection' || name === 'queueCollection') {
        const kind = String(body.kind || ''); const list = await collectionFor(session, kind); const indexes = Array.isArray(body.indexes) ? body.indexes.map(Number).filter(Number.isInteger) : [Number(body.index)].filter(Number.isInteger);
        guard(queue);
        const selected = indexes.map(i => list[i]).filter(Boolean).slice(0, 2000); if (!selected.length) throw new Error('Select at least one track.');
        const { member, queue: q } = await memberAndQueue(session); queue = q;
        guard(queue);
        const sourceToken = Number(queue._playRequestToken || 0);
        const tracks = selected.map(t => trackForUser({ ...getRuntime().sources.sanitize(t), _platformUnresolved: true }, member)); const force = name === 'playCollection'; const active = player.hasActivePlayback(queue);
        if (!active || force) tracks[0] = trackForUser({ ...await getRuntime().sources.resolve(tracks[0], session.u), _platformUnresolved: false }, member);
        guard(queue, sourceToken);
        if (force) player.stopPlayback(queue, true, { preserveNowPlayingMessage: true }); if (!active || force) { queue.tracks = []; queue.currentIndex = 0; }
        const { added } = player.addTracks(queue, tracks); if (!added.length) throw new Error('Queue is full.');
        if (!active || force) { queue.currentIndex = 0; if (!await guardedPlay(queue, added[0], 0)) throw playbackFailure(); }
    } else throw new Error('Unknown action.');
    guard(queue);
    if (!queue?.nowPlayingMessage && publicMessage && queue?.currentTrack && player.hasActivePlayback(queue)) {
        queue.nowPlayingMessage = publicMessage;
    }
    if (name === 'stop' && publicMessage) {
        const { createSuccessEmbed } = require('./embed');
        player.editNowPlayingMessage(queue, { embeds: [createSuccessEmbed('Music stopped', 'The song and queue were cleared.')], components: [], attachments: [] }, { message: publicMessage, allowStale: true }).catch(() => {});
    } else if (queue?.currentTrack && queue.nowPlayingMessage && queue._playerVisualTrackUrl !== queue.currentTrack.url) {
        player.syncNowPlayingMessage(queue, queue.currentTrack).catch(() => {});
    } else player.refreshNowPlayingMessage?.(queue, true).catch?.(() => {});
    return stateFor(session);
}

async function editLibrary(session, body) {
    const operation = String(body.operation || '');
    const index = Number(body.index);
    if (operation === 'removeFavorite') {
        if (!getRuntime().favorites.remove(session.u, index)) throw new Error('Favorite not found.');
        getRuntime().favorites.saveNow(session.u);
    } else if (operation === 'addFavorite') {
        const track = await getRuntime().sources.resolve(body.track || {}, session.u);
        getRuntime().favorites.add({ id: session.u, username: 'Web Player' }, track);
        getRuntime().favorites.saveNow(session.u);
    } else if (operation === 'removeHistory') await getRuntime().history.remove(session.u, index);
    else if (operation === 'clearHistory') await getRuntime().history.clear(session.u);
    else if (operation === 'createPlaylist') await getRuntime().playlists.create(session.u, body.name);
    else if (operation === 'renamePlaylist') await getRuntime().playlists.rename(session.u, body.id, body.name);
    else if (operation === 'deletePlaylist') await getRuntime().playlists.delete(session.u, body.id);
    else if (operation === 'addToPlaylist') {
        const track = await getRuntime().sources.resolve(body.track || {}, session.u);
        await getRuntime().playlists.add(session.u, body.id, track);
    } else if (operation === 'removeFromPlaylist') await getRuntime().playlists.remove(session.u, body.id, index);
    else throw new Error('Unknown library action.');
    return { ok: true, playlists: await getRuntime().playlists.list(session.u),
        counts: { favorites: await (typeof getRuntime().favorites.countAsync === 'function' ? getRuntime().favorites.countAsync(session.u) : getRuntime().favorites.count(session.u)), history: await getRuntime().history.count(session.u) } };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0; const chunks = [];
        req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { reject(new Error('request too large')); req.destroy(); return; } chunks.push(chunk); });
        req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (_) { reject(new Error('invalid json')); } });
        req.on('error', reject);
    });
}

async function staticFile(res, name, type) {
    try { const body = await fsp.readFile(path.join(WEB_ROOT, name)); secureHeaders(res, responseIsSecure(res)); res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }); res.end(body); }
    catch (_) { text(res, 404, 'Not found'); }
}

function requestToken(req, url) {
    const direct = url.searchParams.get('token') || req.headers['x-music-session'];
    if (direct) return String(direct);
    const cookie = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('musicSession='));
    if (!cookie) return '';
    try { return decodeURIComponent(cookie.slice('musicSession='.length)); } catch (_) { return ''; }
}

async function prepareDownload(session, body) {
    const ownerRuntime = getRuntime();
    const inputUrl = String(body.url || body.track?.url || '').trim();
    const upload = require('./uploadsStore').parseUploadUrl(inputUrl);
    if (upload) {
        const file = await ownerRuntime.uploads.resolve(session.u, inputUrl);
        return { path: file.path, filename: `${file.title || 'Upload'}${path.extname(file.path)}`, mime: require('./uploadsStore').mimeForExtension(path.extname(file.path)), cleanup: async () => {},
            track: ownerRuntime.sources.sanitize(file), quality: `Original ${file.audioCodec || 'audio'}${file.sampleRate ? ` · ${file.sampleRate} Hz` : ''}`, platform: ownerRuntime.platform };
    }
    const input = body.track || { url: inputUrl, title: body.title || '', author: body.author || '' };
    const source = await ownerRuntime.sources.resolve(input, session.u);
    await validatePublicUrl(source.url);
    const requestedLimit = Number(process.env.WEB_MAX_DOWNLOAD_BYTES ?? config.WEB_MAX_DOWNLOAD_BYTES ?? 0);
    return { ...await downloadAudio(source.url, { title: source.title || 'Music', maxBytes: Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 0 }),
        track: ownerRuntime.sources.sanitize(source), quality: 'Converted MP3 · best available audio source', platform: ownerRuntime.platform };
}

function pipeDownload(req, res, file, session) {
    const stream = createReadStream(file.path); let cleaned = false;
    const cleanup = () => { if (cleaned) return; cleaned = true; const remove = () => file.cleanup?.().catch?.(() => {}); if(stream.closed) remove(); else { stream.once('close', remove); stream.destroy(); } };
    stream.once('error', err => { res.destroy(err); cleanup(); });
    res.once('close', cleanup);
    res.once('finish', () => {
        if (!req.aborted && stream.bytesRead === file.size && file.platform?.recordDownload) {
            const work = (async () => { for(let attempt=0;attempt<3;attempt++) {
                try { await file.platform.recordDownload(session.u, file.track, {id:file.recordId, guildId:session.g, filename:file.filename, mime:file.mime||'audio/mpeg', quality:file.quality, bytes:file.size}); return; }
                catch(error) { if(attempt===2)throw error; await new Promise(resolve=>setTimeout(resolve,100*(attempt+1))); }
            } })();
            downloadWrites.add(work);work.catch(() => console.warn('[WebPlayer] Could not persist completed download.')).finally(() => downloadWrites.delete(work));
        }
        cleanup();
    });
    stream.pipe(res);
}

async function handler(req, res) {
    try {
        const url = new URL(req.url, 'http://localhost');
        res.__musicSecure = requestIsSecure(req);
        const publicUrl = effectivePublicUrl();
        // Only perform an HTTP→HTTPS redirect when a trusted proxy explicitly
        // tells us the original request was HTTP. Blindly redirecting an HTTP
        // backend just because WEB_PLAYER_PUBLIC_URL is https:// can create an
        // infinite loop behind TLS-terminating proxies.
        if (config.WEB_PLAYER_FORCE_PUBLIC_HTTPS !== false && trustProxyEnabled() &&
            publicUrl.toLowerCase().startsWith('https://') && !res.__musicSecure) {
            const location = `${publicUrl}${url.pathname}${url.search}`;
            res.writeHead(308, { 'Location': location, 'Cache-Control': 'no-store' });
            return res.end();
        }
        if (url.pathname === '/healthz' && req.method === 'GET') {
            secureHeaders(res, responseIsSecure(res));
            return json(res, 200, { ok: true, service: 'music-by-a-web', globalHttps: /^https:\/\//i.test(effectivePublicUrl()), now: Date.now() });
        }
        if (url.pathname === '/app.css') return staticFile(res, 'app.css', 'text/css; charset=utf-8');
        if (url.pathname === '/coverPhysics.js') return staticFile(res, 'coverPhysics.js', 'application/javascript; charset=utf-8');
        if (url.pathname === '/app.js') return staticFile(res, 'app.js', 'application/javascript; charset=utf-8');
        if (url.pathname === '/platform.js') return staticFile(res, 'platform.js', 'application/javascript; charset=utf-8');
        if (url.pathname === '/platform.css') return staticFile(res, 'platform.css', 'text/css; charset=utf-8');
        if (url.pathname === '/refinements.css') return staticFile(res, 'refinements.css', 'text/css; charset=utf-8');
        if (url.pathname === '/artwork.js') return staticFile(res, 'artwork.js', 'text/javascript; charset=utf-8');
        if (url.pathname === '/video-sync.js') return staticFile(res, 'video-sync.js', 'text/javascript; charset=utf-8');
        if (url.pathname === '/mobile.css') return staticFile(res, 'mobile.css', 'text/css; charset=utf-8');
        if (url.pathname === '/hls.min.js') {
            const file = require.resolve('hls.js/dist/hls.min.js');
            const body = await fsp.readFile(file); secureHeaders(res, responseIsSecure(res));
            res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'public, max-age=86400' }); return res.end(body);
        }
        if (url.pathname === '/player') {
            const token = requestToken(req, url);
            if (token) {
                try {
                    const session = verifyToken(token);
                    const maxAge = Math.max(0, Math.floor((session.e - Date.now()) / 1000));
                    res.setHeader('Set-Cookie', `musicSession=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${responseIsSecure(res) ? '; Secure' : ''}`);
                } catch (_) { /* The page shows the existing session-expired state. */ }
            }
            res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
            return staticFile(res, 'index.html', 'text/html; charset=utf-8');
        }
        if (url.pathname === '/') return text(res, 200, 'Music By ! A Web Player is running.');
        const token = requestToken(req, url);
        const session = verifyToken(token);
        session.token = token;
        secureHeaders(res, responseIsSecure(res));
        const selectedRuntime = runtimeForSession(session);
        return await requestContext.run(selectedRuntime, () => runWithClient(selectedRuntime.client, async () => {
        if (await getRuntime()?.platformHttp.handle(req, res, url, session)) return;
        if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, await stateFor(session));
        if (url.pathname === '/api/lyrics' && req.method === 'GET') {
            if (url.searchParams.get('audioId')) {
                const job = getRuntime().media.get(url.searchParams.get('audioId'), session); if (job.kind !== 'audio') throw new Error('Browser audio is unavailable.');
                const found = await lyricsProvider.findLyrics(job.track, { language: lyricsProvider.guessLyricsLanguage?.(job.track.title, job.track.author), forceRefresh: url.searchParams.get('refresh') === '1' });
                return json(res, 200, { ...publicLyrics(found, job.track), trackKey: webTrackKey(job.track) });
            }
            return json(res, 200, await currentLyrics(session, url.searchParams.get('track') || '', url.searchParams.get('refresh') === '1'));
        }
        if (url.pathname === '/api/collection' && req.method === 'GET') {
            const kind = url.searchParams.get('kind'); const list = await collectionFor(session, kind); return json(res, 200, { kind, tracks: list.slice(0, 2000).map(track => publicTrack(track, { resolveArtwork: false, session })) });
        }
        if (url.pathname === '/api/search' && req.method === 'GET') {
            const type = url.searchParams.get('type') || 'tracks';
            const items = await catalog.search(url.searchParams.get('q'), type);
            return json(res, 200, { type, items });
        }
        if (url.pathname === '/api/detail' && req.method === 'GET') {
            return json(res, 200, await catalog.detail(url.searchParams.get('type'), url.searchParams.get('id')));
        }
        if (url.pathname === '/api/playlists' && req.method === 'GET') return json(res, 200, { playlists: await getRuntime().playlists.list(session.u) });
        if (url.pathname === '/api/library' && req.method === 'POST') return json(res, 200, await editLibrary(session, await readBody(req)));
        if (url.pathname === '/api/action' && req.method === 'POST') return json(res, 200, await action(session, await readBody(req)));
        if (url.pathname === '/api/download/prepare' && req.method === 'POST') {
            cleanupDownloadJobs();
            const body = await readBody(req);
            const file = await prepareDownload(session, body);
            const stat = await fsp.stat(file.path);
            const id = crypto.randomBytes(18).toString('base64url');
            const job = { ...file, size: stat.size, recordId: crypto.randomUUID(), userId: session.u, guildId: session.g, expiresAt: Date.now() + 10 * 60_000, expiryTimer: null };
            job.expiryTimer = setTimeout(() => cleanupDownloadJob(id, job), 10 * 60_000);
            job.expiryTimer.unref?.();
            downloadJobs.set(id, job);
            return json(res, 200, { id, filename: file.filename, bytes: stat.size });
        }
        if (url.pathname === '/api/download/file' && req.method === 'GET') {
            cleanupDownloadJobs();
            const id = String(url.searchParams.get('id') || '');
            const job = downloadJobs.get(id);
            if (!job || job.userId !== session.u || job.guildId !== session.g) return json(res, 404, { error: 'download expired or unavailable' });
            downloadJobs.delete(id);
            if (job.expiryTimer) clearTimeout(job.expiryTimer);
            secureHeaders(res, responseIsSecure(res));
            res.writeHead(200, {
                'Content-Type': job.mime, 'Content-Length': job.size,
                'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(job.filename)}`,
                'Cache-Control': 'private, no-store', 'Accept-Ranges': 'none'
            });
            pipeDownload(req, res, job, session);
            return;
        }
        if (url.pathname === '/api/download' && req.method === 'POST') {
            const body = await readBody(req);
            const file = await prepareDownload(session, body);
            const stat = await fsp.stat(file.path);
            secureHeaders(res, responseIsSecure(res));
            res.writeHead(200, { 'Content-Type': file.mime || 'audio/mpeg', 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`, 'Cache-Control': 'no-store' });
            pipeDownload(req, res, { ...file, size: stat.size, recordId: crypto.randomUUID() }, session); return;
        }
        return json(res, 404, { error: 'not found' });
        }));
    } catch (err) {
        if (res.headersSent) { res.destroy(err); return; }
        const status = Number(err.status || err.statusCode) || (/session/.test(String(err.message || '')) ? 401 : 400);
        const message = /^(?:SOURCE_|PLAYBACK_FAILED)/.test(String(err.code || '')) ? 'تعذر تشغيل هذه الأغنية الآن. جرّب رابطًا أو مصدرًا آخر.' : String(err.message || 'request failed').slice(0, 500);
        return json(res, status, { error: message });
    }
}

async function start({ client, player, fleet = client?.fleet, platform = platformService, media, sources = platformSources, artwork, openArtworkMedia, uploads = uploadsStore, favorites: favoriteStore = favorites, history: historyStore = history, playlists: playlistStore = playlists }) {
    if (ready && server) return server;
    if (startPromise) return startPromise;
    if (config.WEB_PLAYER_ENABLED === false) return null;
    startPromise = (async () => {
        ready = false;
        const mediaService = media || new PlatformMedia({ uploads });
        runtime = { client, player, fleet, targets: new WeakMap(), platform, media: mediaService, sources, uploads, favorites: favoriteStore, history: historyStore, playlists: playlistStore, actions: new Map(),
            platformHttp: createPlatformHttp({ platform, media: mediaService, uploads, artwork, openArtworkMedia, favorites: favoriteStore, playlists: playlistStore, resolveTrack: (...args) => sources.resolve(...args), recoverTrack: (...args) => sources.recover(...args) }) };
        const host = String(process.env.WEB_PLAYER_HOST || config.WEB_PLAYER_HOST || '127.0.0.1').trim() || '127.0.0.1';
        const port = Math.max(1, Math.min(65535, Number(process.env.WEB_PLAYER_PORT || config.WEB_PLAYER_PORT || 3780)));
        const tls = httpsOptions();
        server = tls ? https.createServer(tls, handler) : http.createServer(handler);
        server.keepAliveTimeout = 65_000;
        server.headersTimeout = 70_000;
        server.requestTimeout = 15 * 60_000;
        server.maxRequestsPerSocket = 0;
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });

        const originHost = (host === '0.0.0.0' || host === '::' || host === '') ? '127.0.0.1' : host;
        const printableOriginHost = originHost.includes(':') && !originHost.startsWith('[') ? `[${originHost}]` : originHost;
        const originUrl = `${tls ? 'https' : 'http'}://${printableOriginHost}:${port}`;

        try {
            const gateway = require('./globalWebGateway');
            const result = await gateway.start({ originUrl, onPublicUrl: setRuntimePublicUrl });
            if (result?.publicUrl) setRuntimePublicUrl(result.publicUrl);
        } catch (err) {
            const required = String(process.env.WEB_PLAYER_REQUIRE_GLOBAL_HTTPS || '').trim().toLowerCase();
            const requireGlobal = required ? ['1', 'true', 'yes', 'on'].includes(required) : config.WEB_PLAYER_REQUIRE_GLOBAL_HTTPS !== false;
            console.warn(`[WebPlayer] worldwide HTTPS gateway failed: ${err.message}`);
            if (requireGlobal) {
                const current = server;
                const previousRuntime = runtime;
                server = null;
                runtime = null;
                await new Promise(resolve => current.close(() => resolve()));
                await previousRuntime.media.close();
                throw err;
            }
        }

        ready = true;
        console.log(`[WebPlayer] ready: ${publicBaseUrl()}`);
        let lans = [];
        try { lans = Object.values(os.networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal).map(x => `${httpsOptions() ? 'https' : 'http'}://${x.address}:${port}`); }
        catch (_) { /* Network interface enumeration can be blocked in containers. */ }
        if (!effectivePublicUrl() && lans.length) console.log(`[WebPlayer] LAN: ${lans.join(' | ')} (LAN-only fallback; worldwide mode is not active.)`);
        return server;
    })().finally(() => { startPromise = null; });
    return startPromise;
}

async function stop() {
    ready = false;
    try { await require('./globalWebGateway').stop(); } catch (_) {}
    runtimePublicUrl = '';
    const previousRuntime = runtime;
    runtime = null;
    if (!server) { await previousRuntime?.platformHttp.close(); await previousRuntime?.media.close(); return; }
    const current = server;
    server = null;
    for (const [id, job] of downloadJobs) cleanupDownloadJob(id, job);
    const closed = new Promise(resolve => current.close(() => resolve()));
    await Promise.allSettled([previousRuntime?.platformHttp.close(), previousRuntime?.media.close()]);
    current.closeAllConnections?.();
    await closed;
    await Promise.allSettled([...downloadWrites]);
}

function isStarted() { return Boolean(server && ready); }
module.exports = { start, stop, isStarted, createSessionUrl, createToken, verifyToken, publicBaseUrl, setRuntimePublicUrl, _handler: handler };
