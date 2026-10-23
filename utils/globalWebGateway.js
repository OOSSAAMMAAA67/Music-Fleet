'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const config = require('../config');
const performanceProfile = require('./performanceProfile');

const ROOT = path.join(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'bin');
const DEFAULT_VERSION = '2026.9.3';
const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/ig;
const CONNECTED_RE = /registered tunnel connection|tunnel connection[^\n]*registered/i;

// Pinned official Cloudflare release assets + SHA-256. Keeping the binary pinned
// makes install reproducible and lets us verify downloads before execution.
const RELEASE_ASSETS = {
    'win32-x64': {
        file: 'cloudflared.exe',
        asset: 'cloudflared-windows-amd64.exe',
        sha256: 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2',
    },
    'win32-ia32': {
        file: 'cloudflared.exe',
        asset: 'cloudflared-windows-386.exe',
        sha256: '9b95ddc2eba67b86ed3dc4cc2a15881960563031b52ce564376af41fb91ad402',
    },
    'linux-x64': {
        file: 'cloudflared',
        asset: 'cloudflared-linux-amd64',
        sha256: '77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2',
    },
    'linux-arm64': {
        file: 'cloudflared',
        asset: 'cloudflared-linux-arm64',
        sha256: 'aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d',
    },
};

let child = null;
let stopping = false;
let publicUrl = '';
let startPromise = null;
let restartTimer = null;
let restartAttempt = 0;
let activeOptions = null;
let ensurePromise = null;
let startController = null;
const intentionalStops = new WeakSet();

function startupCancelled() {
    return Object.assign(new Error('Cloudflare tunnel startup was cancelled'), { code: 'ABORT_ERR' });
}

function waitWithCancellation(work, signal) {
    if (signal?.aborted) return Promise.reject(startupCancelled());
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(startupCancelled());
        signal?.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(work).then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));
    });
}

function boolEnv(name, fallback) {
    const raw = String(process.env[name] || '').trim().toLowerCase();
    if (!raw) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(raw);
}

function globalAccessEnabled() {
    return boolEnv('WEB_PLAYER_GLOBAL_ACCESS', config.WEB_PLAYER_GLOBAL_ACCESS !== false);
}

function quickTunnelEnabled() {
    return boolEnv('WEB_PLAYER_QUICK_TUNNEL', config.WEB_PLAYER_QUICK_TUNNEL !== false);
}

function requireGlobalHttps() {
    return boolEnv('WEB_PLAYER_REQUIRE_GLOBAL_HTTPS', config.WEB_PLAYER_REQUIRE_GLOBAL_HTTPS !== false);
}

function tunnelToken() {
    return String(process.env.CLOUDFLARE_TUNNEL_TOKEN || config.CLOUDFLARE_TUNNEL_TOKEN || '').trim();
}

function explicitPublicUrl() {
    return String(process.env.WEB_PLAYER_PUBLIC_URL || config.WEB_PLAYER_PUBLIC_URL || '').trim().replace(/\/$/, '');
}

function configuredMode() {
    const raw = String(process.env.WEB_PLAYER_GLOBAL_MODE || config.WEB_PLAYER_GLOBAL_MODE || 'auto').trim().toLowerCase();
    return ['auto', 'quick', 'named', 'manual', 'off'].includes(raw) ? raw : 'auto';
}

function cloudflaredVersion() {
    return String(process.env.CLOUDFLARED_VERSION || config.CLOUDFLARED_VERSION || DEFAULT_VERSION).trim() || DEFAULT_VERSION;
}

function configuredProtocol() {
    const raw = String(process.env.CLOUDFLARE_TUNNEL_PROTOCOL || config.CLOUDFLARE_TUNNEL_PROTOCOL || 'auto').trim().toLowerCase();
    return ['auto', 'quic', 'http2'].includes(raw) ? raw : 'auto';
}

function http2FallbackEnabled() {
    return boolEnv('CLOUDFLARE_HTTP2_FALLBACK', config.CLOUDFLARE_HTTP2_FALLBACK !== false);
}

function platformAsset() {
    return RELEASE_ASSETS[`${process.platform}-${process.arch}`] || null;
}

