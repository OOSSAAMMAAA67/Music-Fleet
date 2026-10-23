'use strict';

const { identifyTrack } = require('./artworkResolver');
const { sourceScore } = require('./platformSources');
const normalized = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f\u064b-\u065f\u0670\u06d6-\u06ed]/g, '').replace(/\u0640/g, '').normalize('NFC').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const supplied = value => Array.isArray(value) ? value.length > 0 : Boolean(value && (value.label || value.copyright || value.contributors?.length || value.labels?.length));
const catalogId = value => /^(deezer|itunes|musicbrainz):(track|album|release):[^:]+$/.test(String(value || ''));

function createRecordingCredits({ catalog, identify = identifyTrack, now = Date.now, timeoutMs = 20_000 } = {}) {
    const cache = new Map();
    async function resolve(input = {}, { signal } = {}) {
        if (supplied(input.credits)) return input.credits;
        const identity = identify(input), expected = { title: identity.title, author: identity.artist, duration: Number(input.duration) || 0 };
        if (!expected.title || !expected.author || /^(unknown(?: artist)?|direct link|uploader|channel)$/i.test(expected.author)) return [];
        const key = JSON.stringify([normalized(expected.title), normalized(expected.author), Math.round(expected.duration), input.albumId || '']);
        const previous = cache.get(key);
        if (previous?.expires > now()) return structuredClone(await previous.value);
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('Recording credits lookup timed out.')), timeoutMs);
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const call = work => new Promise((yes, no) => {
            const abort = () => no(combined.reason);
            if (combined.aborted) return abort();
            combined.addEventListener('abort', abort, { once: true });
            Promise.resolve().then(() => { combined.throwIfAborted(); return work(); }).then(yes, no).finally(() => combined.removeEventListener('abort', abort));
        });
        const compatible = item => catalogId(item?.id) && normalized(item.title) === normalized(expected.title) && normalized(item.author || item.artist) === normalized(expected.author) && Number.isFinite(sourceScore(expected, item));
        const label = (value, item, scope = 'recording') => ({ ...(Array.isArray(value) ? { contributors: value } : value), scope, recordingId: scope === 'recording' ? item.id : undefined, albumId: scope === 'album' ? item.id : item.albumId, provider: item.provider || String(item.id || '').split(':')[0] });
        const value = (async () => {
            let verified = [];
            if (catalogId(input.id)) {
                try {
                    const kind = /:(album|release):/.test(input.id) ? 'album' : 'track';
                    const item = await call(() => catalog.detail(kind, input.id, { signal: combined }));
                    if (kind === 'album' && supplied(item.credits)) return label(item.credits, item, 'album');
                    if (compatible(item)) { verified.push(item); if (supplied(item.credits)) return label(item.credits, item); }
                } catch (_) { if (combined.aborted) return []; }
            }
            try {
                const result = await call(() => catalog.search(`${expected.author} ${expected.title}`, 'tracks', { limit: 20, signal: combined }));
                const items = Array.isArray(result) ? result : [...(result?.items || []), ...(result?.sections || []).flatMap(section => section.items || [])];
                const candidates = items.filter(compatible).sort((a, b) => sourceScore(expected, b) - sourceScore(expected, a));
                const seen = new Set(verified.map(item => item.id));
                for (const candidate of candidates.slice(0, 6)) {
                    if (seen.has(candidate.id)) continue; seen.add(candidate.id);
                    try {
                        const detail = await call(() => catalog.detail('track', candidate.id, { signal: combined }));
                        if (!compatible(detail)) continue;
                        verified.push(detail);
                        if (supplied(detail.credits)) return label(detail.credits, detail);
                    } catch (_) { if (combined.aborted) return []; }
                }
            } catch (_) { if (combined.aborted) return []; }
            for (const item of verified) {
                if (!catalogId(item.albumId)) continue;
                try {
                    const album = await call(() => catalog.detail('album', item.albumId, { signal: combined }));
                    if (album.id === item.albumId && supplied(album.credits)) return label(album.credits, album, 'album');
                } catch (_) { if (combined.aborted) return []; }
            }
            return [];
        })();
        cache.set(key, { value, expires: now() + 30 * 60_000 });
        while (cache.size > 200) cache.delete(cache.keys().next().value);
        try { const result = await value; if (!supplied(result)) cache.delete(key); return structuredClone(result); }
        finally { clearTimeout(timer); }
    }
    resolve.clearCache = () => cache.clear();
    return resolve;
}
module.exports = { createRecordingCredits };
