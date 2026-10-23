// ============================================================
//  YouTube/Audio provider powered by yt-dlp
//  Stable design: no ytdl-core/play-dl. We spawn a working yt-dlp
//  candidate: local tools/yt-dlp, PATH yt-dlp, or python -m yt_dlp.
// ============================================================

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { PassThrough, Readable } = require("stream");
const config = require("../config");
const { resolveFfmpegPath, resolveAudioFilter } = require("./ffmpegResolver");
const performanceProfile = require("./performanceProfile");
const sourceResolver = require("./sourceResolver");
const { LOCAL_INPUT_ARGS } = require('./uploadsStore');

const IS_WIN = process.platform === "win32";
const ROOT_DIR = path.join(__dirname, "..");

async function* pcmOpusFrames(source, frameBytes) {
    let remainder = Buffer.alloc(0);
    for await (const chunk of source) {
        const bytes = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
        let offset = 0;
        while (offset + frameBytes <= bytes.length) {
            yield bytes.subarray(offset, offset + frameBytes);
            offset += frameBytes;
        }
        remainder = bytes.subarray(offset);
    }
    if (remainder.length) {
        const lastFrame = Buffer.alloc(frameBytes);
        remainder.copy(lastFrame);
        yield lastFrame;
    }
}
const BIN_DIR = path.join(ROOT_DIR, "bin");
const TOOLS_DIR = path.join(ROOT_DIR, "tools");

const USER_AGENT =
    config.YTDLP_USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

let cachedCandidate = null;
let cachedVersion = "";
let candidatePromise = null;
let cachedCandidateAt = 0;
let cachedCandidateKey = "";
const CANDIDATE_CACHE_TTL_MS = 10 * 60_000;

const SEARCH_CACHE_TTL_MS = 10 * 60_000;
const SEARCH_CACHE_MAX = 200;
const searchCache = new Map();
const searchInflight = new Map();
const metadataLimiter = new (require('./asyncLimiter').AsyncLimiter)({ concurrency: Number(config.YTDLP_METADATA_CONCURRENCY || 8), maxPending: Number(config.YTDLP_METADATA_QUEUE_MAX || 500) });

function withImportReport(tracks, report) {
    if (report) Object.defineProperty(tracks, 'importReport', { value: { ...report }, enumerable: false });
    return tracks;
}

function cloneSearchResults(tracks) {
    return withImportReport(tracks.map(t => ({ ...t })), tracks.importReport);
}

function getCachedSearch(key) {
    const hit = searchCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > SEARCH_CACHE_TTL_MS) { searchCache.delete(key); return null; }
    searchCache.delete(key);
    searchCache.set(key, hit);
    return cloneSearchResults(hit.value);
}

