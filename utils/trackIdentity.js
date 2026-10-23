'use strict';

const TRACKING_PARAMS = new Set([
    'si', 'feature', 'ab_channel', 'fbclid', 'gclid', 'igshid', 'ref', 'referrer',
]);

function normalizeUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const u = new URL(raw);
        if (!/^https?:$/.test(u.protocol)) return raw;
        u.hash = '';
        for (const key of [...u.searchParams.keys()]) {
            const lower = key.toLowerCase();
            if (TRACKING_PARAMS.has(lower) || lower.startsWith('utm_')) u.searchParams.delete(key);
        }
        u.searchParams.sort?.();
        // Host/protocol are case-insensitive; paths/query values are not.
        u.hostname = u.hostname.toLowerCase();
        return u.toString().replace(/\/$/, '');
    } catch (_) {
        return raw;
    }
}

function canonicalTrackKey(trackOrUrl = {}) {
    if (typeof trackOrUrl === 'string') return normalizeUrl(trackOrUrl);
    const track = trackOrUrl || {};
    // For linked providers such as Spotify/TIDAL, the source URL is the stable
    // identity. The playable YouTube match can legitimately change over time.
    const preferredUrl = track.linkedOriginalUrl || track.linkedResolvedUrl || track.url || track.webpage_url || '';
    const normalized = normalizeUrl(preferredUrl);
    if (normalized) return normalized;
    return `${String(track.title || '').trim().toLowerCase()}::${String(track.author || '').trim().toLowerCase()}`;
}

function catalogMetadata(track = {}) {
    const result = { kind: track.kind === 'video' ? 'video' : 'track', metadataOnly: Boolean(track.metadataOnly), previewOnly: Boolean(track.previewOnly) };
    for (const key of ['id', 'artistId', 'albumId', 'providerUrl', 'metadataProvider', 'releaseDate']) result[key] = String(track[key] || '').slice(0, key === 'providerUrl' ? 2000 : 320);
    for (const key of ['releaseId', 'releaseGroupId']) if (track[key]) result[key] = String(track[key]).slice(0, 320);
    result.genres = Array.isArray(track.genres) ? track.genres.slice(0, 16).map(x => String(x).slice(0, 80)) : [];
    if (typeof track.explicit === 'boolean') result.explicit = track.explicit;
    return result;
}

module.exports = { normalizeUrl, canonicalTrackKey, catalogMetadata };
