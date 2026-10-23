'use strict';

const os = require('node:os');
const config = require('../config');

const detectedThreads = Math.max(1, Number(os.availableParallelism?.() || os.cpus()?.length || 1));
const configuredThreads = Math.max(1, Number(config.PERFORMANCE_LOGICAL_THREADS || detectedThreads));
const logicalThreads = Math.max(1, Math.min(configuredThreads, detectedThreads || configuredThreads));
const reservedThreads = Math.max(1, Math.min(logicalThreads - 1 || 1, Number(config.PERFORMANCE_RESERVED_THREADS || 1)));
const heavyThreadsIdle = Math.max(1, Math.min(logicalThreads, Number(config.PERFORMANCE_HEAVY_THREADS || Math.max(1, logicalThreads - reservedThreads))));
const audioThreadsMax = Math.max(1, Math.min(logicalThreads, Number(config.PERFORMANCE_AUDIO_THREADS || Math.min(6, logicalThreads))));
const sharpThreadsIdle = Math.max(1, Math.min(logicalThreads, Number(config.PERFORMANCE_SHARP_THREADS || heavyThreadsIdle)));
const uvThreads = Math.max(4, Math.min(1024, Number(config.PERFORMANCE_UV_THREADS || Math.max(8, logicalThreads))));
const sharpCacheMb = Math.max(128, Math.min(2048, Number(config.PERFORMANCE_SHARP_CACHE_MB || 1024)));
const heavyJobConcurrency = Math.max(1, Math.min(2, Number(config.PERFORMANCE_HEAVY_JOB_CONCURRENCY || 1)));

let applied = false;
let sharpModule = null;
let sharpAppliedThreads = 0;
let realtimeAudioCount = 0;
let heavyRunning = 0;
const heavyQueue = [];
const trackedProcesses = new Map();

function audioThreadsForLoad() {
    if (realtimeAudioCount <= 0) return audioThreadsMax;
    // Give each active stream a fair slice of the available logical CPUs, up to
    // the configured per-stream cap. This scales across rooms without faking cores.
    const available = Math.max(1, logicalThreads - reservedThreads);
    const fairShare = Math.max(1, Math.floor(available / realtimeAudioCount));
    return Math.max(1, Math.min(audioThreadsMax, fairShare));
}

function activeAudioCpuBudget() {
    if (realtimeAudioCount <= 0) return 0;
    return Math.min(Math.max(0, logicalThreads - reservedThreads), audioThreadsForLoad() * realtimeAudioCount);
}

function backgroundCpuBudget() {
    return Math.max(1, logicalThreads - reservedThreads - activeAudioCpuBudget());
}

function heavyThreadsForLoad() {
    if (realtimeAudioCount <= 0) return heavyThreadsIdle;
    return Math.max(1, Math.min(heavyThreadsIdle, backgroundCpuBudget()));
}

function sharpThreadsForLoad() {
    if (realtimeAudioCount <= 0) return sharpThreadsIdle;
    return Math.max(1, Math.min(sharpThreadsIdle, backgroundCpuBudget()));
}

function configureSharp(sharp) {
    if (!sharp) return false;
    try {
        sharpModule = sharp;
        const desired = sharpThreadsForLoad();
        if (sharpAppliedThreads !== desired) {
            sharp.concurrency(desired);
            sharpAppliedThreads = desired;
        }
        sharp.cache({ memory: sharpCacheMb, files: 64, items: 1200 });
        return true;
    } catch (_) {
        return false;
    }
}

function refreshSharpBudget() {
    if (!sharpModule) return;
    try { configureSharp(sharpModule); } catch (_) {}
}

function beginRealtimeAudio() {
    realtimeAudioCount++;
    refreshSharpBudget();
    rebalanceTrackedProcesses();
    let released = false;
    return () => {
        if (released) return false;
        released = true;
        realtimeAudioCount = Math.max(0, realtimeAudioCount - 1);
        refreshSharpBudget();
        rebalanceTrackedProcesses();
        pumpHeavyQueue();
        return true;
    };
}

function priorityValue(name) {
    const table = os.constants?.priority || {};
    if (name === 'above') return table.PRIORITY_ABOVE_NORMAL;
    if (name === 'below') return table.PRIORITY_BELOW_NORMAL;
    return table.PRIORITY_NORMAL;
}