function customBinaryPath() {
    return String(process.env.CLOUDFLARED_PATH || config.CLOUDFLARED_PATH || '').trim();
}

function defaultBinaryPath() {
    const asset = platformAsset();
    if (!asset) return '';
    return path.join(BIN_DIR, asset.file);
}

function execVersion(binary) {
    return new Promise(resolve => {
        execFile(binary, ['--version'], { windowsHide: true, timeout: 8_000 }, (err, stdout, stderr) => {
            if (err) return resolve(null);
            const text = `${stdout || ''} ${stderr || ''}`.trim();
            resolve(text || 'cloudflared');
        });
    });
}

async function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(file);
        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function fileIsUsable(file, expectedHash = '') {
    try {
        const stat = await fsp.stat(file);
        if (!stat.isFile() || stat.size < 1024 * 1024) return false;
        if (expectedHash) {
            const actual = await sha256File(file);
            if (actual.toLowerCase() !== expectedHash.toLowerCase()) return false;
        }
        if (process.platform !== 'win32') await fsp.chmod(file, 0o755).catch(() => {});
        return Boolean(await execVersion(file));
    } catch (_) {
        return false;
    }
}

async function downloadVerified(asset, destination, version) {
    const url = `https://github.com/cloudflare/cloudflared/releases/download/${encodeURIComponent(version)}/${asset.asset}`;
    const temp = `${destination}.part-${process.pid}-${Date.now()}`;
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    try {
        const response = await fetch(url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(120_000),
            headers: { 'User-Agent': `Music-By-A/${config.VERSION || '5.9.2'} cloudflared-setup` },
        });
        if (!response.ok || !response.body) throw new Error(`cloudflared download HTTP ${response.status}`);
        const length = Number(response.headers.get('content-length') || 0);
        if (length && length > 120 * 1024 * 1024) throw new Error('cloudflared download is unexpectedly large');
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temp, { flags: 'wx' }));
        const stat = await fsp.stat(temp);
        if (stat.size < 1024 * 1024 || stat.size > 120 * 1024 * 1024) throw new Error('cloudflared download size is invalid');
        const actual = await sha256File(temp);
        if (actual.toLowerCase() !== asset.sha256.toLowerCase()) {
            throw new Error(`cloudflared SHA-256 mismatch (${actual})`);
        }
        if (process.platform !== 'win32') await fsp.chmod(temp, 0o755);
        await fsp.rm(destination, { force: true }).catch(() => {});
        await fsp.rename(temp, destination);
        return destination;
    } catch (err) {
        await fsp.rm(temp, { force: true }).catch(() => {});
        throw err;
    }
}

async function ensureBinary() {
    if (ensurePromise) return ensurePromise;
    ensurePromise = (async () => {
        const custom = customBinaryPath();
        if (custom) {
            const resolved = path.resolve(custom);
            if (!await fileIsUsable(resolved)) throw new Error(`CLOUDFLARED_PATH is not usable: ${resolved}`);
            return resolved;
        }

        const local = defaultBinaryPath();
        const asset = platformAsset();
        if (local && asset && await fileIsUsable(local, asset.sha256)) return local;

        // Accept a system installation before downloading another copy.
        const systemName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
        if (await execVersion(systemName)) return systemName;

        const autoDownload = boolEnv('CLOUDFLARED_AUTO_DOWNLOAD', config.CLOUDFLARED_AUTO_DOWNLOAD !== false);
        if (!autoDownload) throw new Error('cloudflared is missing and automatic download is disabled');
        if (!asset || !local) {
            throw new Error(`No bundled cloudflared auto-download target for ${process.platform}/${process.arch}. Install cloudflared and set CLOUDFLARED_PATH.`);
        }

        const version = cloudflaredVersion();
        if (version !== DEFAULT_VERSION) {
            // The pinned hash table intentionally matches the pinned version only.
            throw new Error(`CLOUDFLARED_VERSION ${version} is not pinned by this build. Use ${DEFAULT_VERSION} or provide CLOUDFLARED_PATH.`);
        }
        console.log(`[GlobalWeb] cloudflared missing; downloading verified ${version} for ${process.platform}/${process.arch}...`);
        await downloadVerified(asset, local, version);
        const info = await execVersion(local);
        if (!info) throw new Error('downloaded cloudflared failed to execute');
        console.log(`[GlobalWeb] cloudflared ready: ${info}`);
        return local;
    })().finally(() => { ensurePromise = null; });
    return ensurePromise;
}

