'use strict';

// A completed original-audio file lets FFmpeg seek at the input instead of
// decoding an entire remote pipe from the beginning for every jump.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const config = require('../config');
const ytDlp = require('./ytDlpProvider');
const performanceProfile = require('./performanceProfile');
const sourceResolver = require('./sourceResolver');

const directory = path.join(require('./dataPaths').dataDirectory(), 'audio-cache');
const active = new Map();
const queue = [];
let running = 0;
let closed = false;
let closePromise = null;
const controllers = new Set();
const concurrency = Math.max(1, Math.min(8, Number(config.AUDIO_CACHE_CONCURRENCY || 6)));
const queueMax = Math.max(2, Math.min(64, Number(config.AUDIO_CACHE_QUEUE_MAX || 12)));

function filename(url) {
    return path.join(directory, `${crypto.createHash('sha256').update(String(url)).digest('hex')}.audio`);
}
function get(url) {
    if (!url) return null;
    const file = filename(url);
    try {
        const stat = fs.statSync(file);
        if (stat.size > 0) return file;
    } catch (_) {}
    return null;
}
async function prune() {
    let files;
    try { files = await fsp.readdir(directory); } catch (_) { return; }
    // Remove abandoned temp downloads left by a power loss or crash.
    await Promise.all(files.filter(x => x.endsWith('.part')).map(async name => {
        const file = path.join(directory, name);
        try {
            const stat = await fsp.stat(file);
            if (Date.now() - stat.mtimeMs > 60 * 60 * 1000) await fsp.rm(file, { force: true });
        } catch (_) {}
    }));
    // Completed audio is user-requested persistent cache. Keep it regardless
    // of size or age; only abandoned partial downloads are cleaned up here.
}
function desiredConcurrency() {
    // While live voice is active, one background cache download is enough. Each
    // yt-dlp download can itself use many fragments, so letting 3 run in parallel
    // can steal bandwidth/IO from the audible stream without improving quality.
    const live = Number(performanceProfile.summary?.().realtimeAudioCount || 0);
    return live > 0 ? 1 : concurrency;
}
function pump() {
    if (closed) return;
    const limit = desiredConcurrency();
    while (running < limit && queue.length) {
        const task = queue.shift();
        running++;
        task().finally(() => { running--; pump(); }).catch(() => {});
    }
}
function prefetch(url) {
    if (closed) return Promise.resolve(null);
    if (!/^https?:\/\//i.test(String(url || ''))) return Promise.resolve(null);
    const existing = get(url);
    if (existing) return Promise.resolve(existing);
    if (active.has(url)) return active.get(url);
    // Rapid skip/jump bursts must not leave hundreds of stale full-track downloads
    // queued for minutes after the listener has moved elsewhere.
    if (queue.length >= queueMax) return Promise.resolve(null);
    const controller = new AbortController();
    controllers.add(controller);
    const work = new Promise(resolve => {
        const task = async () => {
            const target = filename(url);
            const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
            let result = null;
            try {
                await fsp.mkdir(directory, { recursive: true });
                controller.signal.throwIfAborted();
                const { candidate } = await ytDlp.getWorkingCandidate(false, { signal: controller.signal });
                controller.signal.throwIfAborted();
                if (candidate.shell) throw new Error('shell launcher is not supported for background cache');
                const provider = sourceResolver.classifyUrl(url)?.provider || 'generic';
                const args = [...candidate.prefix, ...ytDlp.buildCommonArgs({ provider }), '--no-playlist', '--no-progress', '--no-part',
                    '--socket-timeout', '20', '--retries', '2', '--fragment-retries', '2',
                    '-f', String(config.YTDLP_AUDIO_FORMAT || 'bestaudio/best'), '-o', tmp, url];
                await require('./audioDownload').run(candidate.cmd, args, {
                    cwd: path.join(__dirname, '..'), shell: false, signal: controller.signal,
                    timeoutMs: 8 * 60_000, firstByteTimeoutMs: 0, idleTimeoutMs: 0,
                });
                controller.signal.throwIfAborted();
                const stat = await fsp.stat(tmp);
                if (!stat.size) throw new Error('cache file is empty');
                await fsp.rename(tmp, target);
                result = target;
                void prune();
            } catch (_) {}
            finally { await fsp.rm(tmp, { force: true }).catch(() => {}); active.delete(url); controllers.delete(controller); resolve(result); }
        };
        task.cancel = () => { controller.abort(); controllers.delete(controller); active.delete(url); resolve(null); };
        queue.push(task);
        pump();
    });
    active.set(url, work);
    return work;
}

function close() {
    if (closePromise) return closePromise;
    closed = true;
    for (const task of queue.splice(0)) task.cancel();
    for (const controller of controllers) controller.abort();
    closePromise = Promise.allSettled([...active.values()]).then(() => {});
    return closePromise;
}

void prune().catch(() => {});

module.exports = { get, prefetch, prune, close, filename, _test: { queue, active, desiredConcurrency, queueMax } };
