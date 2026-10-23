'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const config = require('../config');
const { resolveFfmpegPath } = require('./ffmpegResolver');
const performanceProfile = require('./performanceProfile');
const net = require('node:net');
const { privateAddress } = require('./platformMedia');
const { downloadPublicMedia } = require('./publicMedia');
const { LOCAL_INPUT_ARGS } = require('./uploadsStore');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

function isYoutubeUrl(input) {
    try { return /(^|\.)((youtube\.com)|(youtu\.be))$/i.test(new URL(String(input)).hostname); }
    catch (_) { return false; }
}

function buildSourceArgs({ url, output, ffmpegPath, playerClient = null, format, kind = 'audio', original = true, maxBytes = 0 }) {
    const args = [
        '--ignore-config', '--no-playlist', '--no-warnings', '--newline', '--progress', '--progress-delta', '1', '--part', '--no-overwrites',
        '--windows-filenames', '--restrict-filenames', '--geo-bypass',
        '--js-runtimes', `node:${process.execPath}`, '--force-ipv4',
        '--user-agent', String(config.YTDLP_USER_AGENT || DEFAULT_UA),
        '--retries', '1', '--fragment-retries', '2', '--extractor-retries', '1', '--file-access-retries', '2',
        '--retry-sleep', 'http:1', '--retry-sleep', 'fragment:1',
        '--socket-timeout', String(Math.max(5, Math.min(20, Number(config.YTDLP_SOCKET_TIMEOUT) || 20))),
        '--concurrent-fragments', String(Math.max(1, Math.min(4, Number(config.YTDLP_CONCURRENT_FRAGMENTS) || 4))),
        '--progress-template', 'download:ASTRA_PROGRESS|%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress._total_bytes_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(info.format_id)s|%(progress.filename)s',
        '--progress-template', 'postprocess:ASTRA_POSTPROCESS|%(progress.status)s',
        '--print', 'before_dl:ASTRA_FORMAT|%(format_id)s',
        '--format', String(format || (kind === 'video' ? 'bestvideo*+bestaudio/best' : 'ba/b')),
        '--print', 'after_move:ASTRA_FILE|%(filepath)s', '--print', 'after_move:ASTRA_TITLE|%(title)s', '--output', output,
    ];
    if (kind === 'video') args.push('--merge-output-format', 'webm/mp4/mkv');
    if (!original && kind === 'audio') args.push('--no-keep-video', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0', '--embed-metadata');
    if (maxBytes > 0) args.push('--max-filesize', String(maxBytes));
    if (isYoutubeUrl(url)) args.push('--referer', 'https://www.youtube.com/');
    if (ffmpegPath) args.push('--ffmpeg-location', ffmpegPath);
    if (config.YTDLP_COOKIES_PATH) args.push('--cookies', config.YTDLP_COOKIES_PATH);
    else if (config.YTDLP_COOKIES_FROM_BROWSER) args.push('--cookies-from-browser', config.YTDLP_COOKIES_FROM_BROWSER);
    // An absent client argument lets the installed yt-dlp select its current
    // automatic clients; explicit alternatives are used only after a failure.
    if (isYoutubeUrl(url) && playerClient && playerClient !== 'default') args.push('--extractor-args', `youtube:player_client=${playerClient}`);
    args.push('--', url);
    return args;
}

function buildAudioArgs(options) { return buildSourceArgs({ ...options, kind: 'audio', original: false }); }

function chooseBitrate(maxBytes, durationSeconds) {
    const suggested = Math.floor(maxBytes * 8 * 0.86 / Math.max(1, durationSeconds) / 1000);
    return Math.max(96, Math.min(320, suggested));
}

async function spotifyMetadata(url, { signal } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    try {
        const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
        if (!response.ok) throw new Error(`Spotify metadata HTTP ${response.status}`);
        return await response.json();
    } finally { clearTimeout(timeout); }
}

async function resolveSourceUrl(raw, { metadata = spotifyMetadata, search, signal } = {}) {
    signal?.throwIfAborted();
    let parsed;
    try { parsed = new URL(String(raw || '').trim()); }
    catch (_) { throw new Error('Enter a valid track URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) music URLs are supported.');
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || /\.(?:localhost|local|internal)$/.test(host) || (net.isIP(host) && privateAddress(host))) {
        throw new Error('Private network URLs cannot be downloaded.');
    }
    if (!/(^|\.)spotify\.com$/i.test(parsed.hostname)) return parsed.href;
    if (!/^\/track\/[A-Za-z0-9]+/.test(parsed.pathname)) throw new Error('Paste a Spotify track URL, not a playlist or album URL.');
    const info = await require('./platformSources').awaitSource(() => metadata(parsed.href, { signal }), signal);
    const title = String(info?.title || '').trim();
    if (!title) throw new Error('Spotify track metadata is unavailable.');
    const provider = search || require('./ytDlpProvider').search;
    const results = await require('./platformSources').awaitSource(() => provider(`${info.author_name || ''} ${title}`, { limit: 5, signal }), signal);
    const match = results.find(x => /^https?:\/\//.test(x.url || ''));
    if (!match) throw new Error('Could not find a playable source for this Spotify track.');
    return match.url;
}

async function ytdlpCommand(forceRefresh = false, options = {}) {
    const { candidate } = await require('./ytDlpProvider').getWorkingCandidate(forceRefresh, options);
    if (candidate.shell) throw new Error('Use the bundled yt-dlp.exe or a Python installation for audio downloads.');
    return { command: candidate.cmd, prefix: candidate.prefix, shell: candidate.shell };
}

function cancelledDownload() {
    const error = new Error('Audio download cancelled.');
    error.name = 'AbortError'; error.code = 'ABORT_ERR';
    return error;
}

function abortReason(signal) {
    const reason=signal?.reason;
    if(!reason)return cancelledDownload();
    if(reason.name==='AbortError'&&reason.code!=='ABORT_ERR'){const error=cancelledDownload();error.cause=reason;return error;}
    return reason;
}

const processTreeKills = new WeakMap();
function killProcessTree(child) {
    if (!child || (typeof child !== 'object' && typeof child !== 'function')) return Promise.resolve();
    const existing = processTreeKills.get(child);
    if (existing) return existing;
    const work = killProcessTreeOnce(child);
    processTreeKills.set(child, work);
    return work;
}

function killProcessTreeOnce(child) {
    if (!child?.pid) {try{child?.kill('SIGKILL');}catch(_){}return Promise.resolve();}
    if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
        return Promise.resolve();
    }
    return new Promise(resolve => {
        let killer, done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch (_) {} resolve(); };
        const timer = setTimeout(finish, 1200); timer.unref?.();
        try { killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' }); }
        catch (_) { finish(); return; }
        killer.once('error', finish); killer.once('close', finish);
    });
}

function run(command, args, { cwd, timeoutMs = 10 * 60 * 1000, firstByteTimeoutMs = 35_000, idleTimeoutMs = 90_000, onProgress, shell = false, cpuKind = 'background', signal, maxOutputBytes = 32 * 1024 * 1024, allowNonzeroExit = false } = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortReason(signal));
        // FFmpeg descendants inherit yt-dlp's process group. Killing the whole
        // group also closes pipes held open by a descendant after its parent exits.
        const child = spawn(command, args, { cwd, windowsHide: true, shell, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        performanceProfile.registerChildProcess(child, cpuKind);
        let finalExitCode = null;
        let detail = '', stdout = '', stderr = '', finalPath = '', finalTitle = '', settled = false, stopping = false, stage = '', stageBytes = 0, firstTimer, idleTimer;
        const carries = new Map();
        const deadlineError = (message, code) => Object.assign(new Error(message), { code });
        const timer = setTimeout(() => stop(deadlineError('Media download timed out at the overall deadline.', 'MEDIA_TOTAL_TIMEOUT')), Math.max(1, timeoutMs));
        timer.unref?.();
        function firstDeadline() {
            clearTimeout(firstTimer); clearTimeout(idleTimer);
            if (firstByteTimeoutMs > 0) { firstTimer = setTimeout(() => stop(deadlineError('The source did not produce its first media bytes in time.', 'MEDIA_FIRST_BYTE_TIMEOUT')), firstByteTimeoutMs); firstTimer.unref?.(); }
        }
        function newStage(key) {
            if (stage === key) return;
            stage = key; stageBytes = 0; firstDeadline();
        }
        function bytesMoved(bytes) {
            if (!Number.isFinite(bytes) || bytes <= stageBytes) return;
            stageBytes = bytes; clearTimeout(firstTimer); clearTimeout(idleTimer);
            if (idleTimeoutMs > 0) { idleTimer = setTimeout(() => stop(deadlineError('Media download stalled without new bytes.', 'MEDIA_IDLE_TIMEOUT')), idleTimeoutMs); idleTimer.unref?.(); }
        }
        function lineRead(line) {
            if (line.startsWith('ASTRA_FILE|')) { finalPath = line.slice(11).trim(); clearTimeout(firstTimer); clearTimeout(idleTimer); }
            if (line.startsWith('ASTRA_TITLE|')) finalTitle = line.slice(12).trim();
            if (line.startsWith('ASTRA_FORMAT|')) newStage(line.slice(13).trim());
            const destination = line.match(/^\[download\]\s+Destination:\s*(.+)$/);
            if (destination) newStage(destination[1].trim());
            const custom = line.match(/^ASTRA_PROGRESS\|\s*([0-9.]+)%?/);
            const legacy = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
            if (line.startsWith('ASTRA_PROGRESS|')) {
                const fields = line.split('|');
                if (fields[6] || fields[7]) newStage(`${fields[6] || ''}|${fields[7] || ''}`);
                bytesMoved(Number(fields[2]));
            }
            if (custom || legacy) onProgress?.(Number((custom || legacy)[1]));
            // A post-processing stage may be healthy while FFmpeg has no download
            // counter. The overall deadline still bounds this stage.
            if (line.startsWith('ASTRA_POSTPROCESS|') || /^\[(?:Merger|VideoRemuxer|ExtractAudio|Metadata|Fixup\w*)\]/.test(line)) { clearTimeout(firstTimer); clearTimeout(idleTimer); }
            detail = (detail + '\n' + line).slice(-8000);
        }
        function flush() { for (const [stream, carry] of carries) { if (carry) lineRead(carry); carries.set(stream, ''); } }
        function finish(err) {
            if (settled) return;
            settled = true; clearTimeout(timer); clearTimeout(firstTimer); clearTimeout(idleTimer);
            signal?.removeEventListener('abort', abort);
            if (err) reject(err); else resolve({ finalPath, finalTitle, detail, stdout, stderr, exitCode: finalExitCode });
        }
        function stop(error) {
            if (settled || stopping) return; stopping = true;
            void killProcessTree(child).finally(() => {
                child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); finish(error);
            });
        }
        const abort = () => stop(abortReason(signal));
        for (const stream of [child.stdout, child.stderr]) {
            carries.set(stream, '');
            stream.on('data', chunk => {
                const value = chunk.toString();
                if (stream === child.stdout) { stdout += value; if (Buffer.byteLength(stdout) > maxOutputBytes) { stop(new Error('yt-dlp metadata exceeded the output limit.')); return; } }
                else stderr = (stderr + value).slice(-32768);
                const parts = (carries.get(stream) + value).split(/\r|\n/); carries.set(stream, (parts.pop() || '').slice(-65536));
                for (const line of parts) lineRead(line);
            });
            stream.on('error', () => {});
            stream.once('end', () => { const carry = carries.get(stream); if (carry) lineRead(carry); carries.set(stream, ''); });
        }
        child.once('error', finish);
        child.once('close', code => { finalExitCode = code; flush(); if (!stopping) finish(code === 0 || allowNonzeroExit ? null : new Error(`yt-dlp exited ${code}: ${detail.slice(-2000)}`)); });
        firstDeadline();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
    });
}

