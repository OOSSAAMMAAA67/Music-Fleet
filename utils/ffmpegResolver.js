const { spawnSync } = require("child_process");
const config = require("../config");

let cachedPath = null;
const audioFilterSupport = new Map();
const compatibleDefaultFilter = "aresample=48000:async=1:first_pts=0";

function canRun(candidate) {
    if (!candidate) return false;
    try {
        const out = spawnSync(candidate, ["-version"], {
            windowsHide: true,
            encoding: "utf8",
            timeout: 4000,
        });
        return !out.error && out.status === 0;
    } catch (_) {
        return false;
    }
}

function resolveFfmpegPath(forceRefresh = false) {
    if (cachedPath && !forceRefresh) return cachedPath;

    const candidates = [];
    if (config.FFMPEG_PATH) candidates.push(config.FFMPEG_PATH);
    if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);

    try {
        const modernStatic = require("ffmpeg-static");
        if (modernStatic) candidates.push(modernStatic);
    } catch (_) {}

    try {
        const installer = require("@ffmpeg-installer/ffmpeg");
        if (installer?.path) candidates.push(installer.path);
    } catch (_) {}

    candidates.push("ffmpeg");

    const seen = new Set();
    for (const candidate of candidates) {
        const key = String(candidate || "");
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (canRun(candidate)) {
            cachedPath = candidate;
            process.env.FFMPEG_PATH = candidate;
            return candidate;
        }
    }

    cachedPath = candidates.find(Boolean) || "ffmpeg";
    return cachedPath;
}

function resolveAudioFilter(ffmpegPath, requestedFilter) {
    const filter = String(requestedFilter || "").trim();
    if (!/(?:^|:)resampler=soxr(?=:|,|$)/i.test(filter)) return filter;

    // Older config.js files requested SoXR, which is missing from some Windows
    // FFmpeg builds. Check the executable that will actually play the song.
    const key = `${ffmpegPath}\0${filter}`;
    if (audioFilterSupport.has(key)) return audioFilterSupport.get(key);
    const probe = spawnSync(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", "pipe:0",
        "-af", filter, "-ar", "48000", "-ac", "2", "-f", "null", "-",
    ], {
        input: Buffer.alloc(4410 * 4), // 100 ms of real 44.1 kHz stereo PCM
        windowsHide: true,
        timeout: 5000,
    });
    const chosen = !probe.error && probe.status === 0 ? filter : compatibleDefaultFilter;
    if (chosen !== filter) {
        console.warn("[Audio] this FFmpeg build cannot run the configured SoXR filter; using its built-in 48 kHz resampler.");
    }
    audioFilterSupport.set(key, chosen);
    return chosen;
}

module.exports = { resolveFfmpegPath, resolveAudioFilter };