function desiredChildPriority(kind) {
    if (kind === 'audio') return priorityValue('above');
    if (kind === 'heavy') return priorityValue(realtimeAudioCount > 0 ? 'below' : 'normal');
    return priorityValue('below');
}

function applyTrackedPriority(record) {
    if (!record?.pid) return false;
    const value = desiredChildPriority(record.kind);
    if (typeof value !== 'number') return false;
    try {
        os.setPriority(record.pid, value);
        record.priority = value;
        return true;
    } catch (_) {
        return false;
    }
}

function rebalanceTrackedProcesses() {
    for (const record of trackedProcesses.values()) applyTrackedPriority(record);
}

function registerChildProcess(child, kind = 'background') {
    const pid = Number(child?.pid || 0);
    if (!pid) return child;
    const existing = trackedProcesses.get(pid);
    if (existing) {
        existing.kind = String(kind || existing.kind || 'background');
        applyTrackedPriority(existing);
        return child;
    }
    const record = { pid, kind: String(kind || 'background'), priority: null };
    trackedProcesses.set(pid, record);
    applyTrackedPriority(record);
    const cleanup = () => trackedProcesses.delete(pid);
    child.once?.('close', cleanup);
    child.once?.('exit', cleanup);
    return child;
}

function applyProcessPriority() {
    if (config.PERFORMANCE_ABOVE_NORMAL_PRIORITY === false) return false;
    try {
        const p = os.constants?.priority?.PRIORITY_ABOVE_NORMAL;
        if (typeof p === 'number') {
            os.setPriority(0, p);
            return true;
        }
    } catch (_) {}
    return false;
}

function applyEarlyRuntime() {
    if (applied) return summary();
    applied = true;
    // libuv reads this lazily when its worker pool is first used. index.js calls
    // this before Discord/Sharp/crypto-heavy modules are loaded.
    if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = String(uvThreads);
    applyProcessPriority();
    try { configureSharp(require('sharp')); } catch (_) {}
    return summary();
}

function ffmpegThreads(kind = 'heavy') {
    return kind === 'audio' ? audioThreadsForLoad() : heavyThreadsForLoad();
}

function ffmpegFilterThreads(kind = 'heavy') {
    if (kind === 'audio') return Math.max(1, Math.min(ffmpegThreads('audio'), 2));
    // Filter + codec pools can run at the same time. Keep the filter pool one step
    // smaller while live audio is active so the main event loop always has room.
    const heavy = ffmpegThreads('heavy');
    if (realtimeAudioCount > 0) return Math.max(1, Math.min(heavy, 2));
    return Math.max(1, Math.min(heavy, 4));
}

function pumpHeavyQueue() {
    while (heavyRunning < heavyJobConcurrency && heavyQueue.length) {
        const next = heavyQueue.shift();
        heavyRunning++;
        Promise.resolve()
            .then(next.job)
            .then(next.resolve, next.reject)
            .finally(() => {
                heavyRunning--;
                pumpHeavyQueue();
            });
    }
}

function runHeavy(label, job) {
    if (typeof job !== 'function') return Promise.reject(new TypeError('job must be a function'));
    return new Promise((resolve, reject) => {
        heavyQueue.push({ label: String(label || 'heavy'), job, resolve, reject });
        pumpHeavyQueue();
    });
}

function summary() {
    return {
        profile: String(config.PERFORMANCE_PROFILE || 'auto'),
        detectedThreads,
        logicalThreads,
        reservedThreads,
        heavyThreads: heavyThreadsIdle,
        heavyThreadsActive: heavyThreadsForLoad(),
        audioThreads: audioThreadsMax,
        audioThreadsActive: audioThreadsForLoad(),
        sharpThreads: sharpThreadsIdle,
        sharpThreadsActive: sharpThreadsForLoad(),
        uvThreads,
        sharpCacheMb,
        heavyJobConcurrency,
        realtimeAudioCount,
        trackedChildProcesses: trackedProcesses.size,
        totalMemoryGb: Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10,
    };
}

module.exports = {
    applyEarlyRuntime,
    configureSharp,
    beginRealtimeAudio,
    registerChildProcess,
    ffmpegThreads,
    ffmpegFilterThreads,
    runHeavy,
    summary,
};