let active = 0;
const pending = [];
async function slot(job, signal) {
    signal?.throwIfAborted();
    if (active >= 3) await new Promise((resolve, reject) => {
        const release = () => signal?.removeEventListener('abort', abort);
        const waiter = { resolve: () => { release(); resolve(); }, reject: error => { release(); reject(error); } };
        const abort = () => { const index = pending.indexOf(waiter); if (index >= 0) { pending.splice(index, 1); waiter.reject(abortReason(signal)); } };
        pending.push(waiter); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    }); else active++;
    try { signal?.throwIfAborted(); return await job(); }
    finally { const next = pending.shift(); if (next) next.resolve(); else active--; }
}

function errorText(err) {
    return String(err?.message || err || '').toLowerCase();
}

function isPermanentDownloadError(err) {
    const text = errorText(err);
    return /unsupported url|video unavailable|this video is unavailable|private video|private track|members-only|login required|requires (?:authentication|login)|sign[ -]?in to|not a bot|authentication required|copyright|removed by the uploader|not available in your country|geo restricted/.test(text);
}

function shouldRotateDownloadStrategy(err) {
    const text = errorText(err);
    // A 403/format/client failure is usually tied to the current YouTube client
    // or delivery method. Repeating the identical request wastes time; rotate
    // immediately to another client/format instead.
    return /http(?: error)?\s*403|forbidden|unable to download video data|requested format is not available|no video formats found|missing a url|sabr|po token|signature extraction|nsig extraction/.test(text);
}