function isBenignTunnelNoise(line) {
    const text = String(line || '').trim();
    if (!text) return true;
    // cloudflared reports ordinary browser disconnects as ERR even though the
    // tunnel itself is healthy. These happen when a tab refreshes/closes or a
    // mobile connection changes and should not flood CMD as server failures.
    return /incoming request ended abruptly.*context canceled/i.test(text)
        || /request failed.*incoming request ended abruptly/i.test(text)
        || /context canceled.*(?:request|stream|client)/i.test(text)
        || /(?:request|stream|client).*(?:cancelled|canceled|disconnected).*context/i.test(text);
}

function emitLine(prefix, line, onUrl, onConnected) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    const matches = trimmed.match(QUICK_URL_RE) || [];
    for (const found of matches) onUrl(found.replace(/\/$/, ''));
    if (CONNECTED_RE.test(trimmed)) onConnected?.(trimmed);
    if (isBenignTunnelNoise(trimmed)) return;
    if (/ERR|error|failed/i.test(trimmed) && !/no error/i.test(trimmed)) {
        console.warn(`[GlobalWeb:${prefix}] ${trimmed.slice(0, 600)}`);
    }
}

function killChild() {
    const current = child;
    child = null;
    if (!current || current.killed) return;
    intentionalStops.add(current);
    try { current.kill(); } catch (_) {}
}

function scheduleRestart() {
    if (stopping || !activeOptions || restartTimer) return;
    const base = Math.min(30_000, 1_500 * (2 ** Math.min(5, restartAttempt++)));
    restartTimer = setTimeout(() => {
        restartTimer = null;
        void launch(activeOptions).catch(err => {
            console.warn(`[GlobalWeb] tunnel restart failed: ${err.message}`);
            scheduleRestart();
        });
    }, base);
    restartTimer.unref?.();
}

