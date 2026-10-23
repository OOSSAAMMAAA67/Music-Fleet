'use strict';
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns/promises');
const net = require('node:net');
const fs = require('node:fs');
const fsp = fs.promises;
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function isExtractorUrl(input) {
    try {
        const u = new URL(String(input)), h = u.hostname.toLowerCase();
        if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
        if (h === 'youtu.be') return /^\/[\w-]{11}\/?$/.test(u.pathname);
        if (h === 'youtube.com' || h.endsWith('.youtube.com')) {
            const video = /^[\w-]{11}$/.test(u.searchParams.get('v') || ''), playlist = /^[\w-]{5,128}$/.test(u.searchParams.get('list') || '');
            return u.pathname === '/watch' && (video || playlist) || u.pathname === '/playlist' && playlist || /^\/(?:shorts|live)\/[\w-]{11}\/?$/.test(u.pathname);
        }
        if (h === 'soundcloud.com' || ['www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com'].includes(h)) {
            const pathname = decodeURIComponent(u.pathname);
            if (/^\/(?:redirect|oembed|connect|download)(?:\/|$)/i.test(pathname)) return false;
            if ([...u.searchParams.keys()].some(name => /^(?:link|url|redirect(?:_url|_uri)?|continue|next|target|destination)$/i.test(name))) return false;
            return h === 'on.soundcloud.com' ? /^\/[\w-]+\/?$/.test(pathname) : /^\/[^/\s\\?#]+\/(?:[^/\s\\?#]+|sets\/[^/\s\\?#]+)\/?$/.test(pathname);
        }
        return false;
    } catch (_) { return false; }
}

function withAbort(work, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason || Object.assign(new Error('Media request cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' }));
    if (!signal) return Promise.resolve().then(work);
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason || Object.assign(new Error('Media request cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' }));
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

async function openPublicMedia(input, { lookup = dns.lookup, request, headers = {}, signal, maxRedirects = 5, allowedHosts, httpsOnly = false,
    headerTimeoutMs = 30_000, bodyIdleTimeoutMs = 0 } = {}) {
    if (!Number.isFinite(headerTimeoutMs) || headerTimeoutMs <= 0) throw new RangeError('A positive media header timeout is required.');
    if (!Number.isFinite(bodyIdleTimeoutMs) || bodyIdleTimeoutMs < 0) throw new RangeError('A valid media body idle timeout is required.');
    const headerController = new AbortController();
    const acquisitionSignal = signal ? AbortSignal.any([signal, headerController.signal]) : headerController.signal;
    // DNS, connect and all redirect headers share this deadline. Once headers
    // arrive, a voice stream can remain paused without expiring this timer.
    const headerTimer = setTimeout(() => headerController.abort(Object.assign(new Error('Public media headers timed out.'),
        { name: 'TimeoutError', code: 'ETIMEDOUT' })), headerTimeoutMs);
    headerTimer.unref?.();
    let target = String(input);
    try { for (let redirects = 0; redirects <= maxRedirects; redirects++) {
        if (httpsOnly && new URL(target).protocol !== 'https:') throw new Error('Artwork transport requires HTTPS on every redirect.');
        const { validatePublicUrl } = require('./platformMedia');
        let resolved;
        const u = new URL(await withAbort(() => validatePublicUrl(target, { allowedHosts, lookup: async (...args) => { resolved = await lookup(...args); return resolved; } }), acquisitionSignal));
        const host = u.hostname.replace(/^\[|\]$/g, '');
        const values = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : resolved;
        const addresses = Array.isArray(values) ? values : [values];
        if (!addresses.length || addresses.some(x => require('./platformMedia').privateAddress(x.address))) throw new Error('Private media addresses are blocked.');
        const chosen = addresses[0];
        const transport = request || (u.protocol === 'https:' ? https.request : http.request);
        const response = await withAbort(() => new Promise((resolve, reject) => {
            const req = transport(u, { method: 'GET', agent: false, signal: acquisitionSignal, headers: { 'User-Agent': 'MusicByA/7.0', Accept: '*/*', ...headers },
                lookup: (_hostname, options, callback) => { const family = chosen.family || net.isIP(chosen.address); if (options?.all) callback(null, [{ address: chosen.address, family }]); else callback(null, chosen.address, family); } }, resolve);
            req.once('error', reject); req.end();
        }), acquisitionSignal);
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            const location = response.headers.location; response.destroy();
            if (!location || redirects === maxRedirects) throw new Error('Public media redirect failed.');
            target = new URL(location, u).href; continue;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) { response.destroy(); throw new Error(`Public media HTTP ${response.statusCode}.`); }
        if (bodyIdleTimeoutMs > 0) response.setTimeout?.(bodyIdleTimeoutMs, () => response.destroy(Object.assign(
            new Error('Public media body timed out.'), { name: 'TimeoutError', code: 'ETIMEDOUT' })));
        return { response, url: u.href, mime: String(response.headers['content-type'] || '').split(';')[0], cleanup: () => response.destroy() };
    }
    throw new Error('Public media redirect failed.');
    } finally { clearTimeout(headerTimer); }
}

async function downloadPublicMedia(input, { path: target, maxBytes = 0, onProgress, signal, bodyIdleTimeoutMs = 90_000, ...options } = {}) {
    if (!target) throw new Error('A media output path is required.');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('A valid media byte limit is required.');
    const opened = await openPublicMedia(input, { ...options, signal, bodyIdleTimeoutMs }); let bytes = 0;
    const limit = new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; if (maxBytes && bytes > maxBytes) return done(new Error('Public media is too large.')); onProgress?.({ downloadedBytes: bytes, totalBytes: Number(opened.response.headers['content-length']) || 0 }); done(null, chunk); } });
    const temp = `${target}.part`;
    try { await pipeline(opened.response, limit, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal }); if (!bytes) throw new Error('Public media is empty.'); await fsp.rename(temp, target); return { path: target, bytes, mime: opened.mime, url: opened.url }; }
    catch (e) { opened.cleanup(); await fsp.rm(temp, { force: true }).catch(() => {}); throw e; }
}
module.exports = { isExtractorUrl, openPublicMedia, downloadPublicMedia };