function isRetryableDownloadError(err) {
    if (isPermanentDownloadError(err) || err?.name === 'AbortError' || ['ABORT_ERR', 'MEDIA_TOTAL_TIMEOUT'].includes(err?.code)) return false;
    const text = errorText(err);
    return shouldRotateDownloadStrategy(err) || /http(?: error)?\s*429|too many requests|timed out|timeout|first media bytes|stalled|fragment|connection reset|remote end closed|temporary failure|network is unreachable|connection aborted/.test(text);
}

function downloadStrategies(source, { kind = 'audio' } = {}) {
    const format = kind === 'video' ? 'bestvideo*+bestaudio/best' : 'ba/b';
    if (!isYoutubeUrl(source)) return [{ name: 'native-source', playerClient: null, format }];
    const configured = Array.isArray(config.YTDLP_DOWNLOAD_PLAYER_CLIENTS) ? config.YTDLP_DOWNLOAD_PLAYER_CLIENTS : [];
    const clients = [...new Set(['default', 'android', 'web_safari', ...configured].map(value => String(value || '').trim().toLowerCase()).filter(Boolean))].slice(0, 6);
    return clients.flatMap(playerClient => {
        if (playerClient !== 'web_safari') return [{ name: playerClient === 'default' ? 'automatic' : playerClient, playerClient, format }];
        const hls = kind === 'video' ? 'bestvideo*[protocol*=m3u8]+bestaudio[protocol*=m3u8]/best[protocol*=m3u8]/bestvideo*+bestaudio/best' : 'ba[protocol*=m3u8][acodec!=none]/ba[protocol*=m3u8]/ba/b';
        return [{ name: 'web-safari-hls', playerClient, format: hls }, { name: 'web-safari', playerClient, format }];
    });
}

