'use strict';

const { normalizeUrl } = require('./trackIdentity');

const BASES = {
    deezer: 'https://api.deezer.com', itunes: 'https://itunes.apple.com',
    musicbrainz: 'https://musicbrainz.org/ws/2',
    applecharts: 'https://rss.marketingtools.apple.com',
};
const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const TYPES = { tracks: 'track', albums: 'album', artists: 'artist', videos: 'video' };
const clone = value => structuredClone(value);
const clean = (value, max = 300) => String(value || '').trim().slice(0, max);
const nameKey = value => clean(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
const http = value => /^https?:\/\//i.test(String(value || '')) ? String(value).replace(/^http:/, 'https:') : '';
const list = value => Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];

function problem(message, code = 'CATALOG_UNAVAILABLE', statusCode = 503) {
    const error = new Error(message); error.code = code; error.statusCode = statusCode; return error;
}
function providerId(provider, kind, id) { return id != null && String(id) ? `${provider}:${kind}:${id}` : ''; }
function parseId(kind, id) {
    const raw = clean(id, 250);
    if (UUID.test(raw)) return { provider: 'musicbrainz', kind, id: raw };
    const release = /^musicbrainz:release:([a-f\d-]+)$/i.exec(raw);
    if (kind === 'album' && release && UUID.test(release[1])) return { provider: 'musicbrainz', kind, id: release[1], entity: 'release' };
    const match = /^(deezer|itunes|musicbrainz|youtube):(track|album|artist|video|playlist|genre|work):(.+)$/.exec(raw);
    if (!match || match[2] !== kind || (match[1] === 'musicbrainz' ? !UUID.test(match[3]) : match[1] === 'youtube' ? !/^[\w-]{11}$/.test(match[3]) : !/^\d{1,20}$/.test(match[3]))) {
        throw problem('Invalid catalog ID. Use the provider-aware ID returned by search.', 'INVALID_CATALOG_ID', 400);
    }
    return { provider: match[1], kind: match[2], id: match[3] };
}
function mbCredit(value) {
    return (value?.['artist-credit'] || []).map(x => typeof x === 'string' ? x : `${x.name || x.artist?.name || ''}${x.joinphrase || ''}`).join('') || clean(value?.artist || '');
}
function mbArtistId(value) { return value?.['artist-credit']?.find(x => x.artist?.id)?.artist?.id; }
function provenance(provider, endpoint, artworkSource) {
    return { provider, endpoint, artworkSource: artworkSource || provider };
}
function deezerCredits(value, scope = 'recording') {
    return { scope, label: clean(value?.label, 300), copyright: clean(value?.copyright, 600),
        contributors: (value?.contributors || []).map(x => {
            const artist = deezerArtist(x);
            return artist && { ...artist, role: clean(x.role || 'Performer', 100), scope };
        }).filter(Boolean) };
}
function mbCredits(value, scope = 'recording') {
    const contributors = [], works = [];
    for (const credit of value?.['artist-credit'] || []) {
        const artist = mbItem(credit.artist, 'artist');
        if (artist) contributors.push({ ...artist, role: 'Performer', scope });
    }
    const addRelations = (relations, level, workId) => {
        for (const relation of relations || []) {
            const artist = mbItem(relation.artist, 'artist');
            if (artist) contributors.push({ ...artist, role: clean(relation.type, 100), scope: level,
                attributes: (relation.attributes || []).map(x => clean(x, 100)), ...(workId ? { workId } : {}) });
            const work = relation.work;
            if (UUID.test(work?.id || '')) {
                const id = providerId('musicbrainz', 'work', work.id);
                works.push({ kind: 'work', id, title: clean(work.title), role: clean(relation.type),
                    provider: 'musicbrainz', providerUrl: `https://musicbrainz.org/work/${work.id}` });
                addRelations(work.relations, 'work', id);
            }
        }
    };
    addRelations(value?.relations, scope);
    const seen = new Set();
    return { scope, works: unique(works), contributors: contributors.filter(x => {
        const key = `${x.id}:${x.role}:${x.scope}:${x.workId || ''}:${(x.attributes || []).join(',')}`;
        if (seen.has(key)) return false; seen.add(key); return true;
    }) };
}
function canonicalArtists(items, query = '') {
    const target = nameKey(query), byName = new Map();
    for (const item of items || []) {
        if (item?.kind !== 'artist') continue;
        const key = nameKey(item.title);
        if (!key) continue;
        const credits = key.split(/\s*(?:\bfeat\.?|\bfeaturing\b|\bft\.?|\bwith\b|\band\b|&|\+|,|\s+x\s+)\s*/i);
        if (target && key !== target && credits.length > 1 && credits.includes(target)) continue;
        const previous = byName.get(key);
        if (!previous || Number(item.fans || 0) > Number(previous.fans || 0)
            || Number(item.fans || 0) === Number(previous.fans || 0) && item.thumbnail && !previous.thumbnail) byName.set(key, item);
    }
    return [...byName.values()].sort((a, b) => Number(nameKey(b.title) === target) - Number(nameKey(a.title) === target));
}
function albumFamily(value) {
    return nameKey(value).replace(/\s*[([\-–:]\s*([^\])]+)[\])]?$|\s+(deluxe(?: edition)?|expanded(?: edition)?|remastered(?: \d{4})?)$/gi,
        (whole, bracket, suffix) => /(?:deluxe|expanded|anniversary|remaster|reissue|special edition|bonus|collector)/i.test(bracket || suffix || '')
            && !/(?:live|remix|acoustic|instrumental)/i.test(bracket || suffix || '') ? '' : whole).trim();
}
function sameAlbumFamily(a, b) {
    return a?.kind === 'album' && b?.kind === 'album' && a.id !== b.id && a.artistId && a.artistId === b.artistId
        && albumFamily(a.title) === albumFamily(b.title);
}
function deezerArtist(value) {
    if (!value?.id || !value?.name) return null;
    return { kind: 'artist', id: providerId('deezer', 'artist', value.id), title: clean(value.name), author: clean(value.name),
        provider: 'deezer', thumbnail: http(value.picture_xl || value.picture_big || value.picture_medium || value.picture),
        providerUrl: http(value.link) || `https://www.deezer.com/artist/${value.id}`, fans: Number(value.nb_fan || 0),
        provenance: provenance('deezer', `/artist/${value.id}`, 'Deezer artist image') };
}
function deezerAlbum(value, artist = {}) {
    if (!value?.id || !value?.title) return null;
    const author = value.artist || artist;
    const genres = list(value.genres).map(x => clean(x.name, 100)).filter(Boolean);
    const item = { kind: 'album', id: providerId('deezer', 'album', value.id), title: clean(value.title), author: clean(author.name),
        artistId: providerId('deezer', 'artist', author.id), provider: 'deezer',
        providerUrl: http(value.link) || `https://www.deezer.com/album/${value.id}`,
        thumbnail: http(value.cover_xl || value.cover_big || value.cover_medium || value.cover),
        recordType: clean(value.record_type || 'album', 50).toLowerCase(), contributors: deezerCredits(value, 'release').contributors,
        genres, genre: genres[0] || '', releaseDate: clean(value.release_date, 30), count: Number(value.nb_tracks || 0),
        subtitle: [clean(author.name), value.release_date?.slice(0, 4)].filter(Boolean).join(' · '),
        provenance: provenance('deezer', `/album/${value.id}`, 'Deezer album artwork') };
    if (typeof value.explicit_lyrics === 'boolean') item.explicit = value.explicit_lyrics;
    return item;
}
function deezerTrack(value, context = {}) {
    if (!value?.id || !value?.title) return null;
    const artist = value.artist || context.artist || {}, album = { ...context, ...(value.album || {}) };
    const originalUrl = http(value.link) || `https://www.deezer.com/track/${value.id}`;
    const genres = list(album.genres).map(x => clean(x.name, 100)).filter(Boolean);
    const titleVersion = clean(value.title_version, 150);
    const title = titleVersion && !nameKey(value.title).endsWith(nameKey(titleVersion))
        ? nameKey(titleVersion).startsWith(`${nameKey(value.title)} `) ? titleVersion : `${clean(value.title)} ${titleVersion}` : clean(value.title);
    const item = { kind: 'track', id: providerId('deezer', 'track', value.id), title, titleVersion, version: titleVersion,
        isrc: clean(value.isrc, 20).replace(/[^a-z\d]/gi, '').toUpperCase(), author: clean(artist.name),
        url: originalUrl, providerUrl: originalUrl, provider: 'deezer', metadataOnly: true,
        album: clean(album.title), albumId: providerId('deezer', 'album', album.id), artistId: providerId('deezer', 'artist', artist.id),
        thumbnail: http(album.cover_xl || album.cover_big || album.cover_medium || album.cover), duration: Math.max(0, Number(value.duration || 0)),
        previewUrl: http(value.preview), genres, genre: genres[0] || '', releaseDate: clean(album.release_date, 30),
        rank: Number(value.rank || 0), trackNumber: Number(value.track_position || 0), discNumber: Number(value.disk_number || 0),
        contributors: deezerCredits(value).contributors,
        provenance: provenance('deezer', `/track/${value.id}`, 'Deezer album artwork') };
    if (typeof value.explicit_lyrics === 'boolean') item.explicit = value.explicit_lyrics;
    return item;
}
function deezerPlaylist(value) {
    if (!value?.id || !value?.title) return null;
    return { kind: 'playlist', id: providerId('deezer', 'playlist', value.id), title: clean(value.title),
        author: clean(value.user?.name || value.creator?.name), provider: 'deezer', providerUrl: http(value.link),
        thumbnail: http(value.picture_xl || value.picture_big || value.picture_medium), count: Number(value.nb_tracks || 0), rank: Number(value.rank || 0) };
}
function itunesItem(value, requestedKind) {
    const kind = value?.kind === 'music-video' ? 'video' : value?.wrapperType === 'artist' || value?.artistType ? 'artist'
        : value?.wrapperType === 'collection' || value?.collectionType === 'Album' ? 'album' : requestedKind || 'track';
    const id = kind === 'artist' ? value.artistId : kind === 'album' ? value.collectionId : value.trackId;
    const title = kind === 'artist' ? value.artistName : kind === 'album' ? value.collectionName : value.trackName;
    if (!id || !title) return null;
    const storeUrl = http(value.trackViewUrl || value.collectionViewUrl || value.artistLinkUrl || value.artistViewUrl);
    const item = { kind, id: providerId('itunes', kind, id), title: clean(title), author: clean(value.artistName),
        ...(kind === 'track' && value.isrc ? { isrc: clean(value.isrc, 20).replace(/[^a-z\d]/gi, '').toUpperCase() } : {}), provider: 'itunes',
        artistId: providerId('itunes', 'artist', value.artistId), albumId: providerId('itunes', 'album', value.collectionId),
        album: clean(value.collectionName), thumbnail: kind === 'artist' ? '' : http(value.artworkUrl100 || value.artworkUrl60).replace(/\d+x\d+bb\./, '600x600bb.'),
        providerUrl: storeUrl, duration: Math.max(0, Number(value.trackTimeMillis || 0) / 1000),
        genre: clean(value.primaryGenreName, 100), genres: value.primaryGenreName ? [clean(value.primaryGenreName, 100)] : [],
        releaseDate: clean(value.releaseDate, 40), previewUrl: http(value.previewUrl), trackNumber: Number(value.trackNumber || 0),
        discNumber: Number(value.discNumber || 0), copyright: clean(value.copyright, 600),
        recordType: kind === 'album' ? /\s[-–]\s(?:single|ep)$/i.test(title) ? /single$/i.test(title) ? 'single' : 'ep' : 'album' : undefined,
        provenance: provenance('itunes', `/lookup?id=${id}`, 'Apple catalog artwork') };
    const explicit = value.trackExplicitness || value.collectionExplicitness;
    if (explicit) item.explicit = explicit === 'explicit';
    if (kind === 'track') { if (storeUrl) item.url = storeUrl; item.metadataOnly = true; }
    if (kind === 'video') item.previewOnly = Boolean(item.previewUrl);
    return item;
}
function mbItem(value, kind) {
    if (!UUID.test(String(value?.id || ''))) return null;
    const title = clean(kind === 'artist' ? value.name : value.title);
    if (!title) return null;
    const genres = [...(value.genres || []), ...(value.tags || [])].map(x => clean(x.name, 100)).filter(Boolean);
    const artistId = mbArtistId(value);
    const entity = kind === 'album' ? 'release-group' : kind === 'track' ? 'recording' : kind;
    const item = { kind, id: providerId('musicbrainz', kind, value.id), title,
        author: kind === 'artist' ? title : mbCredit(value), provider: 'musicbrainz',
        artistId: providerId('musicbrainz', 'artist', artistId), genres: [...new Set(genres)], genre: genres[0] || '',
        releaseDate: clean(value['first-release-date'] || value.date, 40),
        thumbnail: kind === 'album' ? `https://coverartarchive.org/release-group/${value.id}/front-500` : '',
        providerUrl: `https://musicbrainz.org/${entity}/${value.id}`,
        subtitle: clean(value.disambiguation || value.country || '', 300),
        provenance: provenance('musicbrainz', `/${entity}/${value.id}`, kind === 'album' ? 'Cover Art Archive candidate' : 'MusicBrainz metadata') };
    if (kind === 'album') {
        item.recordType = clean(value['primary-type'] || 'Album', 50).toLowerCase();
        item.secondaryTypes = (value['secondary-types'] || []).map(x => clean(x, 50));
        item.releaseGroupId = item.id; item.artworkCandidates = [item.thumbnail];
        item.contributors = mbCredits(value, 'release').contributors;
    }
    if (kind === 'track') {
        const rawIsrc = value.isrc || value.isrcs?.[0];
        const isrc = clean(typeof rawIsrc === 'string' ? rawIsrc : rawIsrc?.id, 20).replace(/[^a-z\d]/gi, '').toUpperCase();
        if (/^[A-Z]{2}[A-Z\d]{3}\d{7}$/.test(isrc)) item.isrc = isrc;
        item.duration = Number(value.length || 0) / 1000; item.metadataOnly = true; item.url = item.providerUrl;
        item.artworkCandidates = [];
        item.artworkHints = { recordingId: item.id, artistId: item.artistId, title: item.title, artist: item.author };
        item.contributors = mbCredits(value).contributors;
        const releases = (value.releases || []).filter(x => UUID.test(x.id || ''));
        const chosen = releases.find(x => x.status === 'Official') || releases[0];
        if (chosen) {
            const groupId = chosen['release-group']?.id;
            item.releaseId = providerId('musicbrainz', 'release', chosen.id);
            item.albumId = UUID.test(groupId || '') ? providerId('musicbrainz', 'album', groupId) : '';
            item.releaseGroupId = item.albumId; item.album = clean(chosen['release-group']?.title || chosen.title);
            item.releaseDate ||= clean(chosen.date, 40);
            item.thumbnail = `https://coverartarchive.org/release/${chosen.id}/front-500`;
            item.artworkCandidates = [item.thumbnail, ...(item.albumId ? [`https://coverartarchive.org/release-group/${groupId}/front-500`] : [])];
            item.provenance.artworkSource = 'Cover Art Archive release candidate';
        }
    }
    return item;
}
function unique(items) {
    const seen = new Set();
    return items.filter(item => {
        if (!item || !item.id) return false;
        const key = item.kind === 'album' && nameKey(item.author)
            ? `album:${albumFamily(item.title)}:${nameKey(item.author)}:${String(item.releaseDate || '').slice(0, 4)}`
            : item.id;
        if (seen.has(key)) return false;
        seen.add(key); return true;
    });
}
function recordingKey(item) {
    return `${nameKey(item?.author)}:${nameKey(item?.title).replace(/[()[\]]/g, ' ').replace(/\s*[-–—:]\s*/g, ' ').replace(/\s+/g, ' ').trim()}`;
}
function sameRecording(a, b) {
    if (a?.id && a.id === b?.id) return true;
    if (!a?.title || !a.author || !b?.title || !b.author || recordingKey(a) !== recordingKey(b)) return false;
    return !(a.duration > 0 && b.duration > 0) || Math.abs(a.duration - b.duration) <= 12;
}
function uniqueRecordings(items) {
    const byKey = new Map(), seen = new Set(), output = [];
    for (const item of items || []) {
        if (!item?.id || seen.has(item.id)) continue;
        seen.add(item.id);
        const key = recordingKey(item), previous = byKey.get(key) || [];
        if (previous.some(x => sameRecording(x, item))) continue;
        previous.push(item); byKey.set(key, previous); output.push(item);
    }
    return output;
}
function mbReleaseItem(value) {
    if (!UUID.test(value?.id || '')) return null;
    const group = value['release-group'] || {};
    const base = mbItem({ ...group, 'artist-credit': value['artist-credit'] || group['artist-credit'] }, 'album') || {};
    const id = providerId('musicbrainz', 'release', value.id);
    const title = clean(value.title || group.title);
    if (!title) return null;
    const thumbnail = `https://coverartarchive.org/release/${value.id}/front-500`;
    return { ...base, kind: 'album', id, title, provider: 'musicbrainz', author: mbCredit(value) || base.author || '',
        artistId: providerId('musicbrainz', 'artist', mbArtistId(value)) || base.artistId || '', releaseId: id,
        releaseGroupId: UUID.test(group.id || '') ? providerId('musicbrainz', 'album', group.id) : '',
        releaseDate: clean(value.date || base.releaseDate, 40), recordType: base.recordType || 'album',
        contributors: mbCredits(value, 'release').contributors, thumbnail,
        artworkCandidates: [thumbnail, ...(UUID.test(group.id || '') ? [`https://coverartarchive.org/release-group/${group.id}/front-500`] : [])],
        providerUrl: `https://musicbrainz.org/release/${value.id}`, subtitle: [clean(value.country), clean(value.disambiguation)].filter(Boolean).join(' · '),
        provenance: provenance('musicbrainz', `/release/${value.id}`, 'Cover Art Archive release candidate') };
}
function uniqueIssues(issues) {
    const byProvider = new Map();
    for (const issue of issues) {
        const previous = byProvider.get(issue.provider);
        if (!previous || issue.status === 'unavailable' || previous.status !== 'unavailable') byProvider.set(issue.provider, issue);
    }
    return [...byProvider.values()];
}
function requestControls(opts = {}, extra = {}) {
    return { ...extra,
        ...(Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0 ? { timeoutMs: Number(opts.timeoutMs) } : {}),
        ...(Number.isFinite(Number(opts.deadlineAt)) ? { deadlineAt: Number(opts.deadlineAt) } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
    };
}

function createPlatformCatalog(options = {}) {
    const fetchImpl = options.fetch || globalThis.fetch;
    const now = options.now || Date.now;
    const timeoutMs = Math.max(20, Math.min(15000, Number(options.timeoutMs) || 12000));
    const queueTimeoutMs = Math.max(50, Math.min(60000, Number(options.queueTimeoutMs) || 60000));
    const intervals = { deezer: 150, itunes: 3100, musicbrainz: 1100, applecharts: 3100, youtube: 150, ...options.providerIntervalsMs };
    const concurrency = { deezer: 2, itunes: 1, musicbrainz: 1, applecharts: 1, youtube: 2 };
    const gates = new Map(), cache = new Map(), inflight = new Map(), states = new Map(), artistIdentities = new Map(), albumIdentities = new Map();
    const maxCache = Math.max(50, Math.min(1000, Number(options.maxCache) || 350));
    const maxProviderQueue = Math.max(50, Math.min(10000, Number(options.maxProviderQueue) || 1024));
    const sourceSearch = options.search || ((q, args) => require('./ytDlpProvider').search(q, args));
    const playlistTrackLimit = Math.max(1, Math.min(10000, Number(options.playlistTrackLimit) || 2000));
    const trackPaginationPages = Math.max(1, Math.min(100, Number(options.trackPaginationPages) || 50));
    const trackPaginationTimeoutMs = Math.max(20, Math.min(60000, Number(options.trackPaginationTimeoutMs) || 30000));

    function limited(provider, work, controls = {}) {
        let gate = gates.get(provider);
        if (!gate) { gate = { active: 0, queue: [], nextAt: 0, timer: null }; gates.set(provider, gate); }
        if (gate.queue.length >= maxProviderQueue) return Promise.reject(problem(`${provider} request queue is full.`));
        return new Promise((resolve, reject) => {
            const job = { work, resolve, reject, timer: null, removeAbort: () => {} };
            const cancel = () => {
                const i = gate.queue.indexOf(job);
                if (i >= 0) { gate.queue.splice(i, 1); clearTimeout(job.timer); job.removeAbort(); reject(problem(`${provider} request was cancelled.`, 'CATALOG_CANCELLED')); }
            };
            if (controls.signal?.aborted) { reject(problem(`${provider} request was cancelled.`, 'CATALOG_CANCELLED')); return; }
            controls.signal?.addEventListener('abort', cancel, { once: true });
            job.removeAbort = () => controls.signal?.removeEventListener('abort', cancel);
            const waitLimit = controls.deadlineAt ? Math.max(1, Math.min(queueTimeoutMs, controls.deadlineAt - Date.now())) : queueTimeoutMs;
            job.timer = setTimeout(() => {
                const i = gate.queue.indexOf(job);
                if (i >= 0) { gate.queue.splice(i, 1); job.removeAbort(); reject(problem(`${provider} request waited too long.`)); }
            }, waitLimit);
            gate.queue.push(job); pump(provider, gate);
        });
    }
    function pump(provider, gate) {
        if (gate.timer || !gate.queue.length || gate.active >= concurrency[provider]) return;
        const wait = Math.max(0, gate.nextAt - Date.now());
        if (wait) { gate.timer = setTimeout(() => { gate.timer = null; pump(provider, gate); }, wait); return; }
        const job = gate.queue.shift(); clearTimeout(job.timer); job.removeAbort();
        gate.active++; gate.nextAt = Date.now() + Math.max(0, Number(intervals[provider]) || 0);
        Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => { gate.active--; pump(provider, gate); });
        pump(provider, gate);
    }
    async function deadline(work, label, controls = {}) {
        const controller = new AbortController(); let timer;
        const abort = () => controller.abort();
        controls.signal?.addEventListener('abort', abort, { once: true });
        if (controls.signal?.aborted) controller.abort();
        const requestedTimeout = Number(controls.timeoutMs);
        const requestBudget = Number.isFinite(requestedTimeout) && requestedTimeout > 0
            ? Math.max(20, Math.min(60000, requestedTimeout)) : timeoutMs;
        const budget = controls.deadlineAt ? Math.max(1, Math.min(requestBudget, controls.deadlineAt - Date.now())) : requestBudget;
        try {
            return await Promise.race([
                Promise.resolve().then(() => { if (controller.signal.aborted) throw problem(`${label} request was cancelled.`, 'CATALOG_CANCELLED'); return work(controller.signal); }),
                new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(problem(`${label} timed out.`)); }, budget); }),
                ...(controls.signal ? [new Promise((_, reject) => {
                    const fail = () => reject(problem(`${label} request was cancelled.`, 'CATALOG_CANCELLED'));
                    if (controls.signal.aborted) fail(); else controller.signal.addEventListener('abort', fail, { once: true });
                })] : []),
            ]);
        } finally { clearTimeout(timer); controls.signal?.removeEventListener('abort', abort); controller.abort(); }
    }
    function addIssue(issues, provider, error, stale = false) {
        const issue = { provider, status: stale ? 'stale' : 'unavailable', message: clean(error.message, 250) };
        issues.push(issue);
        states.set(provider, { provider, status: 'unavailable', message: issue.message, hasCachedMetadata: stale,
            checkedAt: new Date(now()).toISOString(), retryAt: Date.now() + 30000 });
        return issue;
    }
    async function request(provider, endpoint, issues, ttl = 10 * 60_000, controls = {}) {
        const key = `${provider}:${endpoint}:${controls.cacheScope || ''}`, hit = cache.get(key);
        if (controls.signal?.aborted || controls.deadlineAt && controls.deadlineAt <= Date.now()) throw problem(`${provider} request timed out.`, 'CATALOG_CANCELLED');
        if (hit && hit.expires > now() && !controls.refresh) { if (hit.issue) issues.push(hit.issue); return clone(hit.data); }
        const circuit = states.get(provider);
        if (circuit?.status === 'unavailable' && circuit.retryAt > Date.now()) {
            if (hit && now() - hit.at < 86400000) { const issue = { provider, status: 'stale', message: 'Showing cached metadata while this provider is unavailable.' }; issues.push(issue); return clone(hit.data); }
            const { retryAt, ...visible } = circuit;
            issues.push(visible); throw problem(`${provider} is temporarily unavailable.`);
        }
        const shared = !controls.signal && !controls.deadlineAt;
        let promise = shared ? inflight.get(key) : null;
        if (!promise) {
            promise = limited(provider, () => deadline(async signal => {
                const current = states.get(provider);
                if (current?.status === 'unavailable' && current.retryAt > Date.now()) throw problem(`${provider} is temporarily unavailable.`);
                let response, cancelled = false, consumed = false;
                const cancelBody = () => {
                    if (cancelled || consumed || !response?.body?.cancel) return;
                    cancelled = true;
                    Promise.resolve().then(() => response.body.cancel()).catch(() => {});
                };
                signal.addEventListener('abort', cancelBody, { once: true });
                try {
                    response = await fetchImpl(`${BASES[provider]}${endpoint}`, {
                        signal, headers: { Accept: 'application/json', 'User-Agent': 'MusicByA/7.2 (personal music player; https://musicbrainz.org)' },
                    });
                    if (signal.aborted) throw problem(`${provider} request was cancelled.`, 'CATALOG_CANCELLED');
                    if (!response.ok) throw problem(`${provider} returned HTTP ${response.status}.`);
                    if (Number(response.headers?.get?.('content-length') || 0) > 5 * 1024 * 1024) throw problem(`${provider} metadata was too large.`);
                    const data = await response.json(); consumed = true;
                    if (data?.error) throw problem(`${provider}: ${clean(data.error.message || data.error.type || 'provider error', 160)}`);
                    return data;
                } catch (error) { cancelBody(); throw error; }
                finally { signal.removeEventListener('abort', cancelBody); }
            }, provider, controls), controls);
            if (shared) {
                inflight.set(key, promise);
                promise.finally(() => { if (inflight.get(key) === promise) inflight.delete(key); }).catch(() => {});
            }
        }
        try {
            const data = await promise;
            cache.delete(key); cache.set(key, { data, at: now(), expires: now() + ttl });
            while (cache.size > maxCache) cache.delete(cache.keys().next().value);
            states.set(provider, { provider, status: 'available', checkedAt: new Date(now()).toISOString() });
            return clone(data);
        } catch (error) {
            const stale = Boolean(hit && now() - hit.at < 86400000);
            const issue = error.code === 'CATALOG_CANCELLED' ? { provider, status: 'partial', message: clean(error.message, 250) } : addIssue(issues, provider, error, stale);
            if (error.code === 'CATALOG_CANCELLED') issues.push(issue);
            if (stale) { cache.set(key, { ...hit, issue, expires: now() + 15000 }); return clone(hit.data); }
            throw error;
        }
    }
    async function attempt(work, fallback = null) { try { return await work(); } catch (_) { return fallback; } }
    function rememberArtists(items) {
        const remember = artist => {
            if (!artist?.id || !artist.title) return;
            const old = artistIdentities.get(artist.id);
            artistIdentities.delete(artist.id); artistIdentities.set(artist.id, { ...old, ...artist, samples: old?.samples || [] });
        };
        for (const item of items || []) {
            if (item?.kind === 'artist') remember(item);
            else if (item?.kind === 'track' && item.artistId && item.author) {
                const primary = (item.contributors || []).find(x => x.id === item.artistId);
                remember({ kind: 'artist', id: item.artistId, title: primary?.title || item.author, provider: item.provider });
                const identity = artistIdentities.get(item.artistId);
                identity.samples = uniqueRecordings([...identity.samples, item]).slice(0, 10);
            }
        }
        while (artistIdentities.size > maxCache) artistIdentities.delete(artistIdentities.keys().next().value);
    }
    function rememberAlbums(items) {
        for (const item of items || []) {
            if (item?.kind !== 'album' || !item.id || !item.title || !item.author) continue;
            albumIdentities.delete(item.id);
            albumIdentities.set(item.id, { id: item.id, title: item.title, author: item.author, provider: item.provider,
                artistId: item.artistId || '', genres: item.genres || [], thumbnail: item.thumbnail || '' });
        }
        while (albumIdentities.size > maxCache) albumIdentities.delete(albumIdentities.keys().next().value);
    }
    function result(items, issues, extra = {}) {
        const selected = unique(items || []); rememberArtists(selected); rememberAlbums(selected);
        return { items: selected, ...extra, degradedProviders: uniqueIssues(issues), freshness: { generatedAt: new Date(now()).toISOString(), cacheSeconds: 600 } };
    }
    function countryOf(value) { const c = clean(value || options.country || 'US', 2).toUpperCase(); return /^[A-Z]{2}$/.test(c) ? c : 'US'; }
    function itunesQuery(q, kind, opts) {
        const limit = Math.max(1, Math.min(100, Math.floor(Number(opts?.limit) || 50)));
        const params = new URLSearchParams({ term: q, media: kind === 'video' ? 'musicVideo' : 'music',
            entity: { track: 'song', album: 'album', artist: 'musicArtist', video: 'musicVideo' }[kind],
            country: countryOf(opts.country), limit: String(limit), explicit: opts.clean ? 'No' : 'Yes' });
        return `/search?${params}`;
    }
    async function sourceItems(query, kind, issues, opts = {}) {
        try {
            const sourceQuery = /^https?:\/\//i.test(query) ? query : `${query}${kind === 'video' ? ' official music video' : ' official audio'}`;
            // A child-process metadata search may ignore AbortSignal. The caller
            // still has a deadline, while its real operation retains the worker
            // slot until completion, protecting audio from accumulating jobs.
            const controls = requestControls(opts);
            const items = await deadline(signal => limited('youtube', () => {
                if (signal.aborted) throw problem('Playable source search was cancelled before it started.');
                return sourceSearch(sourceQuery, { limit: 20, signal, ...(controls.timeoutMs ? { timeoutMs: controls.timeoutMs } : {}) });
            }, { ...controls, signal }), 'Playable source search', controls);
            return (Array.isArray(items) ? items : []).filter(x => http(x?.url) && (kind !== 'video' || /(?:youtube\.com|youtu\.be)/i.test(x.url))).map(x => {
                const videoId = /(?:[?&]v=|youtu\.be\/)([\w-]{11})/.exec(x.url)?.[1];
                return { ...x, kind, id: videoId ? providerId('youtube', kind === 'video' ? 'video' : 'track', videoId) : `${x.provider || 'source'}:${kind}:${normalizeUrl(x.url)}`,
                    title: clean(x.title), author: clean(x.author), provider: x.provider || x.source || 'youtube', url: http(x.url), duration: Number(x.duration || 0) };
            });
        } catch (error) { addIssue(issues, 'youtube', error); return []; }
    }
    async function searchType(query, type, opts, issues) {
        const kind = TYPES[type], limit = Math.max(1, Math.min(100, Math.floor(Number(opts?.limit) || 50))); let items = [];
        if (kind !== 'video') {
            const endpoint = `/search${kind === 'track' ? '' : `/${kind}`}?${new URLSearchParams({ q: query, limit: String(limit) })}`;
            const data = await attempt(() => request('deezer', endpoint, issues, 10 * 60_000,
                requestControls(opts, { cacheScope: countryOf(opts.country), refresh: opts.refresh })));
            items = list(data).map(x => kind === 'track' ? deezerTrack(x) : kind === 'album' ? deezerAlbum(x) : deezerArtist(x)).filter(Boolean);
            if (kind === 'artist') items = canonicalArtists(items, query);
        }
        if (!items.length || kind === 'artist' && !items.some(x => nameKey(x.title) === nameKey(query))) {
            const data = await attempt(() => request('itunes', itunesQuery(query, kind, opts), issues, 10 * 60_000,
                requestControls(opts, { cacheScope: countryOf(opts.country), refresh: opts.refresh })));
            const found = (data?.results || []).map(x => itunesItem(x, kind)).filter(x => x?.kind === kind);
            items = kind === 'artist' ? canonicalArtists([...items, ...found], query) : found;
        }
        if ((!items.length || kind === 'artist' && !items.some(x => nameKey(x.title) === nameKey(query))) && kind !== 'video') {
            const entity = kind === 'track' ? 'recording' : kind === 'album' ? 'release-group' : 'artist';
            const data = await attempt(() => request('musicbrainz', `/${entity}?${new URLSearchParams({ query, limit: String(limit), fmt: 'json' })}`, issues,
                10 * 60_000, requestControls(opts, { cacheScope: countryOf(opts.country), refresh: opts.refresh })));
            const found = (data?.[kind === 'track' ? 'recordings' : kind === 'album' ? 'release-groups' : 'artists'] || []).map(x => mbItem(x, kind)).filter(Boolean);
            items = kind === 'artist' ? canonicalArtists([...items, ...found], query) : found;
        }
        if (!items.length && (kind === 'track' || kind === 'video')) items = await sourceItems(query, kind, issues, opts);
        return items;
    }
    async function search(query, type = 'all', opts = {}) {
        const q = clean(query, 160), issues = [];
        if (!['all', ...Object.keys(TYPES)].includes(type)) throw problem('Unsupported search type.', 'INVALID_SEARCH_TYPE', 400);
        if (q.length < 2) return result([], issues);
        const selected = type === 'all' ? Object.keys(TYPES) : [type];
        const found = await Promise.all(selected.map(async key => ({ key, items: await searchType(q, key, opts, issues) })));
        const artistSection = found.find(x => x.key === 'artists');
        let similarArtists = [];
        if (artistSection) {
            artistSection.items = canonicalArtists(artistSection.items, q);
            const exact = artistSection.items.find(x => nameKey(x.title) === nameKey(q));
            if (exact) {
                const related = await artistSimilar(exact.id, { limit: 15, signal: opts.signal, timeoutMs: options.relatedSearchTimeoutMs || 2000 });
                issues.push(...related.degradedProviders);
                similarArtists = related.items.filter(x => x.id !== exact.id && nameKey(x.title) !== nameKey(exact.title));
            }
        }
        const sections = found.map(x => ({ id: x.key, title: x.key[0].toUpperCase() + x.key.slice(1), type: x.key === 'tracks' ? 'tracks' : x.key === 'artists' ? 'artists' : 'cards', items: unique(x.items) }));
        if (similarArtists.length) sections.push({ id: 'similar-artists', title: 'Similar artists', type: 'artists', items: similarArtists });
        return result(found.flatMap(x => x.items), issues, { sections, similarArtists });
    }
    async function searchPlaylists(query, opts = {}) {
        const q = clean(query, 160), issues = [];
        if (q.length < 2) return result([], issues, { query: q });
        const limit = Math.max(1, Math.min(100, Math.floor(Number(opts.limit) || 50)));
        const endpoint = `/search/playlist?${new URLSearchParams({ q, limit: String(limit) })}`;
        const data = await attempt(() => request('deezer', endpoint, issues, 30 * 60_000,
            requestControls(opts, { cacheScope: countryOf(opts.country), refresh: opts.refresh })));
        return result(list(data).map(deezerPlaylist).filter(Boolean), issues, { query: q,
            playlistSource: 'Deezer catalog search', provenance: provenance('deezer', endpoint) });
    }
    async function genres() {
        const issues = [];
        const data = await attempt(() => request('deezer', '/genre', issues, 86400000));
        let items = list(data).filter(x => x.id && x.name).map(x => ({ id: providerId('deezer', 'genre', x.id), title: clean(x.name, 100),
            thumbnail: http(x.picture_big || x.picture_medium), provider: 'deezer' }));
        if (!items.length) {
            const mb = await attempt(() => request('musicbrainz', '/genre/all?limit=100&fmt=json', issues, 86400000));
            items = (mb?.genres || []).map(x => ({ id: `musicbrainz:genre:${x.id}`, title: clean(x.name, 100), provider: 'musicbrainz' }));
        }
        return result(items, issues);
    }
    async function genreId(value, issues) {
        if (!value) return 0;
        const direct = /^deezer:genre:(\d+)$/.exec(String(value));
        if (direct) return Number(direct[1]);
        if (/^\d+$/.test(String(value))) return Number(value);
        const data = await genres(); issues.push(...data.degradedProviders);
        const match = data.items.find(x => nameKey(x.title) === nameKey(value));
        return Number(/^deezer:genre:(\d+)$/.exec(match?.id || '')?.[1] || 0);
    }
    async function genreName(value, issues) {
        if (!value) return '';
        if (/^(?:deezer:genre:)?\d+$/.test(String(value)) || /^musicbrainz:genre:/.test(String(value))) {
            const data = await genres(); issues.push(...data.degradedProviders);
            return data.items.find(x => x.id === value || x.id === `deezer:genre:${value}`)?.title || '';
        }
        return clean(value, 100);
    }
    function rssItems(data, kind) {
        return list(data?.feed?.entry).map(entry => {
            const id = entry.id?.attributes?.['im:id'];
            const name = entry['im:name']?.label, author = entry['im:artist']?.label;
            if (!id || !name) return null;
            const collection = entry['im:collection'];
            const originalUrl = http(entry.id?.label);
            const item = { kind, id: providerId('itunes', kind, id), title: clean(name), author: clean(author), provider: 'itunes',
                thumbnail: http(entry['im:image']?.at(-1)?.label).replace(/\d+x\d+bb\./, '600x600bb.'),
                providerUrl: originalUrl, album: clean(collection?.['im:name']?.label),
                albumId: providerId('itunes', 'album', collection?.link?.attributes?.href?.match(/\/id(\d+)/)?.[1]),
                releaseDate: clean(entry['im:releaseDate']?.label, 40), genre: clean(entry.category?.attributes?.label, 100),
                genres: entry.category?.attributes?.label ? [clean(entry.category.attributes.label, 100)] : [],
                provenance: provenance('itunes', 'iTunes RSS chart', 'Apple catalog artwork') };
            if (kind === 'track') { item.url = originalUrl; item.metadataOnly = true; }
            return item;
        }).filter(Boolean);
    }
    function appleChartItems(data, kind, endpoint) {
        return (data?.feed?.results || []).map(value => {
            if (!/^\d{1,20}$/.test(String(value.id || '')) || !value.name) return null;
            const artistId = String(value.artistId || /\/artist\/(?:[^/?#]+\/)?(\d+)/.exec(value.artistUrl || '')?.[1] || '');
            const item = { kind, id: providerId('itunes', kind, value.id), title: clean(value.name), author: clean(value.artistName),
                artistId: /^\d{1,20}$/.test(artistId) ? providerId('itunes', 'artist', artistId) : '', provider: 'itunes',
                providerUrl: http(value.url), thumbnail: http(value.artworkUrl100).replace(/\d+x\d+bb\./, '600x600bb.'),
                releaseDate: clean(value.releaseDate, 40), genres: (value.genres || []).map(x => clean(x.name, 100)).filter(Boolean),
                provenance: provenance('applecharts', endpoint, 'Apple catalog artwork') };
            item.genre = item.genres[0] || '';
            if (kind === 'track') { item.url = item.providerUrl; item.metadataOnly = true; }
            else item.recordType = 'album';
            if (item.artistId && value.artistName) item.chartArtist = { kind: 'artist', id: item.artistId, title: clean(value.artistName),
                author: clean(value.artistName), provider: 'itunes', providerUrl: http(value.artistUrl), thumbnail: '',
                chartDerived: true, provenance: provenance('applecharts', endpoint, 'Artist attribution; portrait unavailable') };
            return item;
        }).filter(Boolean);
    }
    async function appleMostPlayed(kind, opts, issues) {
        const country = countryOf(opts.country).toLowerCase(), media = kind === 'album' ? 'albums' : 'songs';
        const endpoint = `/api/v2/${country}/music/most-played/50/${media}.json`;
        const data = await attempt(() => request('applecharts', endpoint, issues, 10 * 60_000,
            requestControls(opts, { refresh: opts.refresh })));
        const items = appleChartItems(data, kind, endpoint);
        return opts.genreName ? items.filter(x => x.genres.some(genre => nameKey(genre) === nameKey(opts.genreName))) : items;
    }
    async function charts(opts = {}) {
        const issues = [], id = await genreId(opts.genre, issues);
        const requestedGenre = await genreName(opts.genre, issues);
        if (opts.genre && !requestedGenre) throw problem('This genre is unavailable from the catalog provider.', 'INVALID_GENRE', 400);
        const feedOpts = { ...opts, genreName: requestedGenre };
        const data = !opts.genre || id > 0 ? await attempt(() => request('deezer', `/chart/${id}?limit=60`, issues, 10 * 60_000,
            requestControls(opts, { cacheScope: countryOf(opts.country), refresh: opts.refresh }))) : null;
        let tracks = list(data?.tracks).map(deezerTrack).filter(Boolean), albums = list(data?.albums).map(x => deezerAlbum(x)).filter(Boolean);
        let artists = list(data?.artists).map(deezerArtist).filter(Boolean), playlists = list(data?.playlists).map(deezerPlaylist).filter(Boolean);
        const sources = { tracks: tracks.length ? 'Deezer public charts' : '', albums: albums.length ? 'Deezer public charts' : '', artists: artists.length ? 'Deezer public charts' : '' };
        const [appleTracks, appleAlbums] = await Promise.all([
            !tracks.length ? appleMostPlayed('track', feedOpts, issues) : [],
            !albums.length ? appleMostPlayed('album', feedOpts, issues) : [],
        ]);
        if (!tracks.length && appleTracks.length) { tracks = appleTracks; sources.tracks = 'Apple Music most-played'; }
        if (!albums.length && appleAlbums.length) { albums = appleAlbums; sources.albums = 'Apple Music most-played'; }
        if (!tracks.length || !albums.length) {
            const country = countryOf(opts.country).toLowerCase();
            const [songs, collections] = await Promise.all([
                !tracks.length ? attempt(() => request('itunes', `/${country}/rss/topsongs/limit=50/json`, issues, 10 * 60_000, requestControls(opts))) : null,
                !albums.length ? attempt(() => request('itunes', `/${country}/rss/topalbums/limit=30/json`, issues, 10 * 60_000, requestControls(opts))) : null,
            ]);
            const genreMatch = item => !requestedGenre || item.genres.some(genre => nameKey(genre) === nameKey(requestedGenre));
            if (!tracks.length) { tracks = rssItems(songs, 'track').filter(genreMatch); if (tracks.length) sources.tracks = 'iTunes regional charts'; }
            if (!albums.length) { albums = rssItems(collections, 'album').filter(genreMatch); if (albums.length) sources.albums = 'iTunes regional charts'; }
        }
        if (!artists.length) {
            artists = canonicalArtists([...tracks, ...albums].flatMap(x => x.chartArtist ? [x.chartArtist] : []));
            if (artists.length) sources.artists = 'Apple Music chart artist attribution';
        }
        tracks = tracks.map(({ chartArtist, ...item }) => item); albums = albums.map(({ chartArtist, ...item }) => item);
        return { tracks: unique(tracks), albums: unique(albums), artists: unique(artists), playlists: unique(playlists), videos: [],
            items: unique([...tracks, ...albums, ...artists]), country: countryOf(opts.country), chartSources: sources,
            chartRegions: Object.fromEntries(Object.entries(sources).map(([kind, source]) => [kind, source.startsWith('Deezer') ? 'global' : source ? countryOf(opts.country) : 'unavailable'])),
            degradedProviders: uniqueIssues(issues), freshness: { generatedAt: new Date(now()).toISOString(), cacheSeconds: 600 },
            chartSource: [...new Set(Object.values(sources).filter(Boolean))].join(' · ') || 'Unavailable' };
    }
    async function releases(opts = {}) {
        const issues = [], id = await genreId(opts.genre, issues);
        const requestedGenre = await genreName(opts.genre, issues);
        if (opts.genre && !requestedGenre) throw problem('This genre is unavailable from the catalog provider.', 'INVALID_GENRE', 400);
        const data = !opts.genre || id > 0 ? await attempt(() => request('deezer', `/editorial/${id}/releases?limit=50`, issues, 10 * 60_000,
            requestControls(opts, { cacheScope: countryOf(opts.country), refresh: opts.refresh }))) : null;
        const days = Math.max(7, Math.min(365, Number(opts.days) || 60));
        const end = new Date(now()).toISOString().slice(0, 10), start = new Date(now() - days * 86400000).toISOString().slice(0, 10);
        let items = list(data).map(x => ({ ...deezerAlbum(x), providerNewRelease: true })).filter(x => x.id
            && (!x.releaseDate || x.releaseDate.slice(0, 10) >= start && x.releaseDate.slice(0, 10) <= end));
        let releaseSource = items.length ? 'Deezer new-release editorial' : '';
        if (!items.length) {
            items = (await appleMostPlayed('album', { ...opts, genreName: requestedGenre }, issues)).filter(x => x.releaseDate && x.releaseDate.slice(0, 10) >= start && x.releaseDate.slice(0, 10) <= end);
            if (items.length) releaseSource = 'Dated albums from Apple Music most-played';
        }
        if (!items.length) {
            const genre = requestedGenre ? ` AND tag:"${requestedGenre.replace(/["\\]/g, '')}"` : '';
            const query = `primarytype:album AND firstreleasedate:[${start} TO ${end}]${genre}`;
            const mb = await attempt(() => request('musicbrainz', `/release-group?${new URLSearchParams({ query, limit: '50', fmt: 'json' })}`, issues, 10 * 60_000,
                requestControls(opts, { cacheScope: countryOf(opts.country), refresh: opts.refresh })));
            items = (mb?.['release-groups'] || []).map(x => mbItem(x, 'album')).filter(x => x && x.releaseDate
                && x.releaseDate.slice(0, 10) >= start && x.releaseDate.slice(0, 10) <= end
                && (!requestedGenre || !x.genres.length || x.genres.some(genre => nameKey(genre) === nameKey(requestedGenre))));
            if (items.length) releaseSource = 'MusicBrainz dated releases';
        }
        items.sort((a, b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')));
        return result(items, issues, { albums: unique(items), tracks: [], artists: [], country: countryOf(opts.country), window: { from: start, to: end }, releaseSource: releaseSource || 'Unavailable' });
    }
    async function editorial(opts = {}) {
        const issues = [], id = await genreId(opts.genre, issues);
        const data = !opts.genre || id > 0 ? await attempt(() => request('deezer', `/editorial/${id}/selection?limit=40`, issues, 30 * 60_000,
            requestControls(opts, { cacheScope: countryOf(opts.country), refresh: opts.refresh }))) : null;
        const albums = list(data?.albums || data).map(x => deezerAlbum(x)).filter(Boolean);
        const tracks = list(data?.tracks).map(deezerTrack).filter(Boolean);
        const playlists = list(data?.playlists).map(deezerPlaylist).filter(Boolean);
        if (!albums.length && !tracks.length && !playlists.length) {
            const fallback = await charts(opts);
            return { ...fallback, degradedProviders: uniqueIssues([...issues, ...fallback.degradedProviders]), curationSource: fallback.chartSource };
        }
        return { albums, tracks, playlists, artists: [], curationSource: 'Deezer editorial selection', degradedProviders: uniqueIssues(issues) };
    }
    async function browse(opts = {}) {
        const hasDecade = opts.decade != null && String(opts.decade).trim() !== '';
        const decade = hasDecade ? Number(String(opts.decade).replace(/s$/, '')) : undefined;
        if (hasDecade && (!Number.isInteger(decade) || decade < 1900 || decade > 2090 || decade % 10)) throw problem('Invalid catalog decade.', 'INVALID_DECADE', 400);
        const issues = [];
        const genre = clean(await genreName(opts.genre, issues), 100).replace(/["\\]/g, '');
        if (opts.genre && !genre) throw problem('This genre is unavailable from the catalog provider.', 'INVALID_GENRE', 400);
        const mood = clean(opts.mood, 80).replace(/["\\]/g, '');
        if (!hasDecade && !genre && !mood) throw problem('Choose a genre, mood or decade.', 'INVALID_BROWSE_FILTER', 400);
        const range = hasDecade ? `firstreleasedate:[${decade}-01-01 TO ${decade + 9}-12-31]` : '';
        const requestedTags = [genre, mood].filter(Boolean);
        const clauses = [range, ...requestedTags.map(value => `tag:"${value}"`)].filter(Boolean);
        const query = clauses.join(' AND ');
        const [recordings, groups] = await Promise.all([
            attempt(() => request('musicbrainz', `/recording?${new URLSearchParams({ query, limit: '100', fmt: 'json' })}`, issues, 6 * 3600000)),
            attempt(() => request('musicbrainz', `/release-group?${new URLSearchParams({ query: `primarytype:album AND ${query}`, limit: '100', fmt: 'json' })}`, issues, 6 * 3600000)),
        ]);
        const matches = item => {
            if (!item) return false;
            if (hasDecade) { const year = Number(String(item.releaseDate || '').slice(0, 4)); if (year < decade || year >= decade + 10 || !year) return false; }
            // The provider query supplies the tag constraint. When response tags
            // are present they must agree; title words never supply a mood tag.
            return !item.genres.length || requestedTags.every(tag => item.genres.some(value => nameKey(value) === nameKey(tag)));
        };
        const tracks = (recordings?.recordings || []).map(x => mbItem(x, 'track')).filter(matches);
        const albums = (groups?.['release-groups'] || []).map(x => mbItem(x, 'album')).filter(matches);
        return { tracks, albums, items: [...tracks, ...albums], degradedProviders: uniqueIssues(issues), genre, mood,
            selectionReason: `Provider tags${requestedTags.length ? `: ${requestedTags.join(', ')}` : ''}${hasDecade ? `; release dates in the ${decade}s` : ''}`,
            ...(hasDecade ? { decade } : {}), provenance: provenance('musicbrainz', query, 'Provider tags and release dates') };
    }
    function pagingOptions(opts = {}) {
        const offset = Math.max(0, Math.min(100000, Math.floor(Number(opts.offset) || 0)));
        const limit = Math.max(1, Math.min(100, Math.floor(Number(opts.limit) || 100)));
        return { ...opts, offset, limit, deadlineAt: opts.deadlineAt || Date.now() + Math.min(trackPaginationTimeoutMs, Math.max(20, Number(opts.timeoutMs) || trackPaginationTimeoutMs)) };
    }
    async function typedPage(provider, endpoint, extract, mapper, opts = {}) {
        const page = pagingOptions(opts), issues = [];
        let data;
        try { data = await request(provider, endpoint, issues, 10 * 60_000, { signal: page.signal, deadlineAt: page.deadlineAt, cacheScope: page.country }); }
        catch (error) {
            if (!issues.length) issues.push({ provider, status: 'partial', message: clean(error.message, 250) });
            return result([], issues, { offset: page.offset, requestedOffset: page.offset, limit: page.limit, returned: 0,
                observed: 0, nextOffset: null, hasMore: false, partial: true, complete: false, provenance: provenance(provider, endpoint) });
        }
        const source = extract(data), rows = source.rows || [];
        const offset = Number.isInteger(Number(source.offset)) && source.offset != null ? Number(source.offset) : page.offset;
        const totalKnown = source.total != null && Number.isInteger(Number(source.total)) && Number(source.total) >= 0;
        const total = totalKnown ? Number(source.total) : undefined;
        const nextOffset = offset + rows.length;
        let partial = false, validNext = Boolean(source.next);
        if (source.next && provider === 'deezer') {
            let next;
            try { next = new URL(source.next); } catch (_) {}
            validNext = Boolean(next && next.origin === BASES.deezer && !next.username && !next.password && !next.hash && next.pathname === new URL(endpoint, BASES.deezer).pathname);
            if (!validNext) { partial = true; issues.push({ provider, status: 'partial', message: 'The provider returned an invalid continuation.' }); }
        }
        const hasMore = Boolean(rows.length && !partial && (validNext || totalKnown && nextOffset < total));
        if (!rows.length && (source.next || totalKnown && offset < total)) {
            partial = true; issues.push({ provider, status: 'partial', message: 'The provider returned an empty continuation page.' });
        }
        const items = unique(rows.map(mapper).filter(Boolean));
        return result(items, issues, { offset, requestedOffset: page.offset, limit: page.limit, returned: items.length,
            observed: rows.length, nextOffset: hasMore ? nextOffset : null, hasMore, partial, complete: !partial && !hasMore,
            ...(totalKnown ? { total, totalKnown } : { totalKnown }), provenance: provenance(provider, endpoint) });
    }
    const deezerPage = data => ({ rows: list(data), total: data?.total, next: data?.next });
    const mbPage = (field, prefix) => data => ({ rows: data?.[field] || [], total: data?.[`${prefix}-count`] ?? data?.count, offset: data?.[`${prefix}-offset`] });
    async function artistAlbums(id, opts = {}) {
        const parsed = parseId('artist', typeof id === 'object' ? id.id : id), page = pagingOptions(opts);
        if (parsed.provider === 'deezer') return typedPage('deezer', `/artist/${parsed.id}/albums?${new URLSearchParams({ limit: String(page.limit), index: String(page.offset) })}`,
            deezerPage, x => deezerAlbum(x, opts.artist || {}), page);
        if (parsed.provider === 'musicbrainz') return typedPage('musicbrainz', `/release-group?${new URLSearchParams({ artist: parsed.id, limit: String(page.limit), offset: String(page.offset), inc: 'artist-credits+genres', fmt: 'json' })}`,
            mbPage('release-groups', 'release-group'), x => {
                const item = mbItem(x, 'album');
                return item && { ...item, artistId: item.artistId || providerId('musicbrainz', 'artist', parsed.id), author: item.author || opts.artist?.name || '' };
            }, page);
        if (parsed.provider === 'itunes') {
            // The public Apple lookup has no offset parameter. Fetch its bounded
            // collection list once and slice locally without pretending it is complete.
            const issues = [], endpoint = `/lookup?${new URLSearchParams({ id: parsed.id, entity: 'album', limit: '200', country: countryOf(opts.country), sort: 'recent' })}`;
            const data = await attempt(() => request('itunes', endpoint, issues, 10 * 60_000, page));
            const albums = unique((data?.results || []).map(x => itunesItem(x)).filter(x => x?.kind === 'album' && x.artistId === providerId('itunes', 'artist', parsed.id)));
            const items = albums.slice(page.offset, page.offset + page.limit), hasMore = page.offset + items.length < albums.length;
            const capped = (data?.results || []).length >= 200;
            return result(items, issues, { offset: page.offset, limit: page.limit, returned: items.length, observed: items.length,
                total: albums.length, totalKnown: !capped, nextOffset: hasMore ? page.offset + items.length : null, hasMore,
                partial: !data || capped, complete: Boolean(data && !capped && !hasMore), provenance: provenance('itunes', endpoint) });
        }
        return result([], [], { offset: page.offset, returned: 0, nextOffset: null, hasMore: false, partial: true, complete: false });
    }
    async function artistTracks(id, opts = {}) {
        const parsed = parseId('artist', typeof id === 'object' ? id.id : id), page = pagingOptions(opts);
        if (parsed.provider === 'deezer') return typedPage('deezer', `/artist/${parsed.id}/top?${new URLSearchParams({ limit: String(page.limit), index: String(page.offset) })}`, deezerPage, deezerTrack, page);
        if (parsed.provider === 'musicbrainz') return typedPage('musicbrainz', `/recording?${new URLSearchParams({ artist: parsed.id, limit: String(page.limit), offset: String(page.offset), inc: 'artist-credits+genres', fmt: 'json' })}`,
            mbPage('recordings', 'recording'), x => mbItem(x, 'track'), page);
        if (parsed.provider === 'itunes') {
            const issues = [], endpoint = `/lookup?${new URLSearchParams({ id: parsed.id, entity: 'song', limit: '200', country: countryOf(opts.country) })}`;
            const data = await attempt(() => request('itunes', endpoint, issues, 10 * 60_000, page));
            const tracks = unique((data?.results || []).map(x => itunesItem(x)).filter(x => x?.kind === 'track' && x.artistId === providerId('itunes', 'artist', parsed.id)));
            const items = tracks.slice(page.offset, page.offset + page.limit), hasMore = page.offset + items.length < tracks.length;
            const capped = (data?.results || []).length >= 200;
            return result(items, issues, { offset: page.offset, limit: page.limit, returned: items.length, observed: items.length,
                total: tracks.length, totalKnown: !capped, nextOffset: hasMore ? page.offset + items.length : null, hasMore,
                partial: !data || capped, complete: Boolean(data && !capped && !hasMore), provenance: provenance('itunes', endpoint) });
        }
        return result([], [], { offset: page.offset, returned: 0, nextOffset: null, hasMore: false, partial: true, complete: false });
    }
    async function artistSimilar(id, opts = {}) {
        const parsed = parseId('artist', typeof id === 'object' ? id.id : id), page = pagingOptions(opts);
        if (parsed.provider !== 'deezer') return result([], [], { offset: page.offset, returned: 0, nextOffset: null, hasMore: false,
            partial: false, complete: true, recommendationSource: 'unsupported' });
        const data = await typedPage('deezer', `/artist/${parsed.id}/related?${new URLSearchParams({ limit: String(page.limit), index: String(page.offset) })}`,
            deezerPage, deezerArtist, page);
        data.items = canonicalArtists(data.items).filter(x => x.id !== id);
        data.returned = data.items.length; data.recommendationSource = 'provider-related-artists';
        return data;
    }
    async function artistCreditedTracks(id, opts = {}) {
        const parsed = parseId('artist', typeof id === 'object' ? id.id : id), page = pagingOptions(opts);
        if (parsed.provider === 'deezer' && opts.artist?.name) {
            const q = `artist:"${clean(opts.artist.name, 150).replace(/["\\]/g, '')}"`;
            const data = await typedPage('deezer', `/search?${new URLSearchParams({ q, limit: String(page.limit), index: String(page.offset) })}`, deezerPage, deezerTrack, page);
            data.items = data.items.filter(x => x.artistId !== id && x.contributors.some(credit => credit.id === id));
            data.returned = data.items.length; return data;
        }
        if (parsed.provider === 'musicbrainz') {
            const data = await artistTracks(id, page);
            data.items = data.items.filter(x => x.artistId !== id); data.returned = data.items.length; return data;
        }
        return result([], [], { offset: page.offset, returned: 0, nextOffset: null, hasMore: false, partial: false, complete: true, creditSource: 'unsupported' });
    }
    async function artistAppearsOn(id, opts = {}) {
        const parsed = parseId('artist', typeof id === 'object' ? id.id : id), page = pagingOptions(opts);
        if (parsed.provider === 'musicbrainz') return typedPage('musicbrainz', `/release?${new URLSearchParams({ track_artist: parsed.id,
            limit: String(page.limit), offset: String(page.offset), inc: 'artist-credits+release-groups', fmt: 'json' })}`,
            mbPage('releases', 'release'), value => {
                const item = mbReleaseItem(value);
                return item && { ...item, creditArtistId: providerId('musicbrainz', 'artist', parsed.id), creditSource: 'musicbrainz-track-artist' };
            }, page);
        const data = await artistAlbums(id, opts);
        data.items = data.items.filter(x => x.artistId !== id && (x.contributors || []).some(credit => credit.id === id));
        data.returned = data.items.length; return data;
    }
    async function collectArtistPages(method, id, opts, issues) {
        const items = [], visited = new Set();
        let offset = 0, pages = 0, report, reason = '';
        while (pages < trackPaginationPages && items.length < playlistTrackLimit) {
            if (opts.deadlineAt <= Date.now()) { reason = 'Artist pagination timed out.'; break; }
            if (visited.has(offset)) { reason = 'The provider repeated an artist page.'; break; }
            visited.add(offset);
            const page = await method(id, { ...opts, offset, limit: 100 });
            pages++; report = page; issues.push(...page.degradedProviders); items.push(...page.items);
            if (page.partial || !page.hasMore) break;
            offset = page.nextOffset;
        }
        if (report?.hasMore && (pages >= trackPaginationPages || items.length >= playlistTrackLimit)) reason = 'The artist discography preparation limit was reached.';
        const partial = Boolean(reason || report?.partial || report?.hasMore);
        if (reason) issues.push({ provider: id.split(':')[0], status: 'partial', message: reason });
        return { items: unique(items).slice(0, playlistTrackLimit), report: { pages, returned: unique(items).length,
            total: report?.total, totalKnown: Boolean(report?.totalKnown), complete: !partial, partial, reason,
            nextOffset: report?.hasMore ? report.nextOffset : null } };
    }
    async function pagedDeezerTracks(endpoint, issues, context, embedded, opts = {}) {
        const resource = /^\/(album|playlist)\/(\d+)\/tracks(?:\?|$)/.exec(endpoint);
        const limit = resource?.[1] === 'playlist' ? playlistTrackLimit : 500;
        const deadlineAt = opts.deadlineAt || Date.now() + trackPaginationTimeoutMs;
        const tracks = [], seen = new Set(), visited = new Set();
        const rawTotal = context.nb_tracks ?? embedded?.total;
        const totalKnown = rawTotal != null && Number.isInteger(Number(rawTotal)) && Number(rawTotal) >= 0;
        let data = embedded;
        let pages = 0, observed = 0, providerRows = 0, duplicates = 0, truncated = false, reason = '';
        if (!data) {
            try { data = await request('deezer', endpoint, issues, 6 * 3600000, { deadlineAt, signal: opts.signal }); }
            catch (error) { reason = clean(error.message, 250) || 'The first track page is unavailable.'; }
        }
        const consume = page => {
            pages++;
            providerRows += list(page).length;
            for (const value of list(page)) {
                if (tracks.length >= limit) { truncated = true; break; }
                observed++;
                const track = deezerTrack(value, resource?.[1] === 'album' ? context : {});
                if (!track) continue;
                if (seen.has(track.id)) { duplicates++; continue; }
                seen.add(track.id); tracks.push(track);
            }
        };
        consume(data);
        while (data?.next) {
            if (tracks.length >= limit) { truncated = true; reason = 'The track preparation limit was reached.'; break; }
            if (pages >= trackPaginationPages) { truncated = true; reason = 'The provider page limit was reached.'; break; }
            let next;
            try { next = new URL(data.next); } catch (_) {}
            if (!resource || !next || next.origin !== BASES.deezer || next.username || next.password || next.hash
                || next.pathname !== `/${resource[1]}/${resource[2]}/tracks`) {
                reason = 'The provider returned an invalid track continuation.'; break;
            }
            next.searchParams.sort();
            if (visited.has(next.href)) { reason = 'The provider repeated a track-page loop.'; break; }
            visited.add(next.href);
            next.searchParams.set('index', String(providerRows)); next.searchParams.sort();
            const remaining = deadlineAt - Date.now();
            if (remaining <= 0) { reason = 'Track pagination timed out.'; break; }
            let page;
            try {
                page = await request('deezer', `${next.pathname}${next.search}`, issues, 6 * 3600000, { deadlineAt, signal: opts.signal });
            } catch (error) { reason = clean(error.message, 250) || 'The next track page is unavailable.'; break; }
            consume(page); data = page;
        }
        const total = totalKnown ? Number(rawTotal) : observed;
        const missing = Math.max(0, total - tracks.length - duplicates);
        if (!reason && truncated) reason = 'The track preparation limit was reached.';
        if (!reason && missing) reason = 'Some provider tracks are unavailable.';
        const partial = Boolean(reason || truncated || missing);
        if (partial) issues.push({ provider: 'deezer', status: 'partial', message: reason });
        return { tracks, partial, truncated, tracksReport: { total, totalKnown, returned: tracks.length, duplicates,
            missing, pages, limit, complete: !partial, partial, truncated, reason } };
    }
    async function albumVersions(id, opts = {}) {
        const parsed = parseId('album', id), issues = [], budget = pagingOptions(opts);
        opts = { ...opts, deadlineAt: budget.deadlineAt };
        const controls = { deadlineAt: budget.deadlineAt, signal: opts.signal, cacheScope: opts.country };
        try {
            let item = opts.item;
            if (!item && parsed.provider === 'deezer') item = deezerAlbum(await request('deezer', `/album/${parsed.id}`, issues, 6 * 3600000, controls));
            if (!item && parsed.provider === 'itunes') {
                const data = await request('itunes', `/lookup?${new URLSearchParams({ id: parsed.id, country: countryOf(opts.country) })}`, issues, 6 * 3600000, controls);
                item = (data.results || []).map(x => itunesItem(x)).find(x => x?.id === id);
            }
            if (parsed.provider === 'deezer' && item?.artistId && item.author) {
                const page = pagingOptions(opts);
                const q = `artist:"${item.author.replace(/["\\]/g, '')}" album:"${item.title.replace(/["\\]/g, '')}"`;
                const data = await typedPage('deezer', `/search/album?${new URLSearchParams({ q, limit: String(page.limit), index: String(page.offset) })}`, deezerPage, x => deezerAlbum(x), page);
                data.items = data.items.filter(x => sameAlbumFamily(item, x)); data.returned = data.items.length;
                return data;
            }
            if (parsed.provider === 'itunes' && item?.artistId) {
                const data = await artistAlbums(item.artistId, opts);
                data.items = data.items.filter(x => sameAlbumFamily(item, x)); data.returned = data.items.length;
                return data;
            }
            if (parsed.provider === 'musicbrainz') {
                let group = opts.group;
                if (!group) {
                    let groupId = parsed.id;
                    if (parsed.entity === 'release') {
                        const release = await request('musicbrainz', `/release/${parsed.id}?inc=release-groups&fmt=json`, issues, 6 * 3600000, controls);
                        groupId = release['release-group']?.id;
                    }
                    if (!UUID.test(groupId || '')) return result([], issues);
                    group = await request('musicbrainz', `/release-group/${groupId}?inc=releases+artist-credits&fmt=json`, issues, 6 * 3600000, controls);
                    if (String(group.id).toLowerCase() !== groupId.toLowerCase()) throw problem('The release-group identity did not match.', 'CATALOG_IDENTITY_MISMATCH', 404);
                }
                const base = item || mbItem(group, 'album');
                if (!base || !UUID.test(group.id || '')) return result([], issues);
                const defaultRelease = (group.releases || []).find(x => x.status === 'Official') || group.releases?.[0];
                const selected = opts.releaseId || item?.releaseId || (parsed.entity === 'release' ? providerId('musicbrainz', 'release', parsed.id) : defaultRelease && providerId('musicbrainz', 'release', defaultRelease.id));
                const page = pagingOptions(opts);
                const mapper = value => {
                    if (value['release-group']?.id && value['release-group'].id.toLowerCase() !== group.id.toLowerCase()) return null;
                    return mbReleaseItem({ ...value, 'artist-credit': value['artist-credit'] || group['artist-credit'],
                        'release-group': { ...group, ...(value['release-group'] || {}) } });
                };
                const acceptable = version => version && version.id !== selected && version.artistId && version.artistId === base.artistId
                    && albumFamily(version.title) === albumFamily(base.title);
                const data = await typedPage('musicbrainz', `/release?${new URLSearchParams({ 'release-group': group.id,
                    limit: String(page.limit), offset: String(page.offset), inc: 'artist-credits+release-groups', fmt: 'json' })}`,
                    mbPage('releases', 'release'), mapper, page);
                data.items = data.items.filter(acceptable);
                if (data.partial && !data.items.length && group.releases?.length) {
                    data.items = unique(group.releases.map(mapper).filter(acceptable)).slice(page.offset, page.offset + page.limit);
                    data.complete = false; data.totalKnown = false;
                }
                data.returned = data.items.length; data.degradedProviders = uniqueIssues([...issues, ...data.degradedProviders]);
                return data;
            }
            return result([], issues, { offset: Number(opts.offset) || 0, returned: 0, nextOffset: null, hasMore: false, complete: true, partial: false });
        } catch (error) {
            if (error.code === 'CATALOG_IDENTITY_MISMATCH') throw error;
            if (!issues.length) issues.push({ provider: parsed.provider, status: 'partial', message: clean(error.message, 250) });
            return result([], issues, { offset: budget.offset, limit: budget.limit, returned: 0, nextOffset: null,
                hasMore: false, partial: true, complete: false });
        }
    }
    function artistRecording(item, track) {
        return track.artistId === item.id || (track.contributors || []).some(x => x.id === item.id)
            || !track.artistId && nameKey(track.author) === nameKey(item.title);
    }
    async function artistReleaseRecordings(item, releases, opts, issues) {
        if (item.provider === 'musicbrainz') return { tracks: [], report: { complete: true, partial: false, releases: 0, returned: 0 } };
        const prepared = [], parts = [], reports = [];
        let cursor = 0, observed = 0, stopped = false;
        const worker = async () => {
            while (cursor < releases.length) {
                if (opts.signal?.aborted || opts.deadlineAt <= Date.now() || observed >= playlistTrackLimit) { stopped = true; break; }
                const index = cursor++, release = releases[index];
                let tracks = [], report;
                if (release.provider === 'deezer') {
                    const parsed = parseId('album', release.id);
                    const context = { id: parsed.id, title: release.title, artist: { id: release.artistId?.split(':').at(-1), name: release.author },
                        cover_xl: release.thumbnail, release_date: release.releaseDate, ...(release.count > 0 ? { nb_tracks: release.count } : {}) };
                    const data = await pagedDeezerTracks(`/album/${parsed.id}/tracks?limit=100`, issues, context, null, opts);
                    tracks = data.tracks; report = data.tracksReport;
                } else if (release.provider === 'itunes') {
                    const parsed = parseId('album', release.id);
                    const endpoint = `/lookup?${new URLSearchParams({ id: parsed.id, entity: 'song', limit: '200', country: countryOf(opts.country) })}`;
                    const data = await attempt(() => request('itunes', endpoint, issues, 6 * 3600000, opts));
                    tracks = (data?.results || []).map(x => itunesItem(x)).filter(x => x?.kind === 'track' && x.albumId === release.id);
                    const partial = !data || (data.results || []).length >= 200;
                    report = { complete: !partial, partial, returned: tracks.length };
                } else { report = { complete: false, partial: true, returned: 0 }; }
                observed += tracks.length;
                parts[index] = tracks.filter(x => artistRecording(item, x)); reports[index] = report; prepared.push(release.id);
            }
        };
        await Promise.all([worker(), worker()]);
        const tracks = uniqueRecordings(parts.flat()), partial = stopped || prepared.length < releases.length || reports.some(x => x?.partial) || tracks.length > playlistTrackLimit;
        return { tracks: tracks.slice(0, playlistTrackLimit), report: { complete: !partial, partial, releases: prepared.length,
            totalReleases: releases.length, returned: Math.min(tracks.length, playlistTrackLimit), limit: playlistTrackLimit,
            ...(stopped ? { reason: 'The artist playback preparation limit or deadline was reached.' } : {}) } };
    }
    async function addArtistDiscography(item, data, issues, opts = {}) {
        const pageOpts = { ...opts, artist: { id: data.id, name: item.title }, deadlineAt: opts.deadlineAt || Date.now() + trackPaginationTimeoutMs };
        const [songs, albums, related, credited, appearances] = await Promise.all([
            collectArtistPages(artistTracks, item.id, pageOpts, issues),
            collectArtistPages(artistAlbums, item.id, pageOpts, issues),
            collectArtistPages(artistSimilar, item.id, pageOpts, issues),
            collectArtistPages(artistCreditedTracks, item.id, pageOpts, issues),
            item.provider === 'musicbrainz' ? collectArtistPages(artistAppearsOn, item.id, pageOpts, issues) : { items: [], report: { complete: true, partial: false, pages: 0, returned: 0 } },
        ]);
        const isPrimary = x => x.artistId === item.id || !x.artistId && nameKey(x.author) === nameKey(item.title);
        item.tracks = songs.items.filter(isPrimary);
        item.albums = albums.items.filter(x => isPrimary(x) && !['ep', 'single'].includes(x.recordType));
        item.epsAndSingles = albums.items.filter(x => isPrimary(x) && ['ep', 'single'].includes(x.recordType));
        item.creditedTracks = unique([...credited.items, ...songs.items.filter(x => !isPrimary(x) && (x.contributors || []).some(credit => credit.id === item.id))]);
        item.appearsOn = unique([...appearances.items, ...albums.items.filter(x => !isPrimary(x) && (x.contributors || []).some(credit => credit.id === item.id)),
            ...item.creditedTracks.filter(x => x.albumId && x.album).map(x => ({ kind: 'album', id: x.albumId, title: x.album,
                author: x.author, artistId: x.artistId, thumbnail: x.thumbnail, provider: x.provider,
                releaseId: x.releaseId, releaseGroupId: x.releaseGroupId, artworkCandidates: x.artworkCandidates, provenance: x.provenance }))]);
        item.similarArtists = canonicalArtists(related.items).filter(x => x.id !== item.id && nameKey(x.title) !== nameKey(item.title));
        item.artists = item.similarArtists;
        item.discographyReports = { tracks: songs.report, releases: albums.report, similarArtists: related.report, creditedTracks: credited.report, appearsOn: appearances.report };
        item.discographyPartial = Object.values(item.discographyReports).some(x => x.partial);
        const recordings = await artistReleaseRecordings(item, unique([...item.albums, ...item.epsAndSingles, ...item.appearsOn]), pageOpts, issues);
        const playback = uniqueRecordings([...item.tracks, ...recordings.tracks, ...item.creditedTracks]);
        item.playbackTracks = playback.slice(0, playlistTrackLimit);
        item.playbackReport = { ...recordings.report, returned: item.playbackTracks.length, limit: playlistTrackLimit,
            partial: recordings.report.partial || songs.report.partial || credited.report.partial || appearances.report.partial
                || (item.provider !== 'musicbrainz' && albums.report.partial) || playback.length > playlistTrackLimit };
        item.playbackReport.complete = !item.playbackReport.partial;
        if (item.tracks.length < 10) {
            item.tracks = uniqueRecordings([...item.tracks, ...item.playbackTracks.filter(isPrimary)]).slice(0, 10);
            item.popularTrackSource = 'provider-top-with-catalog-fill';
        } else item.popularTrackSource = 'provider-top';
        item.discographyPartial ||= item.playbackReport.partial;
        return item;
    }
    function artistHint(id, opts) {
        const cached = artistIdentities.get(id);
        const hint = typeof opts.artist === 'string' ? opts.artist : opts.artist?.name || opts.artist?.title;
        const title = clean(cached?.title || opts.name || opts.title || hint, 160);
        return title.length >= 2 ? { id, kind: 'artist', title, provider: id.split(':')[0], samples: cached?.samples || [] } : null;
    }
    async function alternateArtist(seed, opts, issues) {
        if (!seed?.title || opts.signal?.aborted || opts.deadlineAt <= Date.now()) return null;
        const samples = uniqueRecordings([...(seed.playbackTracks || []), ...(seed.tracks || []), ...(seed.samples || [])]);
        for (const provider of ['itunes', 'musicbrainz']) {
            if (provider === seed.provider || opts.signal?.aborted || opts.deadlineAt <= Date.now()) continue;
            const controls = { deadlineAt: opts.deadlineAt, signal: opts.signal, cacheScope: opts.country };
            const endpoint = provider === 'itunes' ? itunesQuery(seed.title, 'artist', opts)
                : `/artist?${new URLSearchParams({ query: `artist:"${seed.title.replace(/["\\]/g, '')}"`, limit: '30', fmt: 'json' })}`;
            const data = await attempt(() => request(provider, endpoint, issues, 10 * 60_000, controls));
            const candidates = unique((provider === 'itunes' ? data?.results || [] : data?.artists || [])
                .map(x => provider === 'itunes' ? itunesItem(x, 'artist') : mbItem(x, 'artist'))
                .filter(x => x?.kind === 'artist' && nameKey(x.title) === nameKey(seed.title)));
            // With no recording evidence, a shared name cannot choose among
            // homonyms. A unique exact-name catalog result is the minimum.
            if (!candidates.length || !samples.length && candidates.length !== 1) continue;
            const matches = [];
            for (const candidate of candidates.slice(0, 3)) {
                const item = await attempt(() => detail('artist', candidate.id, { ...opts, recoverArtist: false }));
                if (!item || item.id !== candidate.id || nameKey(item.title) !== nameKey(seed.title)) continue;
                const shared = (item.playbackTracks || item.tracks || []).find(track => samples.some(x => sameRecording(x, track)));
                const linked = (item.links || []).some(x => normalizeUrl(x.url) === normalizeUrl(seed.providerUrl || `https://www.deezer.com/artist/${seed.id.split(':').at(-1)}`));
                if (samples.length && !shared && !linked) continue;
                if (!(item.playbackTracks || []).length && !(item.albums || []).length && !(item.epsAndSingles || []).length) continue;
                matches.push({ item, match: linked ? 'provider-link' : shared ? 'shared-recording' : 'exact-unique-name' });
            }
            if (matches.length === 1) return matches[0];
        }
        return null;
    }
    function mergeArtistRecovery(item, recovered) {
        const alternate = recovered.item;
        const playback = uniqueRecordings([...(item.playbackTracks || []), ...(alternate.playbackTracks || [])]);
        item.playbackTracks = playback.slice(0, playlistTrackLimit);
        item.tracks = uniqueRecordings([...(item.tracks || []), ...(alternate.tracks || []), ...item.playbackTracks]).slice(0, Math.max(10, item.tracks.length));
        for (const key of ['albums', 'epsAndSingles', 'creditedTracks', 'appearsOn']) item[key] = unique([...(item[key] || []), ...(alternate[key] || [])]);
        item.playbackReport = { ...item.playbackReport, returned: item.playbackTracks.length,
            partial: Boolean(item.playbackReport?.partial || alternate.playbackReport?.partial || playback.length > playlistTrackLimit) };
        item.playbackReport.complete = !item.playbackReport.partial;
        item.catalogRecovery = { provider: alternate.provider, artistId: alternate.id, match: recovered.match };
        item.popularTrackSource = 'provider-top-with-catalog-fill';
        item.discographyPartial ||= item.playbackReport.partial;
        return item;
    }
    function albumHint(id, opts = {}) {
        const known = albumIdentities.get(id) || {};
        const artist = typeof opts.artist === 'string' ? opts.artist : opts.artist?.name || opts.artist?.title;
        const title = clean(opts.name || opts.title || opts.album || known.title, 160);
        const author = clean(artist || opts.albumArtist || known.author, 160);
        return { ...known, id, provider: id.split(':')[0], kind: 'album', title, author };
    }
    function albumMatchesHint(item, seed) {
        if (item?.kind !== 'album' || !seed?.title || !seed?.author || nameKey(item.author) !== nameKey(seed.author)) return false;
        const requested = nameKey(seed.title), candidate = nameKey(item.title);
        const requestedFamily = albumFamily(seed.title), candidateFamily = albumFamily(item.title);
        const sameTitle = requested && candidate && requested === candidate;
        const sameUsefulFamily = requestedFamily.length >= 3 && requestedFamily === candidateFamily;
        return Boolean(sameTitle || sameUsefulFamily);
    }
    async function alternateAlbum(seed, opts, issues) {
        if (!seed?.title || !seed?.author || opts.signal?.aborted || opts.deadlineAt && opts.deadlineAt <= Date.now()) return null;
        const query = `${seed.title} ${seed.author}`.slice(0, 220), controls = { signal: opts.signal,
            ...(opts.deadlineAt ? { deadlineAt: opts.deadlineAt } : {}), cacheScope: opts.country };
        const results = await attempt(() => search(query, 'albums', opts));
        issues.push(...(results?.degradedProviders || []));
        let candidates = (results?.items || []).filter(item => albumMatchesHint(item, seed));
        if (!candidates.length && !opts.signal?.aborted && (!opts.deadlineAt || opts.deadlineAt > Date.now())) {
            const quote = value => `"${String(value).replace(/["\\]/g, '').slice(0, 120)}"`;
            const mb = await attempt(() => request('musicbrainz', `/release-group?${new URLSearchParams({
                query: `release:${quote(seed.title)} AND artist:${quote(seed.author)}`, limit: '30', fmt: 'json' })}`,
            issues, 10 * 60_000, controls));
            candidates.push(...(mb?.['release-groups'] || []).map(value => mbItem(value, 'album')).filter(item => albumMatchesHint(item, seed)));
        }
        candidates = unique(candidates).filter(item => item.id !== seed.id && item.provider !== seed.provider && albumMatchesHint(item, seed));
        for (const candidate of candidates.slice(0, 5)) {
            if (opts.signal?.aborted || opts.deadlineAt && opts.deadlineAt <= Date.now()) break;
            const recovered = await attempt(() => detail('album', candidate.id, { ...opts, recoverAlbum: false,
                name: seed.title, artist: seed.author }));
            if (!albumMatchesHint(recovered, seed) || !Array.isArray(recovered.tracks) || !recovered.tracks.length) continue;
            const alternateId = recovered.id;
            rememberAlbums([{ ...recovered, id: seed.id }]);
            return { ...recovered, id: seed.id, requestedAlbumId: seed.id, catalogProviderId: alternateId,
                catalogRecovery: { provider: recovered.provider, albumId: alternateId, match: 'exact-title-and-artist' },
                degradedProviders: uniqueIssues([...issues, ...(recovered.degradedProviders || [])]) };
        }
        return null;
    }
    async function detail(kind, id, opts = {}) {
        if (!['track', 'album', 'artist', 'video', 'playlist', 'work'].includes(kind)) throw problem('Unsupported catalog detail kind.', 'INVALID_DETAIL_KIND', 400);
        const parsed = parseId(kind, id), issues = [];
        if (kind === 'artist') opts = { ...opts, deadlineAt: opts.deadlineAt || Date.now() + trackPaginationTimeoutMs };
        let item;
        if (parsed.provider === 'deezer') {
            if (kind === 'video' || kind === 'work') throw problem('This provider does not supply this detail kind.', 'UNSUPPORTED_DETAIL', 400);
            let data;
            try { data = await request('deezer', `/${kind}/${parsed.id}`, issues, 6 * 3600000,
                kind === 'album' || kind === 'artist' ? requestControls(opts) : {}); }
            catch (error) {
                if (kind === 'album' && opts.recoverAlbum !== false && error.code !== 'CATALOG_CANCELLED') {
                    const recovered = await alternateAlbum(albumHint(id, opts), opts, issues);
                    if (recovered) return recovered;
                }
                if (kind !== 'artist' || opts.recoverArtist === false || error.code === 'CATALOG_CANCELLED') throw error;
                const recovered = await alternateArtist(artistHint(id, opts), opts, issues);
                if (!recovered) throw error;
                return { ...recovered.item, requestedArtistId: id,
                    catalogRecovery: { provider: recovered.item.provider, artistId: recovered.item.id, match: recovered.match },
                    degradedProviders: uniqueIssues([...issues, ...recovered.item.degradedProviders]) };
            }
            if (!data || String(data.id) !== parsed.id) throw problem('The provider returned a different catalog identity.', 'CATALOG_IDENTITY_MISMATCH', 404);
            if (kind === 'track') {
                item = deezerTrack(data); item.credits = deezerCredits(data); item.contributors = item.credits.contributors;
                if (item.albumId) {
                    const album = await attempt(() => request('deezer', `/album/${item.albumId.split(':').at(-1)}`, issues, 6 * 3600000));
                    if (album && providerId('deezer', 'album', album.id) === item.albumId) {
                        item.albumCredits = deezerCredits(album, 'release');
                        item.releaseDate ||= clean(album.release_date, 40);
                        item.genres = list(album.genres).map(x => clean(x.name, 100)).filter(Boolean); item.genre = item.genres[0] || item.genre;
                        item.thumbnail ||= deezerAlbum(album)?.thumbnail || '';
                    }
                }
            }
            if (kind === 'album') {
                item = deezerAlbum(data);
                Object.assign(item, await pagedDeezerTracks(`/album/${parsed.id}/tracks?limit=100`, issues, data, data.tracks, opts));
                item.credits = deezerCredits(data, 'release');
                const versions = opts.includeVersions === false ? { items: [], degradedProviders: [] }
                    : await albumVersions(id, { ...opts, item });
                item.otherVersions = versions.items; item.versionsReport = versions; issues.push(...versions.degradedProviders);
            }
            if (kind === 'artist') {
                item = await addArtistDiscography(deezerArtist(data), data, issues, opts);
                if (data.bio || data.biography) item.bio = clean(data.bio || data.biography, 5000);
            }
            if (kind === 'playlist') { item = deezerPlaylist(data); Object.assign(item, await pagedDeezerTracks(`/playlist/${parsed.id}/tracks?limit=100`, issues, data, data.tracks, opts)); }
        } else if (parsed.provider === 'itunes') {
            if (kind === 'playlist' || kind === 'work') throw problem('This provider does not supply this detail kind.', 'UNSUPPORTED_DETAIL', 400);
            const entity = kind === 'album' ? 'song' : kind === 'artist' ? 'album' : kind === 'video' ? 'musicVideo' : 'song';
            let data;
            try { data = await request('itunes', `/lookup?${new URLSearchParams({ id: parsed.id, entity, limit: '200', country: countryOf(opts.country), sort: 'recent' })}`, issues, 6 * 3600000,
                kind === 'album' || kind === 'artist' ? requestControls(opts) : {}); }
            catch (error) {
                if (kind !== 'album' || opts.recoverAlbum === false || error.code === 'CATALOG_CANCELLED') throw error;
                const recovered = await alternateAlbum(albumHint(id, opts), opts, issues);
                if (recovered) return recovered;
                throw error;
            }
            const results = (data.results || []).map(x => itunesItem(x)).filter(Boolean);
            item = results.find(x => x.kind === kind && x.id === id);
            if (!item) {
                if (kind === 'album' && opts.recoverAlbum !== false) {
                    const recovered = await alternateAlbum(albumHint(id, opts), opts, issues);
                    if (recovered) return recovered;
                }
                throw problem('This catalog item is no longer available in the current region.', 'CATALOG_NOT_FOUND', 404);
            }
            if (kind === 'track') item.credits = { scope: 'recording', contributors: [] };
            if (kind === 'album') {
                item.tracks = results.filter(x => x.kind === 'track' && x.albumId === item.id).sort((a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber);
                item.credits = { scope: 'release', copyright: item.copyright || '', contributors: [] };
                if (!item.tracks.length && opts.recoverAlbum !== false) {
                    const recovered = await alternateAlbum({ ...albumHint(id, opts), title: item.title, author: item.author }, opts, issues);
                    if (recovered) return recovered;
                }
                const versions = await albumVersions(id, { ...opts, item }); item.otherVersions = versions.items;
                item.versionsReport = versions; issues.push(...versions.degradedProviders);
            }
            if (kind === 'artist') item = await addArtistDiscography(item, { id: parsed.id }, issues, opts);
        } else if (parsed.provider === 'musicbrainz') {
            if (kind === 'video' || kind === 'playlist') throw problem('This provider does not supply this detail kind.', 'UNSUPPORTED_DETAIL', 400);
            const entity = parsed.entity || (kind === 'album' ? 'release-group' : kind === 'track' ? 'recording' : kind);
            const releaseInc = 'recordings+artist-credits+artist-rels+recording-rels+recording-level-rels+work-rels+work-level-rels+labels+release-groups+genres';
            const inc = entity === 'release' ? releaseInc : kind === 'album' ? 'releases+artist-credits+genres'
                : kind === 'artist' ? 'url-rels+genres+artist-rels' : kind === 'work' ? 'artist-rels+work-rels'
                    : 'artist-credits+releases+release-groups+genres+artist-rels+work-rels+work-level-rels';
            const data = await request('musicbrainz', `/${entity}/${parsed.id}?${new URLSearchParams({ inc, fmt: 'json' })}`, issues, 6 * 3600000, kind === 'artist' ? opts : {});
            if (!data || String(data.id).toLowerCase() !== parsed.id.toLowerCase()) throw problem('The provider returned a different catalog identity.', 'CATALOG_IDENTITY_MISMATCH', 404);
            item = mbItem(data, kind);
            if (kind === 'track') { item.credits = mbCredits(data); item.contributors = item.credits.contributors; item.works = item.credits.works; }
            if (kind === 'work') { item.credits = mbCredits(data, 'work'); item.contributors = item.credits.contributors; item.author = item.contributors.map(x => x.title).join(', '); }
            if (kind === 'album') {
                let group = entity === 'release' ? null : data, release = entity === 'release' ? data : null;
                const groupId = group?.id || release?.['release-group']?.id;
                if (!UUID.test(groupId || '')) throw problem('The release has no verified release-group identity.', 'CATALOG_IDENTITY_MISMATCH', 404);
                if (!group) group = await request('musicbrainz', `/release-group/${groupId}?inc=releases+artist-credits+genres&fmt=json`, issues, 6 * 3600000);
                if (String(group.id).toLowerCase() !== groupId.toLowerCase()) throw problem('The release-group identity did not match.', 'CATALOG_IDENTITY_MISMATCH', 404);
                const preferred = opts.releaseId ? String(opts.releaseId).replace(/^musicbrainz:release:/, '') : '';
                if (preferred && (!UUID.test(preferred) || !(group.releases || []).some(x => x.id.toLowerCase() === preferred.toLowerCase()))) throw problem('This edition does not belong to the requested album.', 'CATALOG_IDENTITY_MISMATCH', 404);
                const chosen = preferred ? (group.releases || []).find(x => x.id.toLowerCase() === preferred.toLowerCase())
                    : (group.releases || []).find(x => x.status === 'Official') || group.releases?.[0];
                if (!release && UUID.test(chosen?.id || '')) release = await request('musicbrainz', `/release/${chosen.id}?${new URLSearchParams({ inc: releaseInc, fmt: 'json' })}`, issues, 6 * 3600000);
                item = mbItem(group, 'album'); item.tracks = [];
                if (release) {
                    const wanted = entity === 'release' ? parsed.id : chosen.id;
                    if (!UUID.test(release.id || '') || release.id.toLowerCase() !== wanted.toLowerCase()
                        || release['release-group']?.id && release['release-group'].id.toLowerCase() !== groupId.toLowerCase()) throw problem('The provider returned a different album edition.', 'CATALOG_IDENTITY_MISMATCH', 404);
                    item.releaseId = providerId('musicbrainz', 'release', release.id); item.releaseGroupId = providerId('musicbrainz', 'album', groupId);
                    if (entity === 'release') { item.id = item.releaseId; item.title = clean(release.title || item.title); item.providerUrl = `https://musicbrainz.org/release/${release.id}`; }
                    item.editionTitle = clean(release.title || item.title); item.releaseDate = clean(release.date || item.releaseDate, 40);
                    item.thumbnail = `https://coverartarchive.org/release/${release.id}/front-500`;
                    item.artworkCandidates = [item.thumbnail, `https://coverartarchive.org/release-group/${groupId}/front-500`];
                    item.provenance = provenance('musicbrainz', `/release/${release.id}`, 'Cover Art Archive release candidate');
                    const releaseSummary = { id: release.id, title: release.title || item.title, date: release.date, 'release-group': { id: groupId, title: group.title } };
                    item.tracks = (release.media || []).flatMap(media => (media.tracks || []).map(value => {
                        const recording = { ...value.recording, title: value.title || value.recording?.title,
                            length: value.length ?? value.recording?.length, releases: [releaseSummary],
                            'artist-credit': value['artist-credit'] || value.recording?.['artist-credit'] || release['artist-credit'] || group['artist-credit'] };
                        const row = mbItem(recording, 'track');
                        if (!row) return null;
                        return { ...row, album: item.title, albumId: item.id, releaseGroupId: item.releaseGroupId, releaseId: item.releaseId,
                            thumbnail: item.thumbnail, artworkCandidates: item.artworkCandidates, trackNumber: Number(value.position || 0),
                            discNumber: Number(media.position || 0), releaseDate: item.releaseDate, genres: item.genres, genre: item.genre,
                            credits: mbCredits(recording), contributors: mbCredits(recording).contributors };
                    })).filter(Boolean);
                    item.credits = { ...mbCredits(release, 'release'),
                        labels: (release['label-info'] || []).map(x => ({ title: clean(x.label?.name), catalogNumber: clean(x['catalog-number']) })).filter(x => x.title),
                        copyright: '', releaseId: item.releaseId };
                }
                const versions = await albumVersions(item.id, { ...opts, item, group, releaseId: item.releaseId }); item.otherVersions = versions.items; item.versionsReport = versions;
                issues.push(...versions.degradedProviders);
            }
            if (kind === 'artist') {
                item = await addArtistDiscography(item, data, issues, opts);
                item.links = (data.relations || []).filter(x => x.url?.resource).map(x => ({ type: clean(x.type), url: http(x.url.resource) }));
                item.artistType = clean(data.type); item.country = clean(data.country, 20); item.lifeSpan = data['life-span'] || {};
                if (data.disambiguation) item.bio = clean(data.disambiguation, 5000);
            }
        } else if (parsed.provider === 'youtube') {
            const found = await sourceItems(`https://www.youtube.com/watch?v=${parsed.id}`, kind, issues);
            item = found.find(x => x.id === id || x.url?.includes(parsed.id));
        }
        if (!item) throw problem('This catalog item could not be found.', 'CATALOG_NOT_FOUND', 404);
        if (kind === 'artist' && parsed.provider === 'deezer' && opts.recoverArtist !== false && (item.tracks.length < 10 || item.playbackReport?.partial)) {
            const recovered = await alternateArtist(item, opts, issues);
            if (recovered) { mergeArtistRecovery(item, recovered); issues.push(...recovered.item.degradedProviders); }
        }
        rememberArtists([item, ...(item.tracks || []), ...(item.playbackTracks || [])]); rememberAlbums([item]);
        return { ...item, degradedProviders: uniqueIssues(issues) };
    }
    async function recommendations({ artistId, artist, query, genre, country } = {}) {
        const issues = []; let seed = artistId;
        if (!seed && artist) {
            const candidates = await search(artist, 'artists', { country }); issues.push(...candidates.degradedProviders);
            seed = candidates.items.find(x => nameKey(x.title) === nameKey(artist))?.id;
        }
        if (seed && /^deezer:artist:\d+$/.test(seed)) {
            const id = seed.split(':').at(-1), endpoint = `/artist/${id}/radio?limit=50`;
            const data = await attempt(() => request('deezer', endpoint, issues));
            const items = list(data).map(deezerTrack).filter(Boolean).map(item => ({ ...item, seedArtistId: seed,
                recommendationSource: 'provider-artist-radio', provenance: { ...item.provenance, endpoint, seedArtistId: seed } }));
            return result(items, issues, { seedArtistId: seed, recommendationSource: items.length ? 'provider-artist-radio' : 'unavailable',
                provenance: provenance('deezer', endpoint) });
        }
        // Genre discovery and full-text search remain distinct catalog operations.
        // An unsupported artist radio cannot be advertised as provider recommendations.
        return result([], issues, { seedArtistId: seed || '', recommendationSource: 'unavailable' });
    }
    async function artistReleases(artist) {
        if (!artist?.id) return result([], []);
        const item = await detail('artist', artist.id);
        return result([...(item.albums || []), ...(item.epsAndSingles || [])], item.degradedProviders || [],
            { partial: Boolean(item.discographyReports?.releases?.partial), complete: !item.discographyReports?.releases?.partial });
    }

    return { search, searchPlaylists, detail, charts, releases, publicTop: charts, publicNew: releases, genres, editorial, browse, recommendations, artistReleases,
        artistAlbums, artistTracks, artistAppearsOn, artistCreditedTracks, artistSimilar, albumVersions,
        videos: (query, opts) => search(query, 'videos', opts),
        status: () => [...states.values()].map(({ retryAt, ...state }) => ({ ...state })),
        clearCache: () => { cache.clear(); states.clear(); artistIdentities.clear(); albumIdentities.clear(); },
    };
}

module.exports = createPlatformCatalog();
module.exports.createPlatformCatalog = createPlatformCatalog;
module.exports.parseId = parseId;