function setCachedSearch(key, value) {
    if (searchCache.has(key)) searchCache.delete(key);
    searchCache.set(key, { at: Date.now(), value: cloneSearchResults(value) });
    while (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
}

function fileExists(p) {
    try { return !!p && fs.existsSync(p); } catch (_) { return false; }
}

function uniqueByKey(items, fn) {
    const seen = new Set();
    return items.filter(item => {
        const key = fn(item);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function localBinaryCandidates() {
    const names = IS_WIN ? ["yt-dlp.exe", "youtube-dl.exe"] : ["yt-dlp", "youtube-dl"];
    const dirs = [
        BIN_DIR,
        TOOLS_DIR,
        path.join(ROOT_DIR, "node_modules", ".bin"),
        path.join(ROOT_DIR, "node_modules", "youtube-dl-exec", "bin"),
    ];

    const paths = [];
    if (config.YTDLP_PATH) paths.push(config.YTDLP_PATH);
    for (const dir of dirs) {
        for (const name of names) paths.push(path.join(dir, name));
    }
    // Node passes shell arguments through cmd.exe as command text. Search text
    // and URLs must remain argv values, including their literal &, | and quotes.
    return paths.filter(p => !/\.(?:cmd|bat)$/i.test(String(p)) && fileExists(p));
}

function getCandidates() {
    const local = localBinaryCandidates().map(p => ({
        cmd: p,
        prefix: [],
        label: p,
        shell: false,
    }));

    const candidates = [
        ...local,
        { cmd: "yt-dlp", prefix: [], label: "yt-dlp", shell: false },
        { cmd: "python", prefix: ["-m", "yt_dlp"], label: "python -m yt_dlp", shell: false },
        { cmd: "python3", prefix: ["-m", "yt_dlp"], label: "python3 -m yt_dlp", shell: false },
        { cmd: "py", prefix: ["-3", "-m", "yt_dlp"], label: "py -3 -m yt_dlp", shell: false },
    ];

    return uniqueByKey(candidates, c => `${c.cmd}|${c.prefix.join(" ")}`);
}

function spawnCandidate(candidate, args, options = {}) {
    const child = spawn(candidate.cmd, [...candidate.prefix, ...args], {
        cwd: ROOT_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: !IS_WIN,
        shell: candidate.shell,
        ...options,
    });
    // Search/metadata/cache yt-dlp work is background by default. Live playback
    // upgrades the same PID to the audio class after the real-time reservation starts.
    performanceProfile.registerChildProcess(child, 'background');
    return child;
}

async function runCandidate(candidate, args, timeoutMs = 12000, options = {}) {
    try {
        return await require('./audioDownload').run(candidate.cmd, [...candidate.prefix, ...args], {
            cwd: ROOT_DIR, shell: candidate.shell, timeoutMs, firstByteTimeoutMs: 0, idleTimeoutMs: 0, signal: options.signal,
        });
    } catch (err) {
        if (options.signal?.aborted) throw options.signal.reason;
        throw new Error(`${candidate.label}: ${err.message || err}`);
    }
}

async function getWorkingCandidate(forceRefresh = false, options = {}) {
    if (typeof forceRefresh === 'object') { options = forceRefresh; forceRefresh = false; }
    options.signal?.throwIfAborted();
    const key = String(config.YTDLP_PATH || '');
    const candidatePresent = cachedCandidate && (!path.isAbsolute(cachedCandidate.cmd) || fileExists(cachedCandidate.cmd));
    if (candidatePresent && cachedCandidateKey === key && Date.now() - cachedCandidateAt < CANDIDATE_CACHE_TTL_MS && !forceRefresh) return { candidate: cachedCandidate, version: cachedVersion };
    // Calls with a cancellation signal own their discovery process. A closing
    // request cannot be forced to wait for another consumer's probe to finish.
    if (candidatePromise && !forceRefresh && !options.signal) return candidatePromise;
    const work = (async () => {
        const controller = new AbortController(), timeoutMs = Math.max(1, Math.min(90_000, Number(options.timeoutMs) || 90_000));
        const timer = setTimeout(() => controller.abort(new Error('yt-dlp candidate resolution timed out.')), timeoutMs); timer.unref?.();
        const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
        const started = Date.now(), errors = [];
        try {
            for (const candidate of getCandidates()) {
                signal.throwIfAborted();
                const remaining = timeoutMs - (Date.now() - started);
                if (remaining <= 0) throw new Error('yt-dlp candidate resolution timed out.');
                try {
                    const result = await runCandidate(candidate, ['--version'], Math.min(15000, remaining), { signal });
                    signal.throwIfAborted();
                    cachedCandidate = candidate; cachedVersion = result.stdout.trim() || 'unknown'; cachedCandidateAt = Date.now(); cachedCandidateKey = key;
                    return { candidate, version: cachedVersion };
                } catch (err) {
                    signal.throwIfAborted(); errors.push(err.message.split('\n')[0]);
                }
            }
            throw new Error('yt-dlp was not found or is not working. Run install.bat, or install it manually with: py -3 -m pip install --user -U yt-dlp\n' + errors.map(error => `- ${error}`).join('\n'));
        } finally { clearTimeout(timer); }
    })();
    if (!forceRefresh && !options.signal) candidatePromise = work;
    try { return await work; }
    finally { if (candidatePromise === work) candidatePromise = null; }
}

async function startYtDlp(args, options = {}) {
    const { signal, ...spawnOptions } = options;
    const { candidate } = await getWorkingCandidate(false, { signal }); signal?.throwIfAborted();
    const child = spawnCandidate(candidate, args, spawnOptions); child.__ytDlpLabel = candidate.label;
    if (signal) {
        const abort = () => { void require('./audioDownload').killProcessTree(child); child.stdout?.destroy(); child.stderr?.destroy(); };
        signal.addEventListener('abort', abort, { once: true }); child.once('close', () => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
    }
    return child;
}

function playbackClientStrategy(attempt = 1) {
    const configured = Array.isArray(config.YTDLP_PLAYBACK_CLIENT_STRATEGIES)
        ? config.YTDLP_PLAYBACK_CLIENT_STRATEGIES
        : null;
    const defaults = [
        ['android', 'web_embedded', 'web_safari', 'web', 'ios'],
        ['web_safari', 'ios', 'web_embedded'],
        ['android', 'mweb'],
        ['web', 'web_embedded'],
        ['ios', 'mweb', 'web_safari'],
    ];
    const source = configured?.length ? configured : defaults;
    const index = Math.max(0, Number(attempt || 1) - 1) % source.length;
    const raw = Array.isArray(source[index]) ? source[index] : String(source[index] || '').split(',');
    const clients = [...new Set(raw.map(x => String(x || '').trim()).filter(Boolean))];
    return clients.length ? clients : defaults[0];
}

function buildCommonArgs(options = {}) {
    const playbackAttempt = Math.max(0, Number(options.playbackAttempt || 0));
    const playback = playbackAttempt > 0;
    const provider = String(options.provider || 'youtube').toLowerCase();
    const youtubeSpecific = provider === 'youtube';
    const clients = youtubeSpecific
        ? (playback ? playbackClientStrategy(playbackAttempt) : options.playerClient && options.playerClient !== 'default' ? [options.playerClient] : [])
        : [];
    // Metadata uses automatic clients and bounded retries. Streaming playback
    // keeps its separate, short client rotation policy.
    const retries = playback ? Math.max(1, Number(config.YTDLP_PLAYBACK_RETRIES_PER_STRATEGY || 3)) : Math.max(0, Math.min(2, Number(config.YTDLP_RETRIES) || 1));
    const fragmentRetries = playback ? Math.max(1, Number(config.YTDLP_PLAYBACK_FRAGMENT_RETRIES || 5)) : Math.max(0, Math.min(2, Number(config.YTDLP_FRAGMENT_RETRIES) || 2));
    const socketTimeout = playback
        ? Math.max(8, Math.min(Number(config.YTDLP_SOCKET_TIMEOUT || 25), Number(config.YTDLP_PLAYBACK_SOCKET_TIMEOUT || 18)))
        : Number(config.YTDLP_SOCKET_TIMEOUT || 25);
    const args = [
        "--no-warnings",
        "--no-check-certificates",
        "--force-ipv4",
        "--retries", String(retries),
        "--fragment-retries", String(fragmentRetries),
        "--extractor-retries", String(playback ? Math.max(2, Number(config.YTDLP_PLAYBACK_EXTRACTOR_RETRIES || 3)) : 3),
        "--socket-timeout", String(socketTimeout),
        "--concurrent-fragments", String(config.YTDLP_CONCURRENT_FRAGMENTS || 4),
        "--user-agent", USER_AGENT,
        "--js-runtimes", `node:${process.execPath}`,
    ];
    if (youtubeSpecific) {
        const youtubeExtractorArgs = clients.length ? [`player_client=${clients.join(',')}`] : [];
        if (options.youtubeSkipTranslatedSubs === true) youtubeExtractorArgs.push('skip=translated_subs');
        if (youtubeExtractorArgs.length) args.push("--extractor-args", `youtube:${youtubeExtractorArgs.join(';')}`);
    }

    // yt-dlp itself needs to know where FFmpeg is when features such as seeking/cutting
    // are involved. Without this, it may print: "ffmpeg is not installed" even though
    // our Node process can run the resolved FFmpeg binary.
    const ffmpegPath = getFfmpegPath();
    if (ffmpegPath) args.push("--ffmpeg-location", ffmpegPath);

    if (config.YTDLP_COOKIES_PATH) {
        args.push("--cookies", config.YTDLP_COOKIES_PATH);
    } else if (config.YTDLP_COOKIES_FROM_BROWSER) {
        args.push("--cookies-from-browser", config.YTDLP_COOKIES_FROM_BROWSER);
    }

    return args;
}

function getFfmpegPath() {
    return resolveFfmpegPath();
}

function compactError(text, max = 1200) {
    const clean = String(text || "").replace(/\r/g, "").trim();
    if (!clean) return "";
    return clean.length > max ? clean.slice(-max) : clean;
}

function metadataFailure(result, provider, kind = 'invalid', parseCause = null) {
    const stderr = String(result?.stderr || '').replace(/\r/g, '').trim();
    let code = 'SOURCE_PROVIDER_INVALID_RESPONSE', retryable = true;
    if (/sign\s+in|log\s*in|not\s+a\s+bot|confirm.*(?:bot|identity)|authentication|cookies.*required|members[- ]only|age[- ]restricted/i.test(stderr)) {
        code = 'SOURCE_PROVIDER_AUTH_REQUIRED'; retryable = false;
    } else if (/video is private|private video|video (?:is |has been )?(?:removed|unavailable)|not available in your country|copyright|account.*(?:terminated|suspended)|does not exist/i.test(stderr)) {
        code = 'SOURCE_MEDIA_UNAVAILABLE'; retryable = false;
    } else if (kind === 'timeout' || /HTTP (?:Error[: ]*)?(?:429|5\d\d)|too many requests|timed?\s*out|timeout|connection (?:reset|refused)|ECONNRESET|ETIMEDOUT|EAI_AGAIN|temporary|temporarily|network is unreachable/i.test(stderr)
        || (kind === 'empty' && result?.exitCode !== 0)) {
        code = 'SOURCE_PROVIDER_UNAVAILABLE';
    }
    const messages = {
        SOURCE_PROVIDER_AUTH_REQUIRED: 'yt-dlp requires authentication or provider verification.',
        SOURCE_MEDIA_UNAVAILABLE: 'The requested media is unavailable from its provider.',
        SOURCE_PROVIDER_UNAVAILABLE: kind === 'timeout' ? 'yt-dlp metadata request timed out.' : 'The media provider is temporarily unavailable.',
        SOURCE_PROVIDER_INVALID_RESPONSE: 'yt-dlp did not return usable metadata.',
    };
    // Keep the real site diagnostic in the cause, outside the concise message
    // exposed to callers. Classify before bounding it, so long stderr cannot
    // hide an authentication/429/5xx diagnosis at the beginning of the output.
    const diagnostic = stderr
        ? new Error(compactError(stderr, 2400), parseCause ? { cause: parseCause } : undefined)
        : parseCause || new Error(kind === 'timeout' ? 'Metadata deadline expired.' : 'yt-dlp returned no metadata object.');
    return Object.assign(new Error(messages[code], { cause: diagnostic }), {
        code, provider: String(provider || 'youtube'), retryable, retryLimit: retryable ? 1 : 0,
        exitCode: result?.exitCode ?? null,
    });
}

function runYtDlpJson(args, timeoutMs = config.YTDLP_METADATA_TIMEOUT || 30000, options = {}) {
    return metadataLimiter.run(() => runYtDlpJsonNow(args, timeoutMs, options), { signal: options.signal });
}
async function runYtDlpJsonNow(args, timeoutMs = config.YTDLP_METADATA_TIMEOUT || 30000, options = {}) {
    const controller = new AbortController(), budget = Math.max(1, Number(timeoutMs) || 30000), started = Date.now();
    const provider = options.provider || 'youtube';
    const timer = setTimeout(() => controller.abort(metadataFailure(null, provider, 'timeout')), budget); timer.unref?.();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
        const { candidate } = await getWorkingCandidate(false, { signal, timeoutMs: Math.min(90_000, budget) }); signal.throwIfAborted();
        const remaining = budget - (Date.now() - started); if (remaining <= 0) throw metadataFailure(null, provider, 'timeout');
        const result = await require('./audioDownload').run(candidate.cmd, [...candidate.prefix, ...buildCommonArgs({ ...options, provider: options.provider || 'youtube' }), '--quiet', '--skip-download', '--ignore-no-formats-error', ...args], {
            cwd: ROOT_DIR, shell: false, signal, timeoutMs: remaining, firstByteTimeoutMs: 0, idleTimeoutMs: 0, allowNonzeroExit: true,
        });
        signal.throwIfAborted();
        const clean = result.stdout.trim(), stderr = result.stderr.trim();
        if (!clean) throw metadataFailure(result, provider, 'empty');
        let parsed;
        try {
            const firstJsonIndex = clean.search(/[\[{]/);
            parsed = JSON.parse(firstJsonIndex >= 0 ? clean.slice(firstJsonIndex) : clean);
        } catch (error) { throw metadataFailure(result, provider, 'invalid', error); }
        // yt-dlp emits JSON null when extraction fails. It is valid JSON but
        // no metadata object; Object.defineProperty(null) used to mask the
        // actual YouTube challenge as an unrelated JSON/type error.
        if (!parsed || typeof parsed !== 'object') throw metadataFailure(result, provider);
        Object.defineProperty(parsed, '__stderr', { value: stderr, enumerable: false });
        return parsed;
    } finally { clearTimeout(timer); }
}

function extractYoutubeId(input = "") {
    const s = String(input);
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{6,})/i,
        /^([A-Za-z0-9_-]{11})$/,
    ];
    for (const re of patterns) {
        const m = s.match(re);
        if (m) return m[1];
    }
    return null;
}

function providerFromEntry(entry, parentProvider = "") {
    const raw = String(
        entry?.extractor_key || entry?.ie_key || entry?.extractor || parentProvider || ""
    ).toLowerCase();
    if (raw.includes("soundcloud")) return "soundcloud";
    if (raw.includes("youtube") || raw.includes("youtu")) return "youtube";
    if (raw.includes("spotify")) return "spotify";
    if (raw.includes("tidal")) return "tidal";

    const candidate = String(entry?.webpage_url || entry?.original_url || entry?.url || "");
    if (require('./platformSources').isSoundCloudApiTrack(candidate)) return 'soundcloud';
    const classified = sourceResolver.classifyUrl(candidate);
    return classified?.provider || "generic";
}

function bestThumbnail(entry, provider = providerFromEntry(entry)) {
    if (Array.isArray(entry.thumbnails) && entry.thumbnails.length) {
        const sorted = [...entry.thumbnails].filter(t => t && t.url).sort((a, b) => (b.width || 0) - (a.width || 0));
        if (sorted[0]?.url) return sorted[0].url;
    }
    if (entry.thumbnail) return entry.thumbnail;
    if (provider !== "youtube") return "";
    const id = extractYoutubeId(entry.webpage_url || entry.url || entry.id || "");
    return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : "";
}

function normalizeEntry(entry, parentProvider = "") {
    if (!entry) return null;

    const provider = providerFromEntry(entry, parentProvider);
    const id = String(entry.id || "").trim() || extractYoutubeId(entry.webpage_url || entry.url || "");
    const candidates = [entry.webpage_url, entry.original_url, entry.url].filter(Boolean).map(String);
    const sources = require('./platformSources');
    let url = candidates.find(value => sources.isSourceUrl(value)) || candidates.find(value => /^https?:\/\//i.test(value) && !/(^|\.)(?:googlevideo\.com|sndcdn\.com)$/.test(new URL(value).hostname)) || '';
    if (provider === 'soundcloud' && entry.permalink_url && sources.isSourceUrl(entry.permalink_url)) url = entry.permalink_url;

    // yt-dlp flat playlists can expose a bare extractor-specific ID. The old code
    // treated every bare ID as YouTube, which could corrupt SoundCloud playlist
    // entries. Reconstruct only when the provider makes the URL semantics explicit.
    if (!url && provider === "youtube" && id) {
        url = `https://www.youtube.com/watch?v=${id}`;
    } else if (!url && provider === "soundcloud" && /^\d+$/.test(id)) {
        // Current yt-dlp SoundCloud extractor accepts API-v2 track URLs directly.
        url = `https://api-v2.soundcloud.com/tracks/${id}`;
    } else if (!url && extractYoutubeId(id)) {
        url = `https://www.youtube.com/watch?v=${extractYoutubeId(id)}`;
    }

    if (!url || !/^https?:\/\//i.test(url)) return null;

    return {
        title: String(entry.title || entry.fulltitle || entry.track || "Unknown title").slice(0, 200),
        url,
        duration: Number(entry.duration || entry.duration_seconds || 0) || 0,
        thumbnail: bestThumbnail(entry, provider),
        source: "ytdlp",
        provider,
        author: entry.uploader || entry.channel || entry.creator || entry.artist || entry.album_artist || "Unknown",
        webpageUrl: sources.isSourceUrl(entry.webpage_url) ? entry.webpage_url : url,
        extractor: String(entry.extractor_key || entry.ie_key || entry.extractor || parentProvider || ""),
        // Preserve richer music metadata when yt-dlp exposes it. The Web artwork
        // resolver can use these fields to locate the official album/single cover
        // without changing the title/artist shown to Discord users.
        mediaTitle: String(entry.track || entry.alt_title || "").slice(0, 240),
        mediaArtist: String(entry.artist || entry.creator || "").slice(0, 200),
        // Auto-generated Topic descriptions can contain explicit music credit
        // metadata even when the flat entry's uploader is only Release - Topic.
        // Preserve the text for strict source matching; do not infer an artist
        // from arbitrary description keywords at this normalization boundary.
        description: String(entry.description || "").trim().slice(0, 2000),
        album: String(entry.album || "").slice(0, 240),
        albumArtist: String(entry.album_artist || "").slice(0, 200),
        releaseYear: Number(entry.release_year || String(entry.release_date || "").slice(0, 4) || 0) || 0,
    };
}

function extractEntries(data) {
    if (!data) return [];
    const parentProvider = providerFromEntry(data);

    if (Array.isArray(data.entries)) {
        return data.entries.filter(Boolean).map(entry => normalizeEntry(entry, parentProvider)).filter(Boolean);
    }

    const single = normalizeEntry(data, parentProvider);
    return single ? [single] : [];
}

function isUrl(input) {
    return /^https?:\/\//i.test(String(input || "").trim());
}

function isDirectAudioUrl(input) {
    const clean = String(input || "").split("?")[0].toLowerCase();
    return /\.(mp3|m4a|ogg|wav|flac|opus|webm|aac)$/i.test(clean);
}

async function extractUrlMetadata(target, resolution, playlistLimit, options = {}) {
    const flatArgs = [
        "--dump-single-json",
        "--flat-playlist",
        "--playlist-end", String(playlistLimit),
        target,
    ];
    const metadataTimeout = resolution.provider === "soundcloud"
        ? Math.max(Number(config.YTDLP_METADATA_TIMEOUT || 30000), Number(config.SOUNDCLOUD_METADATA_TIMEOUT_MS || 45000))
        : Number(config.YTDLP_METADATA_TIMEOUT || 30000);

    const data = await runYtDlpJson(flatArgs, metadataTimeout, { provider: resolution.provider, signal: options.signal });
    let tracks = extractEntries(data);
    let selectedData = data;

    if (resolution.provider === "soundcloud" && Array.isArray(data.entries) && config.SOUNDCLOUD_PLAYLIST_DEEP_FALLBACK !== false) {
        const rawCount = Array.isArray(data.entries) ? data.entries.filter(Boolean).length : 0;
        const expected = rawCount ? Math.min(rawCount, playlistLimit) : 1;
        const looksIncomplete = tracks.length === 0 || (rawCount > 0 && tracks.length < expected);
        if (looksIncomplete) {
            try {
                const deepTimeout = Math.max(metadataTimeout, Number(config.SOUNDCLOUD_PLAYLIST_DEEP_TIMEOUT_MS || 90000));
                const deepData = await runYtDlpJson([
                    "--dump-single-json",
                    "--playlist-end", String(playlistLimit),
                    target,
                ], deepTimeout, { provider: resolution.provider, signal: options.signal });
                const deepTracks = extractEntries(deepData);
                if (deepTracks.length > tracks.length) { tracks = deepTracks; selectedData = deepData; }
            } catch (err) {
                options.signal?.throwIfAborted(); if (!tracks.length) throw err;
            }
        }
    }

    const playlist = Array.isArray(selectedData.entries);
    const rawCount = playlist ? selectedData.entries.length : (tracks.length ? 1 : 0);
    const extractedCount = Number(selectedData.n_entries);
    const observedCount = Math.max(rawCount, Number.isSafeInteger(extractedCount) && extractedCount > 0 ? extractedCount : 0,
        Array.isArray(selectedData.requested_entries) ? selectedData.requested_entries.length : 0);
    // n_entries counts the requested/extracted subset; only playlist_count
    // establishes the complete playlist size when --playlist-end is active.
    const declaredCounts = [data, selectedData].map(value => value.playlist_count)
        .map(Number).filter(value => Number.isSafeInteger(value) && value > 0);
    const declared = declaredCounts.length ? Math.max(...declaredCounts) : 0;
    const total = Math.max(observedCount, declared);
    const totalKnown = !!declared || !playlist || observedCount < playlistLimit;
    return withImportReport(tracks, {
        total, returned: Math.min(tracks.length, playlistLimit),
        missing: Math.max(0, Math.min(total, playlistLimit) - tracks.length),
        truncated: Math.max(0, total - playlistLimit), limit: playlistLimit,
        totalKnown, possiblyTruncated: !totalKnown && observedCount >= playlistLimit,
    });
}

async function search(query, options = {}) {
    const signal = options.signal; signal?.throwIfAborted();
    const q = String(query || "").trim();
    const requestedLimit = Math.max(1, Math.min(Number(options.limit || config.YTDLP_SEARCH_LIMIT || 10), 25));
    const requestedPlaylistLimit = Number(options.playlistLimit ?? (config.YTDLP_PLAYLIST_LIMIT || 100));
    const playlistLimit = Math.max(1, Math.min(Number.isNaN(requestedPlaylistLimit) ? 100 : Math.trunc(requestedPlaylistLimit),
        options.playlistLimit == null ? 500 : 2000));

    if (!q) return [];

    // Text searches are case-insensitive, but URL paths/query values may not be.
    // In particular, SoundCloud secret_token values must never be lower-cased in
    // cache/inflight identity or one private link can reuse another token's result.
    const cacheKey = `${requestedLimit}|${playlistLimit}|${isUrl(q) ? q : q.toLowerCase()}`;
    const cached = options.forceRefresh ? null : getCachedSearch(cacheKey);
    if (cached) return cached;

    if (isUrl(q) && isDirectAudioUrl(q)) {
        let directTitle = q.split("/").pop().split("?")[0];
        try { directTitle = decodeURIComponent(directTitle); } catch (_) {}
        const direct = [{
            title: directTitle || "Direct audio file",
            url: q,
            duration: 0,
            thumbnail: "",
            source: "direct",
            provider: "direct",
            author: "Direct link",
        }];
        setCachedSearch(cacheKey, direct);
        return direct;
    }

    if (!signal && !options.forceRefresh && searchInflight.has(cacheKey)) {
        const pending = await searchInflight.get(cacheKey);
        return cloneSearchResults(pending);
    }

    const work = (async () => {
        const sources = require('./platformSources'), fetchImpl = options.fetchImpl || global.fetch;
        const sourceOptions = { timeoutMs: Number(config.SOURCE_LINK_RESOLVE_TIMEOUT_MS || 8000) };
        if (signal && typeof fetchImpl === 'function') sourceOptions.fetchImpl = (url, fetchOptions = {}) => {
            signal.throwIfAborted(); return fetchImpl(url, { ...fetchOptions, signal: fetchOptions.signal ? AbortSignal.any([signal, fetchOptions.signal]) : signal });
        };
        const resolution = sources.isSoundCloudApiTrack(q) ? { mode: 'direct', provider: 'soundcloud', kind: 'track', target: q, original: q } : await sources.awaitSource(() => sourceResolver.resolveInput(q, sourceOptions), signal);
        signal?.throwIfAborted();

        let tracks;
        if (resolution.mode === "search") {
            // Spotify/TIDAL track links are metadata resolvers only; playback still
            // goes through the existing primary yt-dlp/YouTube pipeline. Force one
            // result so a single external track link can never be mistaken for a playlist.
            const data = await runYtDlpJson([
                "--dump-single-json",
                "--flat-playlist",
                "--playlist-end", "1",
                `ytsearch1:${resolution.searchQuery}`,
            ], Number(config.YTDLP_METADATA_TIMEOUT || 30000), { provider: 'youtube', signal });
            tracks = extractEntries(data).slice(0, 1).map(track => ({
                ...track,
                // Playback remains on the existing YouTube-first pipeline, while
                // the original provider identity/artwork survives through lyrics,
                // history, favorites, playlists and Web artwork resolution.
                thumbnail: resolution.thumbnail || track.thumbnail || '',
                linkedProvider: resolution.provider,
                linkedOriginalUrl: resolution.original,
                linkedResolvedUrl: resolution.target,
                linkedThumbnail: resolution.thumbnail || '',
                linkedTitle: resolution.searchQuery,
            }));
        } else if (isUrl(resolution.target)) {
            tracks = await extractUrlMetadata(resolution.target, resolution, playlistLimit, { signal });
        } else {
            const limit = requestedLimit;
            const data = await runYtDlpJson([
                "--dump-single-json",
                "--flat-playlist",
                "--playlist-end", String(limit),
                `ytsearch${limit}:${resolution.target}`,
            ], Number(config.YTDLP_METADATA_TIMEOUT || 30000), { provider: 'youtube', signal });
            tracks = extractEntries(data).slice(0, limit);
        }

        const cap = resolution.mode === "search" ? 1 : (isUrl(resolution.target) ? playlistLimit : requestedLimit);
        const finalTracks = uniqueByKey(tracks || [], t => t.url).slice(0, cap);
        withImportReport(finalTracks, tracks?.importReport && { ...tracks.importReport, returned: finalTracks.length });
        signal?.throwIfAborted(); setCachedSearch(cacheKey, finalTracks);
        return finalTracks;
    })();

    if (!signal && !options.forceRefresh) searchInflight.set(cacheKey, work);
    try {
        return cloneSearchResults(await require('./platformSources').awaitSource(() => work, signal));
    } finally {
        if (searchInflight.get(cacheKey) === work) searchInflight.delete(cacheKey);
    }
}

function secondsToTime(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return [h, m, sec].map(n => String(n).padStart(2, "0")).join(":");
}

function qualityFormat(preferredMode, provider = 'youtube') {
    if (config.YTDLP_AUDIO_FORMAT && String(config.YTDLP_AUDIO_FORMAT).trim()) {
        return String(config.YTDLP_AUDIO_FORMAT).trim();
    }

    const mode = String(preferredMode || config.AUDIO_PIPELINE_MODE || "raw-pcm").toLowerCase();
    const q = String(config.AUDIO_QUALITY || "high").toLowerCase();
    if (String(provider || '').toLowerCase() !== 'youtube') return "bestaudio/best";

    // Only passthrough requires an Opus source. A transcoder should retain
    // yt-dlp's source quality ranking instead of preferring a lower-quality
    // Opus rendition over a better available AAC rendition.
    if (mode === "copy-opus") {
        return "bestaudio[ext=webm][acodec=opus]/bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio[abr>=160]/bestaudio/best";
    }

    if (q === "low") return "bestaudio[abr<=96]/bestaudio/best";
    if (q === "medium") return "bestaudio[abr<=160]/bestaudio/best";
    return "bestaudio/best";
}

function waitForInitialMediaBytes(child, stderrParts, timeoutMs, signal = null) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!child?.stdout) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
        let settled = false;
        const stream = child.stdout;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            stream.removeListener('readable', onReadable);
            child.removeListener('error', onError);
            child.removeListener('close', onClose);
            signal?.removeEventListener('abort', onAbort);
            fn(value);
        };
        const onAbort = () => finish(reject, signal.reason);
        const details = () => compactError((stderrParts || []).join('')) || 'yt-dlp produced no media bytes';
        const onReadable = () => {
            if (stream.readableLength > 0) finish(resolve, true);
        };
        const onError = err => finish(reject, new Error(`[yt-dlp] ${err.message || err}`));
        const onClose = code => {
            if (stream.readableLength > 0) return finish(resolve, true);
            finish(reject, new Error(`[yt-dlp] exited with code ${code ?? 'unknown'} before audio started | ${details()}`));
        };
        const timer = setTimeout(() => {
            void require('./audioDownload').killProcessTree(child);
            finish(reject, new Error(`[yt-dlp] did not produce audio within ${Math.round(timeoutMs / 1000)}s | ${details()}`));
        }, Math.max(5000, Number(timeoutMs) || 18000));
        timer.unref?.();
        stream.on('readable', onReadable);
        child.once('error', onError);
        child.once('close', onClose);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        if (child.exitCode != null && stream.readableLength <= 0) onClose(child.exitCode);
        else onReadable();
    });
}

async function createAudioStream(url, seek = 0, options = {}) {
    const signal = options.signal;
    signal?.throwIfAborted();
    // Stable high-quality pipeline:
    // yt-dlp -> FFmpeg -> either high-bitrate Ogg/Opus or raw PCM fallback.
    // ffmpeg-opus يعطي جودة أوضح من raw-pcm لأن FFmpeg/libopus يتحكم بالترميز بدل ترميز Discord الافتراضي.
    const { StreamType } = require("@discordjs/voice");
    const highWaterMark = Number(config.STREAM_HIGH_WATER_MARK || (1 << 26));
    const mode = String(options.forceMode || config.AUDIO_PIPELINE_MODE || "raw-pcm").toLowerCase();
    const useManualOpus = mode === "hq-opus" || mode === "ultra-opus" || mode === "source-hq" || mode === "opus";
    const useFfmpegOggOpus = mode === "ffmpeg-opus" || mode === "ogg-opus";
    const useCopyOpus = mode === "copy-opus";
    const useSuperPcm = mode === "super-pcm" || mode === "supercharged-pcm";

    const ytStderr = [];
    const ffStderr = [];

    const playbackAttempt = Math.max(1, Number(options.playbackAttempt || 1));
    const playbackProvider = sourceResolver.classifyUrl(url)?.provider || 'generic';
    const playbackClients = playbackProvider === 'youtube' ? playbackClientStrategy(playbackAttempt) : [];
    const args = [
        ...buildCommonArgs({ playbackAttempt, provider: playbackProvider }),
        "--quiet",
        "--no-playlist",
        "-f", qualityFormat(mode, playbackProvider),
        "-o", "-",
    ];

    // لا نستخدم --download-sections هنا، لأن هذا كان يسبب رسالة ffmpeg is not installed.
    args.push(url);

    const localFile = options.localFile && fs.existsSync(options.localFile) ? options.localFile : null;
    const directInput = localFile ? null : (options.inputStream || null);
    const ffmpegPath = getFfmpegPath();
    const baseAudioFilter = resolveAudioFilter(ffmpegPath, config.FFMPEG_AUDIO_FILTER);
    const ytdlp = localFile || directInput ? null : await startYtDlp(args, { signal });
    if (ytdlp) {
        ytdlp.stderr.on("data", chunk => {
            ytStderr.push(chunk.toString());
            if (ytStderr.join("").length > 14000) ytStderr.shift();
        });
    }
    const rawVolume = (options.volume === 0) ? 0 : Number(options.volume || config.DEFAULT_VOLUME || 100);
    const volume = Math.max(0, Math.min(Number(config.MAX_VOLUME || 150), rawVolume));
    const hqPreGainRaw = Number(config.HQ_OPUS_PRE_GAIN || 1);
    const hqPreGain = Math.max(0.50, Math.min(1.00, isFinite(hqPreGainRaw) ? hqPreGainRaw : 0.98));
    const hqVolumeGain = Math.max(0, (volume / 100) * hqPreGain);
    const hqSafeGain = config.HQ_OPUS_LIMIT_GAIN === false ? hqVolumeGain : Math.min(1, hqVolumeGain);

    // Super PCM: نخلي المسار ثابتاً وموثوقاً، لكن نخفض الرأس قليلاً داخل FFmpeg
    // لمنع Digital Clipping في أغاني البيس قبل أن يصل الصوت إلى inlineVolume.
    // عند 90% يبقى المستوى الفعلي 90% تقريباً، وعند 100% لا يتكسر البيس.
    const rawPreGain = Number(config.PCM_PRE_GAIN || 1);
    const pcmPreGain = useSuperPcm ? Math.max(0.50, Math.min(1.00, isFinite(rawPreGain) ? rawPreGain : 0.92)) : 1;
    // Use identical headroom in both encoders. Disabling the live JS gain only
    // disables later changes; the initial gain/mute still belongs before Opus.
    const shouldApplyFfmpegVolume = useFfmpegOggOpus || (useManualOpus && config.HQ_OPUS_LIVE_VOLUME === false);
    const opusGain = hqSafeGain;
    const opusVolumeFilter = shouldApplyFfmpegVolume && opusGain !== 1 ? `volume=${opusGain.toFixed(3)}` : "";
    const pcmHeadroomFilter = useSuperPcm && pcmPreGain !== 1 ? `volume=${pcmPreGain.toFixed(3)}` : "";
    const audioFilter = [baseAudioFilter, pcmHeadroomFilter, opusVolumeFilter].filter(Boolean).join(",");

    // Register the live pipeline before choosing FFmpeg thread counts. On the
    // 6C/6T i5-9400F this dynamically reserves CPU for Discord/audio and shrinks
    // background FFmpeg/Sharp pools only while real-time audio is alive.
    const releaseRealtimeAudio = performanceProfile.beginRealtimeAudio();
    if (ytdlp) performanceProfile.registerChildProcess(ytdlp, 'audio');

    // Do not start FFmpeg until yt-dlp has produced real media bytes. If YouTube
    // rejects a client/format, this converts the old misleading FFmpeg pipe:0
    // "Invalid data" cascade into one clean yt-dlp failure so MusicPlayer can
    // immediately rotate to the next playback client strategy.
    if (ytdlp) {
        try {
            await waitForInitialMediaBytes(
                ytdlp,
                ytStderr,
                Number(config.YTDLP_PLAYBACK_SOURCE_READY_TIMEOUT_MS || 18000), signal,
            );
        } catch (err) {
            await require('./audioDownload').killProcessTree(ytdlp);
            releaseRealtimeAudio();
            throw signal?.aborted ? signal.reason : err;
        }
    }

    let ffmpegArgs;
    if (useCopyOpus) {
        // أقرب شيء للصوت الخام من يوتيوب: تمرير Opus إلى Ogg بدون إعادة ترميز.
        // لا يدعم تغيير الصوت داخلياً؛ استخدم صوت ديسكورد للعضو إذا احتجت.
        ffmpegArgs = [
            "-hide_banner", "-loglevel", "error", "-nostdin",
            "-threads", String(performanceProfile.ffmpegThreads('audio')),
            ...(seek > 0 ? ["-ss", secondsToTime(seek)] : []),
            "-thread_queue_size", "8192",
            "-i", "pipe:0",
            "-vn",
            "-sn", "-dn",
            "-map", "0:a:0",
            "-c:a", "copy",
            "-f", "ogg",
            // A live source must expose packets as they arrive. Ogg otherwise
            // batches up to one second per page and starves a 20 ms consumer.
            "-page_duration", "20000",
            "-flush_packets", "1",
            "pipe:1",
        ];
    } else if (useFfmpegOggOpus) {
        // جودة عالية مستقرة: FFmpeg/libopus يرمز الصوت إلى Opus 48kHz بجودة ممتازة.
        ffmpegArgs = [
            "-hide_banner", "-loglevel", "error", "-nostdin",
            "-threads", String(performanceProfile.ffmpegThreads('audio')),
            "-fflags", "+genpts+discardcorrupt",
            "-thread_queue_size", "8192",
            "-i", "pipe:0",
            ...(seek > 0 ? ["-ss", secondsToTime(seek)] : []),
            "-vn",
            "-sn", "-dn",
            "-map", "0:a:0",
            ...(audioFilter ? ["-af", audioFilter] : []),
            "-ar", "48000",
            "-ac", "2",
            "-c:a", "libopus",
            "-b:a", String(config.OPUS_BITRATE || 384000),
            "-vbr", "on",
            "-compression_level", "10",
            "-application", "audio",
            "-frame_duration", "20",
            "-f", "ogg",
            "-page_duration", "20000",
            "-flush_packets", "1",
            "pipe:1",
        ];
    } else {
        ffmpegArgs = [
            "-hide_banner",
            "-loglevel", "error",
            "-nostdin",
            "-threads", String(performanceProfile.ffmpegThreads('audio')),
            "-fflags", "+genpts+discardcorrupt",
            "-thread_queue_size", "8192",
            "-i", "pipe:0",
            ...(seek > 0 ? ["-ss", secondsToTime(seek)] : []),
            "-vn",
            "-sn", "-dn",
            "-map", "0:a:0",
            // Super PCM: 48kHz stereo PCM ثابت مع headroom اختياري قبل inlineVolume.
            ...(audioFilter ? ["-af", audioFilter] : []),
            "-acodec", "pcm_s16le",
            "-f", "s16le",
            "-ar", "48000",
            "-ac", "2",
            "pipe:1",
        ];
    }

    if (localFile) {
        // Input seeking on a completed local file is immediate. With a pipe,
        // FFmpeg's post-input -ss has to decode everything before the target.
        const oldSeek = ffmpegArgs.indexOf('-ss');
        if (oldSeek >= 0) ffmpegArgs.splice(oldSeek, 2);
        const input = ffmpegArgs.indexOf('-i');
        ffmpegArgs[input + 1] = localFile;
        if (seek > 0) ffmpegArgs.splice(input, 0, '-ss', secondsToTime(seek));
    }
    if (localFile || directInput) {
        // These bytes have already crossed the validated HTTP boundary. Do not
        // let a playlist disguised as a media file trigger more HTTP/file reads.
        ffmpegArgs.splice(ffmpegArgs.indexOf('-i'), 0, ...LOCAL_INPUT_ARGS);
    }
    let ffmpeg;
    try {
        signal?.throwIfAborted();
        ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
            cwd: ROOT_DIR,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        performanceProfile.registerChildProcess(ffmpeg, 'audio');
    } catch (err) {
        await require('./audioDownload').killProcessTree(ytdlp);
        releaseRealtimeAudio();
        throw err;
    }

    let output;
    let encoder = null;
    let pcmBuffer = null;
    let pcmFrameStream = null;

    if (useManualOpus) {
        try {
            const prism = require("prism-media");
            // Keep the large buffer BEFORE the live gain, so source stalls do not
            // starve playback and volume changes cannot be trapped behind minutes
            // of already encoded Opus packets.
            pcmBuffer = new PassThrough({ highWaterMark });
            // Discord advances its RTP timestamp by 960 samples per packet.
            // Legacy 10/40/60 ms settings change playback speed when sent on
            // that fixed 20 ms clock, so keep the voice boundary at 960 samples.
            const frameSize = 960;
            pcmFrameStream = Readable.from(pcmOpusFrames(pcmBuffer, frameSize * 4), { highWaterMark: 1 });
            const volumeTransformer = (config.HQ_OPUS_LIVE_VOLUME === false) ? null : new prism.VolumeTransformer({
                type: "s16le",
                volume: hqSafeGain,
                highWaterMark: frameSize * 8,
            });
            encoder = new prism.opus.Encoder({
                rate: 48000,
                channels: 2,
                frameSize,
                application: "AUDIO",
                readableHighWaterMark: 4,
                writableHighWaterMark: frameSize * 8,
            });
            // Prism's public setBitrate() clamps at 128k; its underlying Opus
            // encoder accepts OPUS_SET_BITRATE_REQUEST without that wrapper cap.
            const nativeEncoder = encoder.encoder;
            const setEncoderCTL = nativeEncoder?.applyEncoderCTL || nativeEncoder?.encoderCTL;
            if (typeof setEncoderCTL !== "function") throw new Error("Opus encoder does not support explicit high-quality bitrate");
            setEncoderCTL.call(nativeEncoder, 4002, Number(config.OPUS_BITRATE || 384000));
            // Each Opus packet must retain its 20 ms chunk boundary for Discord.
            // Eight queued packets are 160 ms; a byte-mode PassThrough would merge
            // packets and corrupt the audio delivered as StreamType.Opus.
            output = new PassThrough({ objectMode: true, highWaterMark: 8 });
            output.discordInputType = StreamType.Opus;
            output.audioPipelineMode = "hq-opus";
            output.volumeTransformer = volumeTransformer;
            output.hqPreGain = hqPreGain;
            output.hqLimitGain = config.HQ_OPUS_LIMIT_GAIN !== false;
            ffmpeg.stdout.pipe(pcmBuffer);
            if (volumeTransformer) {
                pcmFrameStream.pipe(volumeTransformer).pipe(encoder).pipe(output);
            } else {
                pcmFrameStream.pipe(encoder).pipe(output);
            }
        } catch (err) {
            try { pcmFrameStream?.destroy(); } catch (_) {}
            try { pcmBuffer?.destroy(); } catch (_) {}
            try { encoder?.destroy(); } catch (_) {}
            try { ffmpeg.kill("SIGKILL"); } catch (_) {}
            void require('./audioDownload').killProcessTree(ytdlp);
            releaseRealtimeAudio();
            throw err;
        }
    } else if (useFfmpegOggOpus || useCopyOpus) {
        output = new PassThrough({ highWaterMark });
        output.discordInputType = StreamType.OggOpus;
        output.audioPipelineMode = useCopyOpus ? "copy-opus" : "ffmpeg-opus";
        ffmpeg.stdout.pipe(output);
    } else {
        output = new PassThrough({ highWaterMark });
        output.discordInputType = StreamType.Raw;
        output.audioPipelineMode = useSuperPcm ? "super-pcm" : "raw-pcm";
        output.pcmPreGain = useSuperPcm ? pcmPreGain : 1;
        ffmpeg.stdout.pipe(output);
    }

    let ytdlpClosed = false;
    let ffmpegClosed = false;
    let cleaned = false;

    // Keep observing errors after the first packet, including the gap before
    // createAudioResource attaches the stream to Discord's audio player.
    output.pipelineError = null;
    output.on("error", err => { output.pipelineError = err; });

    // Resolve only when audio is actually buffered, without consuming packets.
    // If the pipeline closes before the first packet, reject instead of leaving
    // the startup promise hanging. This makes play failures fast and recoverable.
    output.ready = new Promise((resolve, reject) => {
        let settled = false;
        // Node also emits "readable" at EOF with an empty buffer. Treating
        // that event as audio used to resolve startup, remove the error listener,
        // and let FFmpeg's later failure crash the whole bot.
        const onReadable = () => {
            if (output.readableLength > 0 && !output.pipelineError) finish(resolve, true);
        };
        const onError = err => finish(reject, err);
        const onClose = () => finish(reject, new Error("audio pipeline closed before producing audio"));
        const cleanupReadyListeners = () => {
            output.removeListener("readable", onReadable);
            output.removeListener("error", onError);
            output.removeListener("close", onClose);
        };
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            cleanupReadyListeners();
            fn(value);
        };
        const readyTimeout = Math.max(8000, Number(config.AUDIO_PIPELINE_READY_TIMEOUT_MS || 15000));
        const timeout = setTimeout(() => output.destroy(new Error(`audio pipeline did not produce real audio within ${Math.round(readyTimeout/1000)}s`)), readyTimeout);
        timeout.unref?.();
        output.once("readable", onReadable);
        output.once("error", onError);
        output.once("close", onClose);
    });

    ffmpeg.stderr.on("data", chunk => {
        ffStderr.push(chunk.toString());
        if (ffStderr.join("").length > 14000) ffStderr.shift();
    });

    ytdlp?.stdout.on("error", () => {});
    directInput?.on("error", err => failOnce("direct audio", err.message));
    ffmpeg.stdin.on("error", () => {});
    ffmpeg.stdout.on("error", () => {});
    if (pcmBuffer) pcmBuffer.on("error", err => failOnce("pcm buffer", err.message));
    if (pcmFrameStream) pcmFrameStream.on("error", err => failOnce("pcm frames", err.message));
    if (encoder) encoder.on("error", err => failOnce("opus", err.message));
    if (output.volumeTransformer) output.volumeTransformer.on("error", err => failOnce("volume", err.message));

    if (ytdlp) ytdlp.stdout.pipe(ffmpeg.stdin);
    else if (directInput) directInput.pipe(ffmpeg.stdin);
    else ffmpeg.stdin.end();

    function failOnce(label, text) {
        if (cleaned || output.destroyed) return;
        const yt = compactError(ytStderr.join(""));
        const ff = compactError(ffStderr.join(""));
        const parts = [text, yt ? `yt-dlp: ${yt}` : "", ff ? `ffmpeg: ${ff}` : ""].filter(Boolean);
        output.destroy(new Error(`[${label}] ${parts.join(" | ")}`));
    }

    ytdlp?.on("error", err => failOnce("yt-dlp", err.message));
    ffmpeg.on("error", err => failOnce("ffmpeg", `${err.message}. تأكد أن FFmpeg متاح أو شغّل install.bat.`));

    ytdlp?.on("close", code => {
        ytdlpClosed = true;
        if (code !== 0) {
            try { ffmpeg.kill("SIGKILL"); } catch (_) {}
            failOnce("yt-dlp", `exited with code ${code}`);
        } else {
            try { ffmpeg.stdin.end(); } catch (_) {}
        }
    });

    ffmpeg.on("close", code => {
        ffmpegClosed = true;
        if (code !== 0) {
            failOnce("ffmpeg", `exited with code ${code}`);
        } else if (!output.destroyed) {
            if (!useManualOpus) output.end();
        }
    });

    let cleanupPromise;
    const onAbort = () => output.destroy(signal.reason);
    output.cleanup = () => {
        if (cleaned) return cleanupPromise;
        cleaned = true;
        signal?.removeEventListener('abort', onAbort);
        releaseRealtimeAudio();
        try { ytdlp?.stdout.unpipe(ffmpeg.stdin); } catch (_) {}
        try { directInput?.unpipe(ffmpeg.stdin); } catch (_) {}
        try { ffmpeg.stdout.unpipe(pcmBuffer || output); } catch (_) {}
        try { pcmFrameStream?.unpipe?.(output.volumeTransformer || encoder); } catch (_) {}
        try { output.volumeTransformer?.unpipe?.(encoder); } catch (_) {}
        try { encoder?.unpipe?.(output); } catch (_) {}
        try { ffmpeg.stdin.destroy?.(); } catch (_) {}
        try { ytdlp?.stdout.destroy?.(); } catch (_) {}
        try { directInput?.destroy?.(); } catch (_) {}
        try { ytdlp?.stderr.destroy?.(); } catch (_) {}
        try { ffmpeg.stdout.destroy?.(); } catch (_) {}
        try { ffmpeg.stderr.destroy?.(); } catch (_) {}
        try { pcmBuffer?.destroy?.(); } catch (_) {}
        try { pcmFrameStream?.destroy?.(); } catch (_) {}
        try { output.volumeTransformer?.destroy?.(); } catch (_) {}
        try { encoder?.destroy?.(); } catch (_) {}
        cleanupPromise = Promise.allSettled([
            ytdlp && !ytdlpClosed ? require('./audioDownload').killProcessTree(ytdlp) : Promise.resolve(),
            !ffmpegClosed ? require('./audioDownload').killProcessTree(ffmpeg) : Promise.resolve(),
        ]);
        output.ytdlpProcess = null;
        output.ffmpegProcess = null;
        output.opusEncoder = null;
        output.volumeTransformer = null;
        return cleanupPromise;
    };

    // Natural completion and forced close both release the CPU reservation. The
    // release function is idempotent, so there is no double-decrement race.
    output.once("end", releaseRealtimeAudio);
    // إذا Discord أغلق الـstream لأي سبب، لا نترك yt-dlp أو FFmpeg أحياء في الخلفية.
    output.once("close", () => output.cleanup());

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    output.ytdlpProcess = ytdlp;
    output.ffmpegProcess = ffmpeg;
    output.opusEncoder = encoder;
    output.ytdlpLabel = localFile ? 'seek-cache' : directInput ? 'direct-audio' : ytdlp.__ytDlpLabel;
    output.ytdlpPlaybackAttempt = playbackAttempt;
    output.ytdlpClients = ytdlp ? playbackClients.join(',') : '';
    return output;
}

async function checkAvailability() {
    const info = await getWorkingCandidate(true);
    return { label: info.candidate.label, version: info.version };
}

module.exports = {
    search,
    createAudioStream,
    checkAvailability,
    isDirectAudioUrl,
    runYtDlpJson,
    getWorkingCandidate,
    buildCommonArgs,
    playbackClientStrategy,
    waitForInitialMediaBytes,
    // Pure helpers are exported for deterministic regression tests.
    normalizeEntry,
    extractEntries,
    providerFromEntry,
    qualityFormat,
};