async function cleanupSourceAttempt(dir, kind) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.filter(entry => entry.isFile() && entry.name.startsWith(kind + '.')).map(entry => fs.rm(path.join(dir, entry.name), { force: true })));
}

async function downloadWithStrategies({ url, output, kind = 'audio', original = true, ffmpegPath = resolveFfmpegPath(), maxBytes = 0, command, runner = run, cwd = path.dirname(output), onProgress, signal,
    resolutionTimeoutMs = 90_000, timeoutMs = 10 * 60_000, firstByteTimeoutMs = 35_000, idleTimeoutMs = 90_000 } = {}) {
    signal?.throwIfAborted();
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new Error('yt-dlp candidate resolution timed out.')), Math.max(1, resolutionTimeoutMs)); timer.unref?.();
    const resolving = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let binary;
    try {
        binary = command || await require('./platformSources').awaitSource(() => ytdlpCommand(false, { signal: resolving, timeoutMs: resolutionTimeoutMs }), resolving);
        resolving.throwIfAborted();
    } finally { clearTimeout(timer); }
    if (binary.shell) throw new Error('Media requires a yt-dlp executable or Python yt-dlp.');
    const started = Date.now(); let lastError;
    for (const strategy of downloadStrategies(url, { kind })) {
        signal?.throwIfAborted();
        const remaining = timeoutMs - (Date.now() - started);
        if (remaining <= 0) throw Object.assign(new Error('Media download timed out at the overall deadline.'), { code: 'MEDIA_TOTAL_TIMEOUT' });
        await cleanupSourceAttempt(cwd, kind);
        try {
            const args = buildSourceArgs({ url, output, kind, original, ffmpegPath, maxBytes, playerClient: strategy.playerClient, format: strategy.format });
            const result = await runner(binary.command, [...(binary.prefix || []), ...args], { cwd, onProgress, shell: false, cpuKind: 'background', signal, timeoutMs: remaining, firstByteTimeoutMs, idleTimeoutMs });
            return { ...result, strategy: strategy.name };
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            err.message = `[${strategy.name}] ${err.message}`; lastError = err;
            if (signal?.aborted || err.name === 'AbortError' || err.code === 'ABORT_ERR') throw signal?.aborted ? abortReason(signal) : err;
            if (isPermanentDownloadError(err) || !isRetryableDownloadError(err) || err.code === 'MEDIA_TOTAL_TIMEOUT') throw err;
            // A retryable source/client error advances to a different strategy.
            // Every attempt re-extracts the same identity and obtains fresh CDN URLs.
        }
    }
    throw lastError || new Error('No download strategy returned playable media.');
}