async function launch(options) {
    if (stopping || activeOptions !== options || options.signal?.aborted) throw startupCancelled();
    const binary = await waitWithCancellation(ensureBinary(), options.signal);
    if (stopping || activeOptions !== options || options.signal?.aborted) throw startupCancelled();
    const mode = options.mode;
    const token = options.token;
    const args = mode === 'named'
        ? ['tunnel', '--no-autoupdate', 'run', '--token', token]
        : ['tunnel', '--no-autoupdate', '--url', options.originUrl];

    return new Promise((resolve, reject) => {
        let settled = false;
        let discovered = mode === 'named' ? options.publicUrl : '';
        let connected = false;
        let startupTimer = null;
        let proc = null;
        const cancel = () => {
            if (settled) return;
            settled = true;
            if (startupTimer) clearTimeout(startupTimer);
            options.signal?.removeEventListener('abort', cancel);
            if (proc && !proc.killed) {
                intentionalStops.add(proc);
                try { proc.kill(); } catch (_) {}
            }
            if (child === proc) child = null;
            reject(startupCancelled());
        };

        const finishIfReady = () => {
            if (settled || !connected) return;
            if (stopping || activeOptions !== options || options.signal?.aborted) return cancel();
            if (mode === 'quick' && !discovered) return;
            if (mode === 'named' && !discovered) return;
            settled = true;
            options.signal?.removeEventListener('abort', cancel);
            if (startupTimer) clearTimeout(startupTimer);
            restartAttempt = 0;
            publicUrl = discovered;
            options.onPublicUrl?.(discovered);
            resolve({ mode, publicUrl: discovered, binary });
        };
        const isolatedHome = path.join(ROOT, 'data', '.cloudflared-home');
        try { fs.mkdirSync(isolatedHome, { recursive: true }); } catch (_) {}
        proc = spawn(binary, args, {
            cwd: ROOT,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                NO_AUTOUPDATE: 'true',
                TUNNEL_TRANSPORT_PROTOCOL: String(options.protocol || 'auto'),
                HOME: isolatedHome,
                USERPROFILE: isolatedHome,
            },
        });
        performanceProfile.registerChildProcess(proc, 'background');
        child = proc;
        options.signal?.addEventListener('abort', cancel, { once: true });

        const onUrl = (url) => {
            if (mode !== 'quick' || !url) return;
            discovered = url;
            finishIfReady();
        };
        const onConnected = () => {
            connected = true;
            finishIfReady();
        };
        const scanTail = { out: '', err: '' };
        const consume = (prefix, chunk) => {
            const combined = scanTail[prefix] + String(chunk || '');
            const lines = combined.split(/\r?\n/);
            scanTail[prefix] = lines.pop() || '';
            for (const line of lines) emitLine(prefix, line, onUrl, onConnected);
            // A malformed/no-newline process message must never grow without bound.
            if (scanTail[prefix].length > 8192) {
                emitLine(prefix, scanTail[prefix].slice(0, 8192), onUrl, onConnected);
                scanTail[prefix] = '';
            }
        };
        const flushTails = () => {
            for (const prefix of ['out', 'err']) {
                if (scanTail[prefix]) emitLine(prefix, scanTail[prefix], onUrl, onConnected);
                scanTail[prefix] = '';
            }
        };
        proc.stdout?.on('data', chunk => consume('out', chunk));
        proc.stderr?.on('data', chunk => consume('err', chunk));
        proc.once('error', err => {
            if (!settled) {
                settled = true;
                if (startupTimer) clearTimeout(startupTimer);
                options.signal?.removeEventListener('abort', cancel);
                reject(err);
            }
        });
        proc.once('exit', (code, signal) => {
            flushTails();
            const intentional = intentionalStops.has(proc);
            intentionalStops.delete(proc);
            if (child === proc) child = null;
            if (!intentional && !stopping) console.warn(`[GlobalWeb] cloudflared exited (${code ?? 'null'} / ${signal || 'no-signal'}); reconnecting...`);
            if (!settled) {
                settled = true;
                if (startupTimer) clearTimeout(startupTimer);
                options.signal?.removeEventListener('abort', cancel);
                if (intentional || stopping || activeOptions !== options || options.signal?.aborted) return reject(startupCancelled());
                reject(new Error(`cloudflared exited before tunnel was ready (${code ?? signal ?? 'unknown'})`));
            } else if (!intentional && !stopping) {
                if (mode === 'quick') {
                    publicUrl = '';
                    options.onPublicUrl?.('');
                }
                scheduleRestart();
            }
        });

        const timeoutMs = Math.max(10_000, Number(process.env.CLOUDFLARE_TUNNEL_START_TIMEOUT_MS || config.CLOUDFLARE_TUNNEL_START_TIMEOUT_MS || 45_000));
        startupTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            options.signal?.removeEventListener('abort', cancel);
            killChild();
            reject(new Error(`Cloudflare ${mode === 'named' ? 'Named' : 'Quick'} Tunnel did not establish a registered edge connection within ${timeoutMs}ms`));
        }, timeoutMs);
        startupTimer.unref?.();
    });
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(startupCancelled());
        const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
        const t = setTimeout(finish, ms);
        t.unref?.();
        const cancel = () => { clearTimeout(t); signal?.removeEventListener('abort', cancel); reject(startupCancelled()); };
        signal?.addEventListener('abort', cancel, { once: true });
    });
}

async function launchInitialWithRetry(options) {
    const retries = Math.max(0, Math.min(10, Number(process.env.CLOUDFLARE_TUNNEL_BOOT_RETRIES || config.CLOUDFLARE_TUNNEL_BOOT_RETRIES || 4)));
    const baseMs = Math.max(500, Number(process.env.CLOUDFLARE_TUNNEL_RETRY_BASE_MS || config.CLOUDFLARE_TUNNEL_RETRY_BASE_MS || 1500));
    const configured = configuredProtocol();
    options.protocol = configured;
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (stopping || activeOptions !== options || options.signal?.aborted) throw startupCancelled();
        try {
            const result = await launch(options);
            result.protocol = options.protocol;
            return result;
        } catch (err) {
            if (err.code === 'ABORT_ERR' || stopping || activeOptions !== options || options.signal?.aborted) throw startupCancelled();
            lastErr = err;
            killChild();
            if (attempt >= retries) break;
            if (configured === 'auto' && options.protocol === 'auto' && http2FallbackEnabled()) {
                options.protocol = 'http2';
                console.warn('[GlobalWeb] automatic edge transport did not register; retrying over TCP/HTTP2 for restrictive networks...');
            }
            const wait = Math.min(15_000, baseMs * (2 ** Math.min(attempt, 4)));
            console.warn(`[GlobalWeb] startup attempt ${attempt + 1}/${retries + 1} failed: ${err.message}; retrying in ${wait}ms...`);
            await sleep(wait, options.signal);
        }
    }
    throw lastErr || new Error('Cloudflare tunnel failed to start');
}