async function downloadAudio(url, { title = 'Music', maxBytes = 20 * 1024 * 1024, duration = 0, onProgress, command, runner = run, signal } = {}) {
    return slot(async () => {
        if (signal?.aborted) throw cancelledDownload();
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'music-audio-'));
        const cleanup = () => fs.rm(dir, { recursive: true, force: true });
        try {
            const source = await resolveSourceUrl(url, { signal });
            const output = path.join(dir, 'audio.%(ext)s');
            const ffmpeg = resolveFfmpegPath();
            let result = null;
            if (!require('./platformSources').isSourceUrl(source)) {
                const input = path.join(dir, 'source.media');
                await downloadPublicMedia(source, { path: input, signal, onProgress: progress => {
                    if (progress.totalBytes > 0) onProgress?.(Math.min(100, progress.downloadedBytes / progress.totalBytes * 100));
                } });
                const expected = path.join(dir, 'audio.mp3');
                await performanceProfile.runHeavy('audio-download-transcode', () => runner(ffmpeg, [
                    '-hide_banner', '-loglevel', 'error', '-y',
                    ...LOCAL_INPUT_ARGS,
                    '-i', input, '-vn', '-sn', '-dn', '-map', '0:a:0',
                    '-threads', String(performanceProfile.ffmpegThreads('heavy')),
                    '-c:a', 'libmp3lame', '-q:a', '0', expected,
                ], { cwd: dir, onProgress, cpuKind: 'heavy', signal, firstByteTimeoutMs: 0, idleTimeoutMs: 0 }));
                result = { finalPath: expected, finalTitle: title };
            } else {
            result = await downloadWithStrategies({ url: source, output, kind: 'audio', original: false, ffmpegPath: ffmpeg, command, runner, cwd: dir, onProgress, signal });
            }
            if (!result) throw new Error('Audio download failed.');

            const expected = path.join(dir, 'audio.mp3');
            const announced = result.finalPath
                ? (path.isAbsolute(result.finalPath) ? path.normalize(result.finalPath) : path.resolve(dir, result.finalPath))
                : expected;
            if (path.normalize(announced) !== path.normalize(expected)) throw new Error('Unexpected download output path.');
            let size = (await fs.stat(expected)).size;
            if (size <= 0) throw new Error('The downloaded audio file is empty.');
            const requestedLimit = Number(maxBytes);
            const allowed = requestedLimit === 0 ? Infinity
                : Math.max(1_000_000, Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 20 * 1024 * 1024);
            let selected = expected;
            if (size > allowed) {
                const rates = duration > 0 ? [chooseBitrate(allowed, duration), 192, 160, 128, 96] : [192, 160, 128, 96];
                for (const rate of [...new Set(rates)]) {
                    const fitted = path.join(dir, `fitted-${rate}.mp3`);
                    await performanceProfile.runHeavy('audio-download-transcode', () => runner(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mp3', '-i', expected, '-vn', '-threads', String(performanceProfile.ffmpegThreads('heavy')), '-c:a', 'libmp3lame', '-b:a', `${rate}k`, fitted], { cwd: dir, timeoutMs: 8 * 60 * 1000, cpuKind: 'heavy', signal, firstByteTimeoutMs: 0, idleTimeoutMs: 0 }));
                    size = (await fs.stat(fitted)).size;
                    if (size <= allowed) { selected = fitted; break; }
                }
                if (selected === expected) throw new Error('This song exceeds the Discord attachment limit even after audio compression.');
            }
            const safeName = String(title === 'Music' ? result.finalTitle || title : title).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 90) || 'Music';
            return { path: selected, size, filename: `${safeName}.mp3`, cleanup, compressed: selected !== expected };
        } catch (err) { await cleanup(); throw err; }
    }, signal);
}

module.exports = { buildSourceArgs, downloadWithStrategies, killProcessTree, buildAudioArgs, chooseBitrate, resolveSourceUrl, downloadAudio, run, downloadStrategies, isRetryableDownloadError, shouldRotateDownloadStrategy, isPermanentDownloadError };