async function start({ originUrl, onPublicUrl } = {}) {
    if (startPromise) return startPromise;
    const controller = new AbortController();
    startController = controller;
    const pending = (async () => {
        stopping = false;
        const modeConfig = configuredMode();
        const explicit = explicitPublicUrl();
        const token = tunnelToken();

        if (!globalAccessEnabled() || modeConfig === 'off') {
            publicUrl = explicit;
            if (explicit) onPublicUrl?.(explicit);
            return { mode: 'off', publicUrl: explicit };
        }

        if (modeConfig === 'manual' || (modeConfig === 'auto' && explicit && !token)) {
            publicUrl = explicit;
            if (explicit) onPublicUrl?.(explicit);
            if (!explicit) throw new Error('WEB_PLAYER_GLOBAL_MODE=manual requires WEB_PLAYER_PUBLIC_URL');
            if (requireGlobalHttps() && !/^https:\/\//i.test(explicit)) {
                throw new Error('Global Web Player requires WEB_PLAYER_PUBLIC_URL to use trusted HTTPS');
            }
            return { mode: 'manual', publicUrl: explicit };
        }

        let mode = modeConfig;
        if (mode === 'auto') mode = token ? 'named' : 'quick';
        if (mode === 'named') {
            if (!token) throw new Error('Named Cloudflare Tunnel requires CLOUDFLARE_TUNNEL_TOKEN');
            if (!explicit || !/^https:\/\//i.test(explicit)) {
                throw new Error('Named Cloudflare Tunnel requires WEB_PLAYER_PUBLIC_URL=https://your-domain');
            }
        }
        if (mode === 'quick' && !quickTunnelEnabled()) {
            throw new Error('Quick Tunnel is disabled and no permanent public tunnel is configured');
        }
        if (!originUrl || !/^https?:\/\//i.test(originUrl)) throw new Error('Global Web origin URL is invalid');

        activeOptions = { mode, token, originUrl, publicUrl: explicit, onPublicUrl, protocol: configuredProtocol(), signal: controller.signal };
        const result = await launchInitialWithRetry(activeOptions);
        console.log(`[GlobalWeb] worldwide HTTPS ready: ${result.publicUrl} (edge=${result.protocol || activeOptions.protocol || 'auto'})`);
        if (result.mode === 'quick') {
            console.log('[GlobalWeb] Quick Tunnel fallback is active. The URL is trusted HTTPS but changes after a tunnel restart; use a named tunnel + custom domain for a permanent production hostname.');
        }
        return result;
    })().catch(err => {
        if (startController === controller) {
            activeOptions = null;
            publicUrl = '';
        }
        throw err;
    }).finally(() => { if (startPromise === pending) startPromise = null; });
    startPromise = pending;
    return pending;
}

async function stop() {
    stopping = true;
    startController?.abort();
    startController = null;
    startPromise = null;
    activeOptions = null;
    publicUrl = '';
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    killChild();
}

function getPublicUrl() { return publicUrl; }
function isActive() { return Boolean(child || publicUrl); }

module.exports = {
    start,
    stop,
    ensureBinary,
    getPublicUrl,
    isActive,
    _internals: { platformAsset, configuredMode, explicitPublicUrl, requireGlobalHttps, configuredProtocol, http2FallbackEnabled, QUICK_URL_RE, CONNECTED_RE, sha256File, fileIsUsable, isBenignTunnelNoise },
};
