'use strict';

const crypto = require('node:crypto');
const platformCatalog = require('./platformCatalog');
const platformStore = require('./platformStore');
const historyStore = require('./historyStore');
const favoritesStore = require('./favoritesStore');
const playlistsStore = require('./playlistsStore');
const { canonicalTrackKey } = require('./trackIdentity');
const { userIdOf, itemKey } = require('./platformStore');
const { releaseTime, isFresh: isFreshAt, diversify, recordingKey, mergeCandidatePools,
    buildTransitionModel, transitionScore, transitionCandidates } = require('./platformRecommendation');

const DAY = 86400000;
const CATALOG_REQUEST_TIMEOUT_MS = 12000;
const norm = value => String(value || '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
const titleKey = item => `${norm(item?.title)}::${norm(item?.author)}`;
const itemGenres = item => [...new Set([...(item?.genres || []), item?.genre].filter(Boolean).map(norm))];
const explicitMoodTags = item => [...new Set([...(item?.moods || []), ...(item?.activities || []), ...(item?.tags || []), item?.mood, item?.activity]
    .filter(Boolean).map(value => norm(typeof value === 'object' ? value.name : value)))];
const itemMoods = item => [...new Set([...(item?.moods || []), ...(item?.activities || []), ...(item?.tags || []), ...(item?.genres || []), item?.mood, item?.activity]
    .filter(Boolean).map(value => norm(typeof value === 'object' ? value.name : value)))];
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const randomScore = value => parseInt(hash(value).slice(0, 8), 16) / 0xffffffff;
const clone = value => structuredClone(value);
const knownArtist = value => Boolean(value && !/^(unknown( artist)?|direct link|غير معروف)$/i.test(String(value)));
function mixTargetCount(userId, day, mixId, available = MIX_MAX_TRACKS) {
    const upper = Math.max(MIX_MIN_TRACKS, Math.min(MIX_MAX_TRACKS, Math.floor(Number(available) || MIX_MIN_TRACKS)));
    const span = upper - MIX_MIN_TRACKS + 1;
    const offset = parseInt(hash(`${userId}:${day}:${mixId}`).slice(0, 8), 16) % span;
    return MIX_MIN_TRACKS + offset;
}

function unique(items, limit = 100) {
    const seen = new Set();
    return (items || []).filter(item => {
        if (!item?.title) return false;
        const key = item.kind === 'track' || item.kind === 'video' ? titleKey(item)
            : item.kind === 'album' ? `album:${norm(item.title)}::${norm(item.author)}`
                : item.kind === 'artist' ? `artist:${norm(item.title)}` : itemKey(item);
        if (seen.has(key)) return false; seen.add(key); return true;
    }).slice(0, limit);
}
function withArtworkFallbacks(item) {
    if (!item || typeof item !== 'object') return item;
    const candidates = [...(Array.isArray(item.artworkFallbacks) ? item.artworkFallbacks : []),
        ...(Array.isArray(item.artworkCandidates) ? item.artworkCandidates : [])];
    const seen = new Set(), artworkFallbacks = [];
    for (const value of candidates) {
        if (typeof value !== 'string' || !/^(?:https:\/\/|\/api\/platform\/(?:upload\/art|artwork\/image)\?)/i.test(value)
            || value === item.thumbnail || seen.has(value)) continue;
        seen.add(value); artworkFallbacks.push(value);
        if (artworkFallbacks.length >= 12) break;
    }
    return artworkFallbacks.length ? { ...item, artworkFallbacks } : item;
}
function issuesOf(values) {
    const issues = new Map();
    for (const value of values) for (const issue of value?.degradedProviders || []) issues.set(issue.provider || 'catalog', issue);
    return [...issues.values()];
}
function envelope(value) { return Array.isArray(value) ? { items: value, degradedProviders: [] } : value || { items: [] }; }
function section(id, title, items, type = 'cards', subtitle) {
    return { id, title, type, items: unique(items, type === 'tracks' ? 50 : 24), ...(subtitle ? { subtitle } : {}) };
}
function monthName(month) { return new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`)); }
function genreMatches(genres, wanted) { return genres.includes(wanted); }
function requestError(message) { const error = new TypeError(message); error.statusCode = 400; return error; }
const MIX_MIN_TRACKS = 30;
const MIX_MAX_TRACKS = 100;
const MIX_REQUIREMENTS = [
    { qualifiedTracks: 12, artists: 3, days: 2, seconds: 2400, spanDays: 1, clusters: 1 },
    { qualifiedTracks: 25, artists: 5, days: 4, seconds: 7200, spanDays: 1, clusters: 2 },
    { qualifiedTracks: 45, artists: 8, days: 7, seconds: 14400, spanDays: 1, clusters: 3 },
    { qualifiedTracks: 70, artists: 12, days: 10, seconds: 25200, spanDays: 1, clusters: 4 },
    { qualifiedTracks: 105, artists: 16, days: 14, seconds: 43200, spanDays: 1, clusters: 5 },
    { qualifiedTracks: 150, artists: 20, days: 21, seconds: 64800, spanDays: 1, clusters: 6 },
    { qualifiedTracks: 230, artists: 25, days: 30, seconds: 100800, spanDays: 14, clusters: 7 },
    { qualifiedTracks: 360, artists: 32, days: 45, seconds: 216000, spanDays: 30, clusters: 8 },
];
const MOODS = ['For DJs', 'Record Labels', 'Artist Experiences', 'Autumn', 'Sleep', 'Wellness', 'Workout', 'Celebration', 'Party', 'Relax', 'Focus', 'Happy',
    'Chill', 'Energy', 'Romantic', 'Melancholy', 'Study', 'Driving'];
const MOOD_SEARCH_TERMS = {
    Chill: 'chill relaxed downtempo ambient', Focus: 'focus instrumental concentration', Energy: 'high energy upbeat dance',
    Romantic: 'romantic love songs', Melancholy: 'melancholy emotional songs', Workout: 'workout training high energy',
    Study: 'study instrumental concentration', Driving: 'driving road trip music', Party: 'party dance upbeat club hits',
    Sleep: 'sleep calming ambient soft piano', 'For DJs': 'DJ sets extended mixes club tracks',
    'Record Labels': 'record label releases new artists', 'Artist Experiences': 'artist sessions live performances',
    Autumn: 'autumn fall acoustic mellow music', Wellness: 'wellness mindfulness calm music',
    Celebration: 'celebration party feel good music', Relax: 'relaxing mellow ambient music', Happy: 'happy feel good upbeat songs',
};
const SEARCH_STOP_WORDS = new Set(['music', 'song', 'songs', 'track', 'tracks', 'album', 'albums', 'artist', 'artists']);
function seedValue(item) {
    const result = {};
    for (const [key, limit] of Object.entries({ kind: 10, id: 250, title: 320, author: 200, artistId: 250, albumId: 250, genre: 100, thumbnail: 1000 })) {
        if (item[key]) result[key] = String(item[key]).slice(0, limit);
    }
    if (Array.isArray(item.genres)) result.genres = item.genres.slice(0, 6).map(x => String(x).slice(0, 80));
    return JSON.stringify(result);
}

function createPlatformService({ catalog = platformCatalog, store = platformStore, history = historyStore,
    favorites = favoritesStore, playlists = playlistsStore, search: sourceSearch, now = Date.now,
    catalogConcurrency = 6, catalogQueueLimit = 1024, catalogQueueTimeoutMs = 60000 } = {}) {
    const discoveryCache = new Map();
    const homeSnapshots = new Map();
    const MAX_CACHE = 80;
    const MAX_HOME_SNAPSHOTS = 200;
    const HOME_SNAPSHOT_TTL_MS = 6 * 60 * 60_000;
    const MAX_ENRICHED_PROFILES = 80;
    const ENRICHED_PROFILE_TTL_MS = 30 * 60_000;
    const HOME_DISCOVERY_BUDGET_MS = 60_000;
    // Give the first real home shelves enough time to use the provider fallback
    // chain, while keeping the first populated view inside the user's 5–10 s
    // window. The deeper personalized profile is still fetched after this stage.
    const FEATURED_HOME_BUDGET_MS = 9_000;
    const STAFF_PICKS_BUDGET_MS = 9_000;
    const FIRST_RENDER_ALBUM_DETAILS = 12;
    const DISCOVERY_ALBUM_TIMEOUT_MS = CATALOG_REQUEST_TIMEOUT_MS;
    const DISCOVERY_ALBUM_PAGINATION_MS = CATALOG_REQUEST_TIMEOUT_MS;
    const maxCatalogConcurrency = Math.max(1, Math.min(16, Math.floor(Number(catalogConcurrency) || 3)));
    const maxCatalogQueue = Math.max(0, Math.min(10_000, Math.floor(Number(catalogQueueLimit) || 0)));
    const catalogWaitMs = Math.max(1, Math.min(60_000, Math.floor(Number(catalogQueueTimeoutMs) || 60_000)));
    let activeCatalogCalls = 0;
    const catalogQueue = [];
    const enrichedProfileCache = new Map();
    const recordingCredits = require('./recordingCredits').createRecordingCredits({ catalog: {
        search: (...args) => catalogSlot(() => catalog.search(...args)),
        detail: (...args) => catalogSlot(() => catalog.detail(...args)),
    }, now });

    function catalogBusyError() {
        return Object.assign(new Error('The music catalog is busy. Try again shortly.'), {
            code: 'CATALOG_QUEUE_BUSY', statusCode: 503,
        });
    }
    function startCatalogTask(task) {
        clearTimeout(task.timer);
        Promise.resolve().then(task.run).then(task.resolve, task.reject).finally(() => {
            while (catalogQueue.length) {
                const next = catalogQueue.shift();
                clearTimeout(next.timer);
                startCatalogTask(next);
                return;
            }
            activeCatalogCalls--;
        });
    }
    function catalogSlot(run, options = {}) {
        return new Promise((resolve, reject) => {
            const task = { run, resolve, reject, timer: null };
            if (activeCatalogCalls < maxCatalogConcurrency) {
                activeCatalogCalls++;
                startCatalogTask(task);
                return;
            }
            if (catalogQueue.length >= maxCatalogQueue) {
                reject(catalogBusyError());
                return;
            }
            const deadlineWait = Number.isFinite(Number(options?.deadlineAt))
                ? Math.max(1, Number(options.deadlineAt) - Date.now()) : catalogWaitMs;
            const waitLimit = Math.max(1, Math.min(catalogWaitMs, deadlineWait));
            task.timer = setTimeout(() => {
                const index = catalogQueue.indexOf(task);
                if (index < 0) return;
                catalogQueue.splice(index, 1);
                reject(catalogBusyError());
            }, waitLimit);
            catalogQueue.push(task);
        });
    }
    async function cached(key, run, refresh = false, ttlMs = 600000) {
        const old = discoveryCache.get(key);
        if (!refresh && old && old.expires > now()) return clone(await old.value);
        const value = Promise.resolve().then(run);
        discoveryCache.set(key, { value, expires: now() + Math.max(60000, Number(ttlMs) || 600000) });
        value.then(result => {
            const issues = result?.degradedProviders || [];
            const hasCatalogData = ['items', 'tracks', 'albums', 'artists', 'playlists'].some(key => result?.[key]?.length);
            const overloaded = issues.some(issue => issue.status === 'busy' || issue.code === 'CATALOG_QUEUE_BUSY');
            const transientEmpty = !hasCatalogData && issues.some(issue => issue.retryable || issue.status === 'unavailable');
            if (discoveryCache.get(key)?.value === value) {
                if (overloaded) discoveryCache.delete(key);
                else if (transientEmpty) discoveryCache.set(key, { value, expires: now() + 15_000 });
            }
        }, () => { if (discoveryCache.get(key)?.value === value) discoveryCache.delete(key); });
        while (discoveryCache.size > MAX_CACHE) discoveryCache.delete(discoveryCache.keys().next().value);
        return clone(await value);
    }
    function publicCatalog(ctx, method, options = {}, refresh = false) {
        const args = { country: ctx.record.settings.country, ...options };
        const cacheArgs = { ...args };
        delete cacheArgs.timeoutMs; delete cacheArgs.deadlineAt; delete cacheArgs.signal;
        return cached(`public:${method}:${ctx.day}:${hash(cacheArgs)}`, () => safe(method, args), refresh);
    }

    async function safe(method, ...args) {
        try {
            if (typeof catalog[method] !== 'function') return { items: [], degradedProviders: [] };
            const options = args.at(-1);
            return envelope(await catalogSlot(() => catalog[method](...args), options));
        } catch (error) {
            const busy = error.code === 'CATALOG_QUEUE_BUSY';
            return { items: [], degradedProviders: [{ provider: 'catalog', status: busy ? 'busy' : 'unavailable',
                code: error.code || 'CATALOG_UNAVAILABLE', retryable: true,
                message: String(error.message || 'Catalog is unavailable.').slice(0, 250) }] };
        }
    }
    function listeningEvidence(events) {
        const consumed = [];
        let ordered = true, previousAt = -Infinity;
        for (const event of events) {
            const at = Date.parse(event.at);
            if (!event.track?.title || !Number.isFinite(Number(event.seconds)) || Number(event.seconds) <= 0
                || !Number.isFinite(at) || at > now()) continue;
            if (at < previousAt) ordered = false;
            previousAt = at;
            consumed.push(event);
        }
        if (!ordered) consumed.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || titleKey(a.track).localeCompare(titleKey(b.track)));
        const recordings = new Map();
        for (const event of consumed) {
            const key = titleKey(event.track), old = recordings.get(key) || { track: event.track, seconds: 0, events: [], genres: new Set() };
            old.seconds += Number(event.seconds); old.events.push(event);
            for (const genre of itemGenres(event.track)) old.genres.add(genre);
            recordings.set(key, old);
        }
        const qualified = [...recordings.values()].filter(value => value.seconds >= 30);
        const days = new Set(), artists = new Set(), genres = new Set();
        let earliest = Infinity, latest = -Infinity;
        for (const recording of qualified) {
            if (knownArtist(recording.track.author)) artists.add(norm(recording.track.author));
            for (const genre of recording.genres) genres.add(genre);
            for (const event of recording.events) {
                days.add(new Date(event.at).toISOString().slice(0, 10));
                earliest = Math.min(earliest, Date.parse(event.at)); latest = Math.max(latest, Date.parse(event.at));
            }
        }
        const groups = new Map();
        for (const recording of qualified) {
            const keys = recording.genres.size ? [...recording.genres].map(genre => ({ id: `genre:${genre}`, type: 'genre', genre }))
                : knownArtist(recording.track.author) ? [{ id: `artist:${norm(recording.track.author)}`, type: 'artist', artist: recording.track.author }] : [];
            for (const key of keys) {
                const group = groups.get(key.id) || { ...key, recordings: [], events: [] };
                group.recordings.push(recording); group.events.push(...recording.events); groups.set(key.id, group);
            }
        }
        const clusters = [];
        for (const group of groups.values()) {
            const songSeconds = new Map(), songDays = new Map(), qualifiedKeys = new Set(), groupArtists = new Set(), groupDays = new Set();
            let seconds = 0, earnedAt;
            for (const event of group.events) {
                const key = titleKey(event.track), day = new Date(event.at).toISOString().slice(0, 10), dates = songDays.get(key) || new Set();
                dates.add(day); songDays.set(key, dates); seconds += Number(event.seconds);
                songSeconds.set(key, (songSeconds.get(key) || 0) + Number(event.seconds));
                if (songSeconds.get(key) >= 30) {
                    qualifiedKeys.add(key); for (const date of dates) groupDays.add(date);
                    if (knownArtist(event.track.author)) groupArtists.add(norm(event.track.author));
                }
                if (!earnedAt && qualifiedKeys.size >= 6 && (group.type === 'artist' || groupArtists.size >= 2) && groupDays.size >= 2 && seconds >= 1200) earnedAt = event.at;
            }
            if (!earnedAt) continue;
            const first = group.recordings.slice().sort((a, b) => a.events[0].at.localeCompare(b.events[0].at))[0].track;
            const genre = group.genre ? [...(first.genres || []), first.genre].find(value => norm(value) === group.genre) || group.genre : '';
            clusters.push({ id: group.id, type: group.type, ...(genre ? { genre } : { artist: group.artist }), earnedAt,
                seed: { kind: 'artist', id: first.artistId || '', title: first.author, author: first.author, thumbnail: first.thumbnail || '', ...(genre ? { genre, genres: [genre] } : {}) },
                tracks: unique(group.recordings.map(x => x.track), 5000) });
        }
        clusters.sort((a, b) => a.earnedAt.localeCompare(b.earnedAt) || a.id.localeCompare(b.id));
        const listening = { qualifiedTracks: qualified.length, artists: artists.size, genres: genres.size, days: days.size,
            seconds: consumed.reduce((sum, event) => sum + Number(event.seconds), 0), spanDays: qualified.length ? (latest - earliest) / DAY : 0, clusters: clusters.length };
        let unlocked = 0;
        for (const requirement of MIX_REQUIREMENTS) {
            if (!Object.entries(requirement).every(([key, minimum]) => listening[key] >= minimum)) break;
            unlocked++;
        }
        const requirements = MIX_REQUIREMENTS[unlocked];
        const progress = { unlocked, availableMixIds: Array.from({ length: unlocked }, (_, index) => `mix-${index + 1}`), listening,
            next: requirements ? { mixId: `mix-${unlocked + 1}`, requirements: { ...requirements },
                remaining: Object.fromEntries(Object.entries(requirements).map(([key, minimum]) => [key, Math.max(0, minimum - listening[key])])) } : null,
            message: unlocked === MIX_REQUIREMENTS.length ? 'All eight personal mixes are ready, each shaped by a sustained listening interest.'
                : unlocked ? `${unlocked} personal ${unlocked === 1 ? 'mix is' : 'mixes are'} ready. Keep listening over time to build your next mix.`
                    : 'Start with New Arrivals and Daily Discovery. Your first personal mix grows from distinct songs, artists and listening over at least 24 hours.' };
        return { consumed, clusters, mixProgress: progress };
    }
    async function context(user) {
        const userId = userIdOf(user);
        const [record, recent, liked, lists] = await Promise.all([
            store.read(userId), history.list(userId), Promise.resolve(favorites.list(userId)), playlists.list(userId),
        ]);
        const artists = new Map(), genres = new Map(), listened = new Map();
        const hiddenTracks = new Set(), hiddenTitles = new Set(), hiddenAlbums = new Set(), blockedArtists = new Set(), blockedArtistIds = new Set();
        const likedTracks = new Set(), likedTitles = new Set();
        const softTracks = new Map(), softArtists = new Map(), softGenres = new Map(), searchTokens = new Map();
        const addCapped = (map, key, amount, maximum = 8) => {
            if (key && amount > 0) map.set(key, Math.min(maximum, (map.get(key) || 0) + amount));
        };
        const day = new Date(now()).toISOString().slice(0, 10);
        function affinity(item, weight, at) {
            const age = at ? Math.max(0, (now() - Date.parse(at)) / DAY) : 0;
            const decayed = weight * (0.08 + 0.92 * Math.exp(-age / 180));
            const name = item.kind === 'artist' ? item.title : item.kind === 'playlist' ? '' : item.author;
            if (knownArtist(name)) {
                const key = norm(name), old = artists.get(key) || { name, weight: 0, id: item.kind === 'artist' ? item.id : item.artistId || '', thumbnail: item.kind === 'artist' ? item.thumbnail || '' : '' };
                old.weight += Number.isFinite(decayed) ? decayed : weight;
                if (!old.id) old.id = item.kind === 'artist' ? item.id : item.artistId || '';
                if (!old.thumbnail && item.kind === 'artist') old.thumbnail = item.thumbnail || '';
                artists.set(key, old);
            }
            for (const genre of itemGenres(item)) genres.set(genre, (genres.get(genre) || 0) + decayed);
        }
        const evidence = listeningEvidence(record.events);
        const consumed = evidence.consumed, consumedKeys = new Set(), playCounts = new Map();
        const signaledSkips = new Set((record.signals || []).filter(signal => signal.type === 'skip' && signal.eventId).map(signal => String(signal.eventId)));
        for (const event of consumed) {
            // Starts are recorded for recovery, but only consumed audio builds
            // taste. Long listening remains useful while recent events carry more weight.
            const duration = Number(event.track.duration) || 240;
            const completion = Math.min(1, event.seconds / duration);
            const longTerm = 0.08 + 0.92 * Math.exp(-Math.max(0, (now() - Date.parse(event.at)) / DAY) / 180);
            const repeatKey = recordingKey(event.track), titleIdentity = titleKey(event.track), plays = (playCounts.get(repeatKey) || 0) + 1;
            playCounts.set(repeatKey, plays); consumedKeys.add(repeatKey); consumedKeys.add(titleIdentity);
            const listenedWeight = Math.log1p(event.seconds / 30) * (.62 + completion * .38) + (event.completed ? 0.35 : 0);
            affinity(event.track, listenedWeight * longTerm / Math.sqrt(plays), event.at);
            for (const key of new Set([titleIdentity, repeatKey])) {
                const previous = listened.get(key);
                if (!previous || event.at > previous) listened.set(key, event.at);
            }
            // Older records may have an explicit skip reason but no persisted
            // skip signal. Preserve that exact-track hint without treating a
            // manual stop, disconnect, error, or shutdown as dislike.
            if (event.endReason === 'skip' && !signaledSkips.has(String(event.id || ''))
                && event.seconds >= 10 && duration >= 60 && completion < 0.85) {
                const fallbackSkip = Math.max(0.25, 1.25 * (1 - completion))
                    * (0.08 + 0.92 * Math.exp(-Math.max(0, (now() - Date.parse(event.at)) / DAY) / 45));
                addCapped(softTracks, titleIdentity, fallbackSkip, 3);
                addCapped(softTracks, repeatKey, fallbackSkip, 3);
            }
        }
        for (const item of recent.slice(0, 1500)) {
            if (!consumedKeys.has(titleKey(item)) && !consumedKeys.has(recordingKey(item))) affinity(item, 0.2, item.playedAt);
            for (const key of new Set([titleKey(item), recordingKey(item)])) {
                if (!listened.has(key) || item.playedAt > listened.get(key)) listened.set(key, item.playedAt);
            }
        }
        for (const item of liked) affinity(item, 4.5);
        for (const item of liked) { likedTracks.add(itemKey(item)); likedTracks.add(recordingKey(item)); likedTitles.add(titleKey(item)); }
        for (const item of record.collections.artists) affinity(item, 5);
        for (const item of record.collections.albums) affinity(item, 1.5);
        for (const feedback of record.feedback || []) {
            const item = feedback.item || {}, artist = item.kind === 'artist' ? item.title : item.author;
            if (feedback.value === 'like') {
                if (feedback.key) likedTracks.add(feedback.key);
                likedTracks.add(recordingKey(item));
                likedTitles.add(titleKey(item));
                affinity(item, 3.5, feedback.at); continue;
            }
            if (feedback.value === 'block-artist' || item.kind === 'artist' && feedback.value !== 'dislike') {
                if (knownArtist(artist)) blockedArtists.add(norm(artist));
                if (item.artistId) blockedArtistIds.add(String(item.artistId));
                if (item.id && item.kind === 'artist') blockedArtistIds.add(String(item.id));
                continue;
            }
            const legacyHide = feedback.value === 'dislike' && /not-interested/i.test(feedback.reason || '');
            if (feedback.value === 'hide-track' || legacyHide) {
                if (feedback.key) hiddenTracks.add(feedback.key);
                hiddenTitles.add(titleKey(item));
            } else if (feedback.value === 'dislike') {
                addCapped(softTracks, titleKey(item), 1.2, 3);
                addCapped(softTracks, itemKey(item), 1.2, 3);
                addCapped(softTracks, recordingKey(item), 1.2, 3);
                if (knownArtist(artist)) addCapped(softArtists, norm(artist), 0.8, 3);
                for (const genre of itemGenres(item)) addCapped(softGenres, genre, 0.35, 2);
            }
            if (feedback.value === 'hide-track' && item.kind === 'album' && item.id) hiddenAlbums.add(item.id);
        }
        for (const signal of record.signals || []) {
            const age = Math.max(0, (now() - Date.parse(signal.at || '')) / DAY), weight = Math.exp(-age / 90);
            const signalLift = 1 + Math.log1p(Math.max(0, (Number(signal.count) || 1) - 1));
            if (signal.type === 'search') {
                for (const token of new Set(norm(signal.query).split(/[^\p{L}\p{N}]+/u).filter(x => x.length > 1 && !SEARCH_STOP_WORDS.has(x)))) addCapped(searchTokens, token, weight * 0.8 * signalLift, 6);
            } else if (signal.type === 'skip' && signal.item) {
                const duration = Math.max(0, Number(signal.duration) || Number(signal.item.duration) || 0);
                const listenedSeconds = Math.max(0, Number(signal.listenedSeconds) || 0);
                const ratio = duration > 0 ? Math.min(1, listenedSeconds / duration) : 0;
                const earlySkip = Math.max(0.35, 1.7 * (1 - ratio));
                const skipLift = Math.min(2.2, 1 + Math.log1p(Math.max(0, (Number(signal.count) || 1) - 1)) * 0.3);
                const decay = Math.exp(-age / 45) * skipLift;
                addCapped(softTracks, titleKey(signal.item), earlySkip * decay, 3);
                addCapped(softTracks, itemKey(signal.item), earlySkip * decay, 3);
                addCapped(softTracks, recordingKey(signal.item), earlySkip * decay, 3);
            } else if (signal.type === 'album-open' && signal.item) affinity(signal.item, 0.5 * weight * signalLift, signal.at);
            else if (signal.type === 'artist-open' && signal.item) affinity(signal.item, 0.8 * weight * signalLift, signal.at);
            else if (signal.type === 'playlist-open' && signal.item) affinity(signal.item, 0.35 * weight * signalLift, signal.at);
        }
        for (const genre of record.settings.preferredGenres) genres.set(norm(genre), (genres.get(norm(genre)) || 0) + 8);
        const tastes = [...artists.values()].sort((a, b) => b.weight - a.weight);
        const signature = hash({ day,
            settings: { preferredGenres: record.settings.preferredGenres, excludedGenres: record.settings.excludedGenres,
                explicit: record.settings.explicit, discovery: record.settings.discovery, country: record.settings.country },
            liked: liked.map(x => [canonicalTrackKey(x), x.author, x.savedAt]),
            artists: record.collections.artists.map(x => [x.id, x.title]),
            albums: record.collections.albums.map(x => [x.id, x.author, itemGenres(x)]),
            feedback: record.feedback.map(x => [x.key, x.value]),
            events: [record.revision, consumed.length, consumed.at(-1)?.id || '', Math.floor(consumed.at(-1)?.seconds || 0)],
            signals: (record.signals || []).map(x => [x.id, x.type, x.at, x.count, x.eventId]),
            history: recent.slice(0, 1500).map(x => [canonicalTrackKey(x), x.playedAt]),
        });
        const transitions = buildTransitionModel(record.events, record.signals || [], now());
        return { userId, record, recent, liked, lists, artists, genres, listened, tastes, signature, day, clusters: evidence.clusters, mixProgress: evidence.mixProgress, transitions,
            hiddenTracks, hiddenTitles, hiddenAlbums, blockedArtists, blockedArtistIds, softTracks, softArtists, softGenres, searchTokens, likedTracks, likedTitles,
            coldStart: !liked.length && !recent.length && !consumed.length && !record.collections.artists.length && !record.collections.albums.length
                && !(record.signals || []).length && !(record.settings.preferredGenres || []).length };
    }
    function allowed(item, ctx, { clean = false, genre = '', mood = '', decade, fresh = false, queryRelevant = false } = {}) {
        if (!item?.title) return false;
        const genres = itemGenres(item), excludes = ctx.record.settings.excludedGenres.map(norm);
        if (excludes.length && (!genres.length || excludes.some(x => genreMatches(genres, x)))) return false;
        if ((clean || ctx.record.settings.explicit === false) && item.explicit !== false) return false;
        if (genre && !genreMatches(genres, norm(genre)) && !(queryRelevant && !genres.length)) return false;
        if (mood && !itemMoods(item).includes(norm(mood))
            && !(queryRelevant && !explicitMoodTags(item).length)) return false;
        if (decade != null) {
            const time = releaseTime(item);
            const year = Number.isFinite(time) ? new Date(time).getUTCFullYear()
                : !item.releaseDate && /^\d{4}$/.test(String(item.releaseYear || '')) ? Number(item.releaseYear) : NaN;
            if (!year || year < decade || year >= decade + 10) return false;
        }
        if (fresh && !isFresh(item)) return false;
        const artistName = norm(item.author || (item.kind === 'artist' ? item.title : ''));
        if (artistName && ctx.blockedArtists.has(artistName)) return false;
        if (item.artistId && ctx.blockedArtistIds.has(String(item.artistId))) return false;
        if (item.kind === 'artist' && item.id && ctx.blockedArtistIds.has(String(item.id))) return false;
        if (ctx.hiddenTracks.has(itemKey(item)) || ctx.hiddenTitles.has(titleKey(item))) return false;
        if (item.albumId && ctx.hiddenAlbums.has(item.albumId)) return false;
        if (item.album && item.author && ctx.hiddenAlbums.has(`${norm(item.album)}::${norm(item.author)}`)) return false;
        return true;
    }
    function isFresh(item) {
        return isFreshAt(item, now());
    }
    function reasonFor(item, ctx, mode, seed) {
        if (seed && norm(item.author) === norm(seed.author || seed.title)) return `From ${seed.author || seed.title}'s catalog`;
        if (seed && mode === 'radio') return `Selected for your ${seed.title || seed.author} radio`;
        if (ctx.record.collections.artists.some(x => x.id === item.artistId || norm(x.title) === norm(item.author))) return `You follow ${item.author}`;
        if (ctx.liked.some(x => norm(x.author) === norm(item.author))) return `You saved music by ${item.author}`;
        if (ctx.artists.has(norm(item.author))) return `Inspired by your listening to ${item.author}`;
        const genre = itemGenres(item).find(x => ctx.genres.has(x));
        if (genre) return `More ${item.genre || genre} for your collection`;
        if (mode === 'new-arrivals' || item.providerNewRelease) return 'A new release in the live provider catalog';
        if (item.rank > 0) return 'Popular in the current provider charts';
        return ctx.coldStart ? 'A starting point from the live catalog' : 'A fresh pick alongside your recent listening';
    }
    function rank(candidates, ctx, { id = 'daily-discovery', seed, transitionSeeds = [], limit = 40, familiar = false, filters = {}, scoreBoost } = {}) {
        const discovery = ctx.record.settings.discovery;
        const qualifiedCount = ctx.mixProgress.listening.qualifiedTracks;
        const profileConfidence = 1 - Math.exp(-Math.log1p(qualifiedCount) / Math.log1p(24));
        let ranked = unique((candidates || []).map(withArtworkFallbacks), 5000).filter(item => allowed(item, ctx, filters)).map(item => {
            const artist = ctx.artists.get(norm(item.author)), genres = itemGenres(item);
            const age = Math.max(0, (now() - Date.parse(item.releaseDate || '')) / DAY);
            const listenedAt = ctx.listened.get(titleKey(item)) || ctx.listened.get(recordingKey(item));
            let score = Number(typeof scoreBoost === 'function' ? scoreBoost(item) : 0) || 0;
            score += profileConfidence * 4.2 * (1 - Math.exp(-Math.max(0, artist?.weight || 0) / 4));
            score += profileConfidence * genres.reduce((sum, genre) => {
                const weight = Math.max(0, ctx.genres.get(genre) || 0);
                return sum + 1.25 * (1 - Math.exp(-weight / 5));
            }, 0);
            const searchable = norm([item.title, item.author, item.album, item.description, ...(item.tags || []), ...genres].join(' '));
            let queryAffinity = 0;
            for (const token of new Set(searchable.split(/[^\p{L}\p{N}]+/u).filter(x => x.length > 1 && !SEARCH_STOP_WORDS.has(x)))) queryAffinity += ctx.searchTokens.get(token) || 0;
            score += Math.min(5, queryAffinity * 1.5);
            if (item.kind === 'playlist') {
                for (const taste of ctx.tastes.slice(0, 12)) {
                    const name = norm(taste.name);
                    if (name.length > 1 && searchable.includes(name)) score += 1.8 * (1 - Math.exp(-taste.weight / 5));
                }
                for (const [genre, weight] of ctx.genres) {
                    if (genre.length > 1 && searchable.includes(genre)) score += 1.4 * (1 - Math.exp(-weight / 6));
                }
            }
            const candidateEvidence = ctx.candidateEvidence?.get(recordingKey(item));
            if (candidateEvidence) score += Math.min(2.2, Math.log1p(candidateEvidence.channelCount) * 0.68 + candidateEvidence.rrfScore * 14);
            if (candidateEvidence?.profileGenres?.length) {
                score += Math.min(1.2, candidateEvidence.profileGenres.reduce((sum, genre) => sum + Math.log1p(ctx.genres.get(genre) || 0), 0) * 0.35);
            }
            score += Math.log1p(Number(item.rank || 0)) / 12;
            score += item.thumbnail ? 0.25 : 0;
            score += item.duration >= 60 && item.duration <= 900 ? 0.2 : 0;
            if (!listenedAt) score += discovery * 2;
            else score -= Math.max(0, 2 - (now() - Date.parse(listenedAt)) / (14 * DAY));
            if (Number.isFinite(age) && age <= 365) {
                const freshness = Math.exp(-age / (id === 'new-arrivals' ? 40 : 110));
                score += freshness * (id === 'new-arrivals' ? 3 : 0.9);
            }
            if (seed) {
                if (norm(item.author) === norm(seed.author || seed.title)) score += id === 'radio' ? 0.85 : id.startsWith('mix-') ? 0.65 : 1.3;
                const seedGenres = itemGenres(seed);
                score += genres.filter(g => seedGenres.includes(g)).length * 0.55;
            }
            const sequenceSeeds = seed ? [seed, ...transitionSeeds] : transitionSeeds;
            if (sequenceSeeds.length) score += Math.min(3, Math.max(0, ...sequenceSeeds.map(value => transitionScore(ctx.transitions, value, item, now()))));
            score -= Math.min(4, ctx.softTracks.get(titleKey(item)) || 0);
            score -= Math.min(4, ctx.softTracks.get(itemKey(item)) || 0);
            score -= Math.min(4, ctx.softTracks.get(recordingKey(item)) || 0);
            score -= Math.min(3, ctx.softArtists.get(norm(item.author)) || 0);
            score -= Math.min(1.5, genres.reduce((sum, genre) => sum + (ctx.softGenres.get(genre) || 0), 0));
            if (ctx.likedTracks.has(itemKey(item)) || ctx.likedTracks.has(recordingKey(item)) || ctx.likedTitles.has(titleKey(item))) score += 3;
            score += randomScore(`${ctx.day}:${ctx.signature}:${id}:${titleKey(item)}`) * (0.15 + discovery * 0.65);
            return { item, score };
        });
        if (!familiar && id === 'daily-discovery') ranked = ranked.filter(x => !ctx.listened.has(titleKey(x.item)));
        if (id === 'new-arrivals') ranked = ranked.filter(x => isFresh(x.item));
        return diversify(ranked, { id, limit }).map(({ item }) => ({ ...item, reason: reasonFor(item, ctx, id, seed) }));
    }
    function clusterCatalog(ctx, cluster, profileData) {
        const seed = cluster.seed;
        const matches = item => cluster.type === 'genre' ? genreMatches(itemGenres(item), norm(cluster.genre))
            : norm(item.author) === norm(cluster.artist) || Boolean(seed.id && item.artistId === seed.id);
        const catalogTracks = profileData.pools.flatMap(pool => pool.items || []).filter(matches);
        const relatedKey = seed.id || norm(cluster.artist);
        const relatedTracks = cluster.type === 'artist' ? profileData.relatedTracksBySeed.get(relatedKey) || [] : [];
        return { items: unique([...catalogTracks, ...relatedTracks], 5000), degradedProviders: [] };
    }
    async function profileCandidates(ctx, refresh = false, { initial = false, deadlineAt } = {}) {
        const country = ctx.record.settings.country;
        const artistSeeds = ctx.tastes.filter(value => knownArtist(value.name)).slice(0, initial ? 2 : 3);
        const topGenres = [...ctx.genres.entries()].filter(([genre, weight]) => genre && weight > 0)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, initial ? 1 : 2);
        if (!artistSeeds.length && !topGenres.length) return { pools: [], degradedProviders: [], lookups: 0 };
        const pools = [], failures = [];
        const profileCache = (key, run) => cached(`profile-catalog:${country}:${key}`, run, refresh, 30 * 60_000);
        const artistLookups = await Promise.all(artistSeeds.map(async seed => {
            const key = hash([seed.id || '', norm(seed.name)]).slice(0, 20);
            const result = await profileCache(`artist:${key}`, () => seed.id
                ? safe('artistTracks', seed.id, { limit: initial ? 18 : 30, country, ...(deadlineAt ? { deadlineAt, timeoutMs: CATALOG_REQUEST_TIMEOUT_MS } : {}) })
                : safe('search', seed.name, 'tracks', { country, limit: initial ? 18 : 30, ...(deadlineAt ? { deadlineAt, timeoutMs: CATALOG_REQUEST_TIMEOUT_MS } : {}) }));
            const items = (result.items || result.tracks || []).filter(item => item?.kind === 'track'
                && (seed.id && item.artistId === seed.id || norm(item.author) === norm(seed.name)
                    || (item.contributors || []).some(credit => credit.id === seed.id)));
            return { seed, items, result };
        }));
        for (const value of artistLookups) {
            pools.push({ channel: 'profile-artist', weight: 1.45, items: value.items });
            failures.push(value.result);
        }
        const relatedSeeds = initial ? [] : artistSeeds.filter(seed => seed.id).slice(0, 2);
        const similarResults = await Promise.all(relatedSeeds.map(async seed => {
            const key = hash(seed.id).slice(0, 20);
            const result = await profileCache(`related:${key}`, () => safe('artistSimilar', seed.id,
                { limit: 6, country, ...(deadlineAt ? { deadlineAt, timeoutMs: CATALOG_REQUEST_TIMEOUT_MS } : {}) }));
            return { seed, items: result.items || [], result };
        }));
        for (const value of similarResults) failures.push(value.result);
        const selectedRelated = [], seenRelated = new Set();
        const eligibleRelated = value => value?.kind === 'artist' && !artistSeeds.some(seed => seed.id && value.id === seed.id);
        for (const value of similarResults) {
            const artist = value.items.find(item => eligibleRelated(item) && !seenRelated.has(item.id || norm(item.title)));
            if (!artist) continue;
            seenRelated.add(artist.id || norm(artist.title)); selectedRelated.push({ artist, seed: value.seed });
        }
        for (const value of similarResults) for (const artist of value.items) {
            if (selectedRelated.length >= 2) break;
            if (!eligibleRelated(artist) || seenRelated.has(artist.id || norm(artist.title))) continue;
            seenRelated.add(artist.id || norm(artist.title)); selectedRelated.push({ artist, seed: value.seed });
        }
        const relatedResults = await Promise.all(selectedRelated.map(async ({ artist, seed }) => {
            const key = hash([artist.id || '', norm(artist.title)]).slice(0, 20);
            const result = await profileCache(`related-tracks:${key}`, () => safe('artistTracks', artist.id,
                { limit: 24, country, ...(deadlineAt ? { deadlineAt, timeoutMs: CATALOG_REQUEST_TIMEOUT_MS } : {}) }));
            const items = (result.items || result.tracks || []).filter(item => item?.kind === 'track'
                && (!item.artistId || !artist.id || item.artistId === artist.id)
                && (!item.author || norm(item.author) === norm(artist.title)
                    || (item.contributors || []).some(credit => credit.id === artist.id)));
            return { artist, seed, items, result };
        }));
        const relatedTracksBySeed = new Map();
        for (const value of relatedResults) {
            pools.push({ channel: `profile-related-artist:${value.seed.id || norm(value.seed.name)}`, weight: 0.92, items: value.items });
            failures.push(value.result);
            for (const key of [value.seed.id, norm(value.seed.name)].filter(Boolean)) {
                const existing = relatedTracksBySeed.get(key) || [];
                relatedTracksBySeed.set(key, unique([...existing, ...value.items], 5000));
            }
        }
        const genreResults = await Promise.all(topGenres.map(async ([genre]) => {
            const key = hash(norm(genre)).slice(0, 20);
            const result = await profileCache(`genre:${key}`, () => safe('search', genre, 'tracks',
                { country, limit: initial ? 18 : 24, ...(deadlineAt ? { deadlineAt, timeoutMs: CATALOG_REQUEST_TIMEOUT_MS } : {}) }));
            const items = (result.items || result.tracks || []).filter(item => item?.kind === 'track');
            return { genre, items, result };
        }));
        for (const value of genreResults) {
            pools.push({ channel: `profile-genre:${value.genre}`, weight: 0.76, genre: value.genre, items: value.items });
            failures.push(value.result);
        }
        return { pools, relatedTracksBySeed, degradedProviders: issuesOf(failures), lookups: artistSeeds.length + relatedSeeds.length + selectedRelated.length + topGenres.length };
    }

    async function discoveryProfileCandidates(ctx, refresh, deadlineAt) {
        const key = `${ctx.userId}:${ctx.signature}:${ctx.record.settings.country}`;
        const prior = enrichedProfileCache.get(key);
        if (!refresh && prior?.data && prior.expires > now()) {
            enrichedProfileCache.delete(key); enrichedProfileCache.set(key, prior);
            return prior.data;
        }
        const initial = await profileCandidates(ctx, refresh, { initial: true, deadlineAt });
        const current = enrichedProfileCache.get(key);
        if (!current?.promise && (refresh || !current?.data || current.expires <= now())) {
            const entry = { data: null, promise: null, expires: now() + ENRICHED_PROFILE_TTL_MS };
            const backgroundDeadlineAt = Date.now() + 30_000;
            entry.promise = profileCandidates(ctx, false, { deadlineAt: backgroundDeadlineAt }).then(data => {
                if (enrichedProfileCache.get(key) !== entry) return;
                const hasCandidateData = data.pools.some(pool => pool.items?.length);
                if (data.degradedProviders.some(issue => issue.retryable || issue.status === 'busy') && !hasCandidateData) {
                    enrichedProfileCache.delete(key);
                    return;
                }
                entry.data = data;
                entry.promise = null;
                const hasProviderFailure = data.degradedProviders.some(issue => issue.status === 'unavailable');
                entry.expires = now() + (hasProviderFailure ? 5 * 60_000 : ENRICHED_PROFILE_TTL_MS);
                return data;
            }, () => {
                if (enrichedProfileCache.get(key) === entry) enrichedProfileCache.delete(key);
            });
            enrichedProfileCache.set(key, entry);
            while (enrichedProfileCache.size > MAX_ENRICHED_PROFILES) enrichedProfileCache.delete(enrichedProfileCache.keys().next().value);
        }
        const enrichment = enrichedProfileCache.get(key)?.promise;
        if (enrichment) {
            const fastEnrichment = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => resolve(null), 50);
                enrichment.then(value => { clearTimeout(timer); resolve(value || null); }, error => { clearTimeout(timer); reject(error); });
            });
            if (fastEnrichment) return fastEnrichment;
        }
        return initial;
    }

    async function personalizedPlaylistCandidates(ctx, refresh, deadlineAt) {
        const topArtist = ctx.tastes.find(value => knownArtist(value.name));
        const topGenre = [...ctx.genres.entries()].filter(([genre, weight]) => genre && weight > 0)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';
        const queries = [...new Set([topArtist?.name, topGenre && `${topGenre} music`].filter(value => value && value.trim().length >= 2))].slice(0, 2);
        if (!queries.length) return { items: [], degradedProviders: [] };
        const results = await Promise.all(queries.map(query => {
            const key = hash([ctx.record.settings.country, norm(query)]).slice(0, 24);
            return cached(`profile-playlists:${key}`, () => safe('searchPlaylists', query.slice(0, 120), {
                country: ctx.record.settings.country, limit: 100, timeoutMs: CATALOG_REQUEST_TIMEOUT_MS, deadlineAt,
            }), refresh, 30 * 60_000);
        }));
        return { items: unique(results.flatMap(result => result.items || []), 200),
            degradedProviders: results.flatMap(result => result.degradedProviders || []) };
    }

    function albumSearchPlans(ctx, { maxArtists = 2, maxGenres = 1 } = {}) {
        const plans = [], seen = new Set();
        const add = plan => {
            const key = norm(plan.query);
            if (!key || key.length < 2 || seen.has(key)) return;
            seen.add(key); plans.push(plan);
        };
        for (const artist of ctx.tastes.filter(value => knownArtist(value.name)).slice(0, maxArtists)) {
            add({ query: artist.name, artist: artist.name, artistId: artist.id || '' });
        }
        const genres = [...ctx.genres.entries()].filter(([genre, weight]) => genre && weight > 0)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([genre]) => genre);
        for (const genre of [...genres, ...ctx.record.settings.preferredGenres].slice(0, maxGenres + ctx.record.settings.preferredGenres.length)) {
            if (plans.filter(plan => !plan.artist).length >= maxGenres) break;
            add({ query: `${genre} albums`, genre });
        }
        return plans.slice(0, maxArtists + maxGenres);
    }
    async function personalizedAlbumCandidates(ctx, refresh, deadlineAt, options = {}) {
        const plans = albumSearchPlans(ctx, options);
        if (!plans.length) return { items: [], degradedProviders: [] };
        const results = await Promise.all(plans.map(async plan => {
            const cacheKey = `profile-albums:${ctx.record.settings.country}:${hash(norm(plan.query)).slice(0, 24)}`;
            let result;
            if (options.cacheOnly) {
                const previous = discoveryCache.get(cacheKey);
                result = previous && previous.expires > now() ? clone(await previous.value) : { items: [], degradedProviders: [] };
            } else {
                result = await cached(cacheKey, () => safe('search', plan.query, 'albums', {
                    country: ctx.record.settings.country, limit: 40, timeoutMs: CATALOG_REQUEST_TIMEOUT_MS, deadlineAt,
                }), refresh, 20 * 60_000);
            }
            const items = (result.items || []).filter(item => item?.kind === 'album');
            const filtered = plan.artist ? items.filter(item => norm(item.author || item.artist) === norm(plan.artist)
                || plan.artistId && String(item.artistId || '') === String(plan.artistId)) : items;
            return { items: filtered, result };
        }));
        return { items: unique(results.flatMap(result => result.items), 300),
            degradedProviders: results.flatMap(result => result.result.degradedProviders || []) };
    }
    function albumsYoullEnjoy(ctx, data) {
        const newIds = new Set((data.newAlbums || []).map(item => `album:${norm(item.title)}::${norm(item.author)}`));
        const savedIds = new Set((ctx.record.collections.albums || []).map(item => String(item.id || '')));
        const savedNames = new Set((ctx.record.collections.albums || []).map(item => `album:${norm(item.title)}::${norm(item.author)}`));
        const candidates = unique([...(data.personalizedAlbums || []), ...(data.albums || [])], 600)
            .filter(item => item?.kind === 'album' && !isFresh(item)
                && (item.thumbnail || item.artworkCandidates?.length || item.artworkFallbacks?.length)
                && !newIds.has(`album:${norm(item.title)}::${norm(item.author)}`)
                && !savedIds.has(String(item.id || ''))
                && !savedNames.has(`album:${norm(item.title)}::${norm(item.author)}`));
        return rank(candidates, ctx, { id: 'albums-youll-enjoy', familiar: true, limit: 18 });
    }

    function diverseReleaseAlbums(items, ctx, limit = FIRST_RENDER_ALBUM_DETAILS) {
        const ranked = (items || []).map(item => {
            const ageDays = Math.max(0, (now() - releaseTime(item)) / DAY);
            const artistAffinity = ctx.artists.get(norm(item.author || item.artist))?.weight || 0;
            const genreAffinity = itemGenres(item).reduce((sum, genre) => sum + (ctx.genres.get(genre) || 0), 0);
            const recency = Number.isFinite(ageDays) ? Math.exp(-ageDays / 45) : 0;
            return { item, score: artistAffinity * 0.7 + Math.min(2, genreAffinity * 0.25) + recency * 2
                + Math.log1p(Math.max(0, Number(item.rank) || 0)) * 0.04
                + randomScore(`${ctx.day}:${ctx.signature}:release-detail:${itemKey(item)}`) * 0.12 };
        }).sort((a, b) => b.score - a.score || releaseTime(b.item) - releaseTime(a.item));
        const selected = [], seenArtists = new Set(), selectedKeys = new Set();
        for (const { item } of ranked) {
            if (!item.id) continue;
            const artistKey = knownArtist(item.author || item.artist) ? norm(item.author || item.artist) : `unknown:${item.id}`;
            if (seenArtists.has(artistKey)) continue;
            seenArtists.add(artistKey); selectedKeys.add(item.id); selected.push(item);
            if (selected.length >= limit) break;
        }
        if (selected.length < limit) {
            for (const { item } of ranked) {
                if (!item.id || selectedKeys.has(item.id)) continue;
                selectedKeys.add(item.id); selected.push(item);
                if (selected.length >= limit) break;
            }
        }
        return selected;
    }

    async function discovery(ctx, { refresh = false, fullProfile = false } = {}) {
        if (refresh) catalog.clearCache?.();
        const activeClusters = ctx.clusters.slice(0, ctx.mixProgress.unlocked);
        const deadlineAt = Date.now() + HOME_DISCOVERY_BUDGET_MS;
        const [charts, releases, profileData, personalizedPlaylists] = await Promise.all([
            publicCatalog(ctx, 'charts', { deadlineAt, timeoutMs: CATALOG_REQUEST_TIMEOUT_MS }, refresh),
            publicCatalog(ctx, 'releases', { deadlineAt, timeoutMs: CATALOG_REQUEST_TIMEOUT_MS }, refresh),
            fullProfile ? profileCandidates(ctx, refresh, { deadlineAt })
                : discoveryProfileCandidates(ctx, refresh, deadlineAt),
            personalizedPlaylistCandidates(ctx, refresh, deadlineAt),
        ]);
        const clusterData = activeClusters.map(cluster => clusterCatalog(ctx, cluster, profileData));
        const catalogAlbums = unique([...(charts.albums || []), ...(releases.items || releases.albums || [])]
            .filter(item => item?.kind === 'album' && !isFresh(item)), 300);
        const personalizedAlbumPromise = catalogAlbums.length < 12
            ? personalizedAlbumCandidates(ctx, refresh, deadlineAt, { maxArtists: 3, maxGenres: 2, cacheOnly: !refresh })
            : Promise.resolve({ items: [], degradedProviders: [] });
        const freshAlbums = unique((releases.items || releases.albums || []).filter(isFresh), 300);
        const detailAlbums = diverseReleaseAlbums(freshAlbums.filter(item => item.id), ctx);
        const albumDetails = await Promise.all(detailAlbums.map(item =>
            cached(`release-detail:${ctx.record.settings.country}:${ctx.day}:${item.id}`, () => safe('detail', 'album', item.id, {
                country: ctx.record.settings.country, timeoutMs: DISCOVERY_ALBUM_TIMEOUT_MS,
                trackPaginationTimeoutMs: DISCOVERY_ALBUM_PAGINATION_MS, deadlineAt, includeVersions: false,
            }), refresh)));
        const personalizedAlbums = await personalizedAlbumPromise;
        const newTracks = [];
        for (let index = 0; index < albumDetails.length; index++) {
            const sourceAlbum = detailAlbums[index], detail = albumDetails[index];
            if (!detail?.tracks?.length || detail.id && String(detail.id) !== String(sourceAlbum.id)) continue;
            const date = releaseTime(detail) === releaseTime(sourceAlbum) || isFresh(detail) ? detail.releaseDate : sourceAlbum.releaseDate;
            const artist = detail.author || sourceAlbum.author || sourceAlbum.artist;
            if (knownArtist(sourceAlbum.author || sourceAlbum.artist) && knownArtist(artist)
                && norm(sourceAlbum.author || sourceAlbum.artist) !== norm(artist)) continue;
            for (const track of detail.tracks) {
                const enriched = { ...track, kind: track.kind || 'track', albumId: track.albumId || sourceAlbum.id,
                    album: track.album || detail.title || sourceAlbum.title, author: track.author || artist,
                    artistId: track.artistId || detail.artistId || sourceAlbum.artistId,
                    thumbnail: track.thumbnail || detail.thumbnail || sourceAlbum.thumbnail,
                    artworkCandidates: track.artworkCandidates || detail.artworkCandidates || sourceAlbum.artworkCandidates,
                    releaseDate: track.releaseDate || date || sourceAlbum.releaseDate, providerNewRelease: true };
                if (isFresh(enriched)) newTracks.push(enriched);
            }
        }
        const newAlbums = freshAlbums.map(item => {
            const detail = albumDetails.find(value => value.id === item.id);
            return detail?.title ? { ...item, ...detail } : item;
        }).filter(isFresh);
        const clusterTracks = Object.fromEntries(activeClusters.map((cluster, index) => [cluster.id,
            unique([...cluster.tracks, ...ctx.liked.filter(item => cluster.type === 'genre' ? genreMatches(itemGenres(item), norm(cluster.genre)) : norm(item.author) === norm(cluster.artist)), ...clusterData[index].items], 5000)]));
        const pools = [
            { channel: 'new-release-tracklists', weight: 1.05, items: newTracks },
            ...profileData.pools,
            ...Object.values(clusterTracks).map(items => ({ channel: 'sustained-listening-clusters', weight: 1.05, items })),
            { channel: 'regional-charts', weight: 0.36, items: charts.tracks || charts.items || [] },
            { channel: 'saved-favorites', weight: 0.5, items: ctx.liked.map(item => ({ ...item, kind: item.kind || 'track' })) },
            { channel: 'recent-listening', weight: 0.24, items: recentTracks(ctx) },
        ];
        const merged = mergeCandidatePools(pools, { limit: 5000 });
        ctx.candidateEvidence = merged.evidence;
        let tracks = merged.items;
        const data = [charts, releases, personalizedPlaylists, personalizedAlbums, ...albumDetails, ...clusterData, { degradedProviders: profileData.degradedProviders }];
        if (!tracks.length && sourceSearch && ctx.tastes.length && deadlineAt > Date.now()) {
            try { tracks = (await catalogSlot(() => sourceSearch(`${ctx.tastes[0].name} official audio`, {
                limit: 20, deadlineAt, timeoutMs: CATALOG_REQUEST_TIMEOUT_MS,
            }), { deadlineAt })).map(item => ({ ...item, kind: 'track' })); }
            catch (error) { data.push({ degradedProviders: [{ provider: 'source', status: 'unavailable', message: String(error.message).slice(0, 200) }] }); }
        }
        return { tracks, clusterTracks, newTracks: unique(newTracks, 5000), albums: unique([...newAlbums, ...(charts.albums || []), ...personalizedAlbums.items], 500),
            personalizedAlbums: personalizedAlbums.items,
            newAlbums: unique(newAlbums, 50), artists: unique(charts.artists || [], 50), playlists: unique([...(personalizedPlaylists.items || []), ...(charts.playlists || [])], 100),
            chartTracks: charts.tracks || [], degradedProviders: issuesOf(data), freshness: { generatedAt: new Date(now()).toISOString(),
                day: ctx.day, tasteRevision: ctx.record.revision, refreshAfterSeconds: 600 } };
    }
    async function featuredDiscovery(ctx) {
        const deadlineAt = Date.now() + FEATURED_HOME_BUDGET_MS;
        const requestOptions = { deadlineAt, timeoutMs: FEATURED_HOME_BUDGET_MS };
        const [charts, releases, personalizedPlaylists] = await Promise.all([
            publicCatalog(ctx, 'charts', requestOptions),
            publicCatalog(ctx, 'releases', requestOptions),
            personalizedPlaylistCandidates(ctx, false, deadlineAt),
        ]);
        const chartTracks = unique((charts.tracks || charts.items || []).filter(item => item?.kind === 'track'), 5000);
        const freshAlbums = unique([...(releases.items || releases.albums || []), ...(charts.albums || [])]
            .filter(item => item?.kind === 'album' && isFresh(item)), 300);
        const catalogAlbums = unique([...(charts.albums || []), ...(releases.items || releases.albums || [])]
            .filter(item => item?.kind === 'album' && !isFresh(item)), 300);
        const detailAlbums = diverseReleaseAlbums(freshAlbums.filter(item => item.id), ctx, FIRST_RENDER_ALBUM_DETAILS);
        const [albumDetails, personalizedAlbums] = await Promise.all([
            Promise.all(detailAlbums.map(item => cached(`release-detail:${ctx.record.settings.country}:${ctx.day}:${item.id}`, () => safe('detail', 'album', item.id, {
                country: ctx.record.settings.country, timeoutMs: DISCOVERY_ALBUM_TIMEOUT_MS,
                trackPaginationTimeoutMs: DISCOVERY_ALBUM_PAGINATION_MS, deadlineAt, includeVersions: false,
            }), false))),
            catalogAlbums.length < 10
                ? personalizedAlbumCandidates(ctx, false, deadlineAt, { maxArtists: 2, maxGenres: 1 })
                : Promise.resolve({ items: [], degradedProviders: [] }),
        ]);
        const releaseTracks = [];
        for (let index = 0; index < albumDetails.length; index++) {
            const sourceAlbum = detailAlbums[index], detail = albumDetails[index];
            if (!detail?.tracks?.length || detail.id && String(detail.id) !== String(sourceAlbum.id)) continue;
            const date = releaseTime(detail) === releaseTime(sourceAlbum) || isFresh(detail) ? detail.releaseDate : sourceAlbum.releaseDate;
            const artist = detail.author || sourceAlbum.author || sourceAlbum.artist;
            if (knownArtist(sourceAlbum.author || sourceAlbum.artist) && knownArtist(artist)
                && norm(sourceAlbum.author || sourceAlbum.artist) !== norm(artist)) continue;
            for (const track of detail.tracks) {
                const enriched = { ...track, kind: track.kind || 'track', albumId: track.albumId || sourceAlbum.id,
                    album: track.album || detail.title || sourceAlbum.title, author: track.author || artist,
                    artistId: track.artistId || detail.artistId || sourceAlbum.artistId,
                    thumbnail: track.thumbnail || detail.thumbnail || sourceAlbum.thumbnail,
                    artworkCandidates: track.artworkCandidates || detail.artworkCandidates || sourceAlbum.artworkCandidates,
                    releaseDate: track.releaseDate || date || sourceAlbum.releaseDate, providerNewRelease: true };
                if (isFresh(enriched)) releaseTracks.push(enriched);
            }
        }
        const newAlbums = freshAlbums.map(item => {
            const detail = albumDetails.find(value => value.id === item.id);
            return detail?.title ? { ...item, ...detail } : item;
        }).filter(isFresh);
        const newTracks = unique([
            ...releaseTracks,
            ...chartTracks.filter(isFresh).map(item => ({ ...item, providerNewRelease: true })),
        ], 5000);
        const recent = recentTracks(ctx);
        const pools = [
            { channel: 'new-release-tracklists', weight: 1.05, items: newTracks },
            { channel: 'regional-charts', weight: 0.36, items: chartTracks },
            { channel: 'saved-favorites', weight: 0.5, items: ctx.liked.map(item => ({ ...item, kind: item.kind || 'track' })) },
            { channel: 'recent-listening', weight: 0.24, items: recent },
        ];
        const merged = mergeCandidatePools(pools, { limit: 5000 });
        ctx.candidateEvidence = merged.evidence;
        const clusterTracks = Object.fromEntries(ctx.clusters.slice(0, ctx.mixProgress.unlocked).map(cluster => {
            const matches = item => cluster.type === 'genre' ? genreMatches(itemGenres(item), norm(cluster.genre))
                : norm(item.author) === norm(cluster.artist) || Boolean(cluster.seed?.id && item.artistId === cluster.seed.id);
            return [cluster.id, unique([...cluster.tracks, ...ctx.liked.filter(matches), ...chartTracks.filter(matches), ...newTracks.filter(matches)], 5000)];
        }));
        const playlists = unique([...(personalizedPlaylists.items || []), ...(charts.playlists || [])], 200);
        return { tracks: merged.items, clusterTracks, newTracks, albums: unique([...newAlbums, ...(charts.albums || []), ...personalizedAlbums.items], 500),
            personalizedAlbums: personalizedAlbums.items, newAlbums, artists: unique(charts.artists || [], 50), playlists, chartTracks,
            degradedProviders: issuesOf([charts, releases, personalizedPlaylists, personalizedAlbums]),
            freshness: { generatedAt: new Date(now()).toISOString(), day: ctx.day, tasteRevision: ctx.record.revision,
                refreshAfterSeconds: 600, featured: true } };
    }
    function mixSeeds(ctx, data) {
        const seeds = ctx.tastes.map(x => ({ kind: 'artist', id: x.id, title: x.name, author: x.name, thumbnail: x.thumbnail }));
        for (const artist of data.artists) if (!seeds.some(x => norm(x.title) === norm(artist.title))) seeds.push(artist);
        for (const item of data.tracks) if (knownArtist(item.author) && !seeds.some(x => norm(x.title) === norm(item.author))) seeds.push({ kind: 'artist', id: item.artistId, title: item.author, author: item.author, thumbnail: '' });
        return seeds.slice(0, 6).map(seed => {
            const own = data.tracks.filter(item => norm(item.author) === norm(seed.author || seed.title));
            return { ...seed, thumbnail: seed.thumbnail || own[0]?.thumbnail || '', genres: [...new Set(own.flatMap(itemGenres))] };
        });
    }
    function collageItems(items) {
        const seen = new Set(), result = [];
        for (const item of items) {
            if (!item?.thumbnail || seen.has(item.thumbnail) || !/^(?:https?:\/\/|\/api\/platform\/(?:upload\/art|artwork\/image)\?)/i.test(item.thumbnail)) continue;
            seen.add(item.thumbnail);
            const fields = ['kind','id','title','author','thumbnail','artworkFallbacks','album','albumId','artistId','releaseId','releaseDate','url','providerUrl','provider','source','duration'];
            result.push(Object.fromEntries(fields.filter(key => item[key] !== undefined).map(key => [key, item[key]])));
            if (result.length === 4) break;
        }
        return result;
    }
    function buildMix(ctx, data, id, seed) {
        const mixIndex = id.startsWith('mix-') ? Number(id.slice(4)) : 0;
        const cluster = mixIndex ? ctx.clusters[mixIndex - 1] : null;
        if (mixIndex && (!ctx.mixProgress.availableMixIds.includes(id) || !cluster)) return { kind: 'mix', id, title: `My Mix ${mixIndex}`,
            subtitle: ctx.mixProgress.message, locked: true, tracks: [], count: 0, artworkType: 'mix', mixIndex,
            targetCount: mixTargetCount(ctx.userId, ctx.day, id), availableCount: 0,
            artworkImages: [], mixProgress: ctx.mixProgress, freshness: data.freshness, degradedProviders: data.degradedProviders };
        const selectedSeed = seed || (mixIndex ? cluster?.seed : id === 'radio' ? mixSeeds(ctx, data)[0] : null);
        let candidates = mixIndex ? data.clusterTracks[cluster.id] || []
            : id === 'new-arrivals' ? data.newTracks || [] : data.tracks;
        if (mixIndex && cluster?.type === 'genre') {
            const genre = norm(cluster.genre);
            const additional = data.tracks.filter(item => genreMatches(itemGenres(item), genre)
                || ctx.candidateEvidence?.get(recordingKey(item))?.profileGenres?.includes(genre));
            candidates = unique([...candidates, ...additional], 5000);
        }
        if (id === 'radio' && selectedSeed?.kind === 'track') {
            const seedIdentity = recordingKey(selectedSeed);
            candidates = candidates.filter(item => recordingKey(item) !== seedIdentity);
        }
        let sequenceSeeds = selectedSeed?.kind === 'track' ? [selectedSeed] : [];
        if (id !== 'new-arrivals' && !sequenceSeeds.length) {
            const matchingEvents = ctx.record.events.filter(event => event.track?.title && event.seconds > 0 && (!selectedSeed
                || selectedSeed.kind === 'artist' && (norm(event.track.author) === norm(selectedSeed.author || selectedSeed.title)
                    || selectedSeed.id && event.track.artistId === selectedSeed.id)
                || selectedSeed.genre && itemGenres(event.track).includes(norm(selectedSeed.genre))))
                .sort((a, b) => String(b.at).localeCompare(String(a.at)));
            const seenSeeds = new Set();
            for (const event of matchingEvents) {
                const key = recordingKey(event.track);
                if (seenSeeds.has(key)) continue;
                seenSeeds.add(key); sequenceSeeds.push(event.track);
                if (sequenceSeeds.length >= 4) break;
            }
        }
        if (sequenceSeeds.length) {
            const learned = unique(sequenceSeeds.flatMap(value => transitionCandidates(ctx.transitions, value, 16, now())), 64);
            candidates = unique([...learned, ...candidates], 5000);
        }
        if (id === 'new-arrivals' && data.newAlbums.length) {
            const albums = new Set(data.newAlbums.map(x => x.id));
            candidates = candidates.map(x => albums.has(x.albumId) ? { ...x, providerNewRelease: true } : x);
        }
        const rankedTracks = rank(candidates, ctx, { id, seed: selectedSeed, transitionSeeds: sequenceSeeds, familiar: Boolean(mixIndex) || id === 'radio',
            filters: id === 'new-arrivals' ? { fresh: true } : {}, limit: mixIndex ? 5000 : 40 });
        const targetCount = mixIndex ? mixTargetCount(ctx.userId, ctx.day, id, rankedTracks.length) : undefined;
        if (mixIndex && rankedTracks.length < MIX_MIN_TRACKS) return { kind: 'mix', id, title: `My Mix ${mixIndex}`,
            subtitle: 'This mix is still building. It will appear when at least 30 distinct eligible songs are available.',
            locked: true, tracks: [], count: 0, artworkType: 'mix', mixIndex, targetCount, availableCount: rankedTracks.length,
            artworkImages: [], mixProgress: ctx.mixProgress, freshness: data.freshness, degradedProviders: data.degradedProviders };
        const tracks = mixIndex ? rankedTracks.slice(0, targetCount) : rankedTracks;
        const title = id === 'daily-discovery' ? 'My Daily Discovery' : id === 'new-arrivals' ? 'My New Arrivals'
            : id === 'radio' ? selectedSeed ? selectedSeed.title || selectedSeed.author || 'Your Radio' : 'Your Radio'
                : `My Mix ${id.slice(4)}`;
        const subtitle = id === 'daily-discovery' ? 'Fresh discoveries shaped by your listening, refreshed daily'
            : id === 'new-arrivals' ? 'Recent releases from the live catalog'
                : id === 'radio' ? selectedSeed?.kind === 'artist' ? 'Artist Radio' : selectedSeed?.author || 'Track Radio'
                : cluster?.type === 'genre' ? `Your sustained listening to ${cluster.genre}` : selectedSeed ? `Inspired by ${selectedSeed.author || selectedSeed.title}` : 'A starting point from the live charts';
        const artworkType = id === 'new-arrivals' ? 'arrivals' : id === 'daily-discovery' ? 'discovery' : id === 'radio' ? selectedSeed?.kind === 'artist' ? 'artist-radio' : 'track-radio' : 'mix';
        const artworkItems = collageItems([selectedSeed, ...tracks]), artworkImages = artworkItems.map(item => item.thumbnail);
        return { kind: 'mix', id, title, subtitle, artworkType, artworkImages, artworkItems, ...(mixIndex ? { mixIndex, targetCount, availableCount: rankedTracks.length,
            cluster: { id: cluster.id, type: cluster.type, ...(cluster.genre ? { genre: cluster.genre } : { artist: cluster.artist }), earnedAt: cluster.earnedAt } } : {}), thumbnail: selectedSeed?.thumbnail || tracks[0]?.thumbnail || '', tracks,
            count: tracks.length, reasons: [...new Set(tracks.map(x => x.reason))].slice(0, 6), freshness: data.freshness,
            degradedProviders: data.degradedProviders, ...(selectedSeed ? { seed: seedValue(selectedSeed) } : {}) };
    }
    function profile(ctx) {
        return { coldStart: ctx.coldStart, topArtists: ctx.tastes.slice(0, 6).map(x => x.name),
            preferredGenres: ctx.record.settings.preferredGenres, excludedGenres: ctx.record.settings.excludedGenres,
            discovery: ctx.record.settings.discovery, explicit: ctx.record.settings.explicit, preferences: ctx.record.settings, mixProgress: ctx.mixProgress };
    }
    function recentTracks(ctx) {
        const events = ctx.record.events.filter(event => event.seconds > 0).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300)
            .map(event => ({ ...event.track, playedAt: event.at }));
        return unique([...events, ...ctx.recent.map(x => ({ ...x, kind: 'track' }))], 100);
    }
    function playlistItems(ctx) { return ctx.lists.map(x => ({ ...x, kind: 'playlist', title: x.name, author: 'Your playlist' })); }
    function favoriteArtistItems(ctx, data) {
        const catalogArtists = data.artists || [];
        const artistsById = new Map(catalogArtists.filter(item => item.id).map(item => [item.id, item]));
        const artistsByName = new Map(catalogArtists.map(item => [norm(item.title), item]));
        const followed = ctx.record.collections.artists.map(item => {
            const catalogItem = artistsById.get(item.id) || artistsByName.get(norm(item.title));
            return { ...catalogItem, ...item, kind: 'artist', title: item.title || catalogItem?.title,
                author: item.title || catalogItem?.title, thumbnail: item.thumbnail || catalogItem?.thumbnail || '' };
        });
        const listened = ctx.tastes.filter(value => knownArtist(value.name)).map(value => {
            const catalogItem = artistsById.get(value.id) || artistsByName.get(norm(value.name));
            return { ...catalogItem, kind: 'artist', id: value.id || catalogItem?.id || '', title: value.name,
                author: value.name, thumbnail: catalogItem?.thumbnail || value.thumbnail || '' };
        });
        return unique([...followed, ...listened], 18);
    }
    function initialHome(ctx) {
        const previous = homeSnapshots.get(ctx.userId);
        if (previous && previous.country === ctx.record.settings.country && now() - previous.savedAt < HOME_SNAPSHOT_TTL_MS) {
            homeSnapshots.delete(ctx.userId);
            homeSnapshots.set(ctx.userId, previous);
            return { ...clone(previous.data), backgroundLoading: true, staleSnapshot: true };
        }
        const recent = recentTracks(ctx);
        const localItems = [...ctx.record.collections.mixes, ...playlistItems(ctx), ...ctx.record.collections.albums, ...recent];
        const sections = [];
        if (localItems.length) sections.push(section('shortcuts', 'Your shortcuts', localItems.slice(0, 8)));
        if (recent.length) sections.push(section('recently-played', 'Recently played', recent.slice(0, 18), 'tracks'));
        const artists = favoriteArtistItems(ctx, { artists: [] });
        if (artists.length) sections.push(section('favorite-artists', 'Your favorite artists', artists, 'artists'));
        if (ctx.record.collections.uploads.length) sections.push(section('uploads', 'Your uploaded music', ctx.record.collections.uploads.slice(0, 12)));
        if (recent.length) sections.push(section('listening-history', 'Your listening history', recent.slice(0, 30), 'tracks'));
        return { title: 'For you', sections, backgroundLoading: true, profile: { ...profile(ctx), mixProgress: ctx.mixProgress },
            mixProgress: ctx.mixProgress, freshness: { generatedAt: new Date(now()).toISOString(), localSnapshot: true }, degradedProviders: [],
            ...(ctx.coldStart ? { welcome: 'Your home is ready. Live recommendations are loading in the background.' } : {}) };
    }
    async function featuredHome(ctx) {
        const data = await featuredDiscovery(ctx);
        const readyMixes = ctx.mixProgress.availableMixIds.map(id => buildMix(ctx, data, id))
            .filter(item => !item.locked).map(({ tracks, ...item }) => ({ ...item, count: tracks.length }));
        const recent = recentTracks(ctx);
        const seed = recent[0] || (ctx.tastes[0] ? { title: ctx.tastes[0].name, author: ctx.tastes[0].name } : null);
        const artists = favoriteArtistItems(ctx, data);
        const albumRecommendations = albumsYoullEnjoy(ctx, data);
        const popularPlaylists = diversify((data.playlists || []).map(item => ({ item,
            score: Math.log1p(Math.max(0, Number(item.rank || item.fans || item.userCount || 0))) })),
        { id: 'home:popular-playlists', limit: 18 }).map(value => value.item);
        const radioSeeds = unique([...recent.slice(0, 2), ...mixSeeds(ctx, data).slice(0, 2)], 4);
        const radios = radioSeeds.map(value => {
            const radio = buildMix(ctx, data, 'radio', value);
            return { ...radio, id: `radio:${value.kind === 'artist' ? 'artist' : 'track'}:${hash(seedValue(value)).slice(0, 12)}`, tracks: undefined };
        });
        const sections = [
            section('shortcuts', 'Your shortcuts', [...ctx.record.collections.mixes, ...playlistItems(ctx), ...ctx.record.collections.albums, ...recent].slice(0, 8)),
            section('custom-mixes', 'Custom mixes', readyMixes, 'cards'),
            section('suggested-new-albums', 'Suggested new albums for you', rank(data.newAlbums, ctx, { id: 'new-arrivals', familiar: true, limit: 18 })),
            section('recently-played', 'Recently played', recent.slice(0, 18), 'tracks'),
            section('recommended-tracks', 'Recommended new tracks', rank(data.newTracks, ctx, { id: 'new-arrivals', filters: { fresh: true }, limit: 30 }), 'tracks'),
            section('albums-youll-enjoy', 'Albums you’ll enjoy', albumRecommendations),
            section('uploads', 'Your uploaded music', ctx.record.collections.uploads.slice(0, 12)),
            section('because-you-listened', seed ? `Because you listened to ${seed.title}` : 'Start exploring', rank(data.tracks, ctx, { id: 'radio', seed, familiar: true, limit: 12 }), 'tracks'),
            section('suggested-playlists', "User playlists you'll love", rank(data.playlists, ctx, { id: 'playlists', familiar: true, limit: 18 })),
            section('favorite-artists', 'Your favorite artists', artists, 'artists'),
            section('essentials', 'Current essentials', data.chartTracks.filter(item => allowed(item, ctx)), 'tracks'),
            section('popular-playlists', 'Popular playlists', popularPlaylists),
            section('personal-radio', 'Personal radio stations', radios),
            section('listening-history', 'Your listening history', recent.slice(0, 30), 'tracks'),
        ].filter(value => value.items.length);
        return { title: 'For you', sections, profile: { ...profile(ctx), mixProgress: ctx.mixProgress },
            mixProgress: ctx.mixProgress, freshness: data.freshness, degradedProviders: data.degradedProviders,
            backgroundLoading: true, featured: true,
            ...(ctx.coldStart ? { welcome: 'Live charts and new releases help you get started. Save music and listen to personalize your mixes.' } : {}) };
    }
    async function home(user, options = {}) {
        const ctx = await context(user), tab = options.tab || 'for-you';
        if (!['for-you', 'staff', 'uploads'].includes(tab)) throw requestError('Unknown music tab.');
        if (tab === 'for-you' && options.stage === 'initial') return initialHome(ctx);
        if (tab === 'for-you' && options.stage === 'featured') return featuredHome(ctx);
        if (tab === 'uploads') return { title: 'Your uploads', sections: [section('uploads', 'Your uploaded music', ctx.record.collections.uploads, 'tracks')],
            profile: profile(ctx), mixProgress: ctx.mixProgress, freshness: { generatedAt: new Date(now()).toISOString() }, degradedProviders: [],
            emptyState: ctx.record.collections.uploads.length ? '' : 'Upload music to build your personal collection.' };
        if (tab === 'staff') {
            const deadlineAt = Date.now() + STAFF_PICKS_BUDGET_MS;
            const requestOptions = { country: ctx.record.settings.country, deadlineAt, timeoutMs: STAFF_PICKS_BUDGET_MS };
            const [editorial, charts, releases, personalizedAlbums, personalizedPlaylists] = await Promise.all([
                cached(`staff-editorial:${ctx.record.settings.country}:${ctx.day}`,
                    () => safe('editorial', requestOptions), false, 30 * 60_000),
                publicCatalog(ctx, 'charts', requestOptions),
                publicCatalog(ctx, 'releases', requestOptions),
                personalizedAlbumCandidates(ctx, false, deadlineAt, { maxArtists: 2, maxGenres: 2 }),
                personalizedPlaylistCandidates(ctx, false, deadlineAt),
            ]);
            const editorialAlbums = editorial.albums || editorial.items || [];
            const releaseAlbums = releases.items || releases.albums || [];
            const albumPool = unique([...editorialAlbums, ...(charts.albums || []), ...releaseAlbums, ...personalizedAlbums.items]
                .filter(item => item?.kind === 'album'
                    && (item.thumbnail || item.artworkCandidates?.length || item.artworkFallbacks?.length)), 800);
            const trackPool = unique([...(editorial.tracks || []), ...(charts.tracks || charts.items || [])]
                .filter(item => item?.kind === 'track'), 1000);
            const playlistPool = unique([...(editorial.playlists || []), ...(charts.playlists || []), ...personalizedPlaylists.items]
                .filter(item => item?.kind === 'playlist'), 500);
            const sourceScore = pools => {
                const scores = new Map();
                for (const [items, amount] of pools) for (const item of items || []) {
                    const key = titleKey(item);
                    scores.set(key, Math.max(scores.get(key) || 0, amount));
                }
                return item => scores.get(titleKey(item)) || 0;
            };
            const staffSubtitle = 'Editorial catalog, current charts and discovery picks · reshuffled daily';
            const sections = [
                section('staff-albums', 'Selected albums', rank(albumPool, ctx, { id: 'staff:albums', familiar: true, limit: 24,
                    scoreBoost: sourceScore([[editorialAlbums, 2.2], [releaseAlbums, 1.1], [charts.albums || [], 0.9], [personalizedAlbums.items, 0.65]]) }), 'cards', staffSubtitle),
                section('staff-tracks', 'Selected tracks', rank(trackPool, ctx, { id: 'staff:tracks', familiar: true, limit: 30,
                    scoreBoost: sourceScore([[editorial.tracks || [], 2.2], [charts.tracks || charts.items || [], 0.8]]) }), 'tracks', staffSubtitle),
                section('staff-playlists', 'Playlists to explore', rank(playlistPool, ctx, { id: 'staff:playlists', familiar: true, limit: 24,
                    scoreBoost: sourceScore([[editorial.playlists || [], 2.2], [charts.playlists || [], 0.9], [personalizedPlaylists.items, 0.55]]) }), 'cards', staffSubtitle),
            ].filter(value => value.items.length);
            return { title: 'Staff Picks', sections, profile: profile(ctx), mixProgress: ctx.mixProgress,
                freshness: { generatedAt: new Date(now()).toISOString(), day: ctx.day, refreshAfterSeconds: 900 },
                degradedProviders: issuesOf([editorial, charts, releases, personalizedAlbums, personalizedPlaylists]) };
        }
        const data = await discovery(ctx, options);
        const mixIds = ['new-arrivals', 'daily-discovery', ...ctx.mixProgress.availableMixIds];
        const builtMixes = mixIds.map(id => buildMix(ctx, data, id));
        const mixes = builtMixes.filter(item => !item.locked).map(({ tracks, ...item }) => ({ ...item, count: tracks.length }));
        const homeMixProgress = { ...ctx.mixProgress, readyMixIds: builtMixes.filter(item => item.mixIndex && !item.locked).map(item => item.id) };
        const recent = recentTracks(ctx);
        const newAlbums = rank(data.newAlbums, ctx, { id: 'new-arrivals', familiar: true, limit: 18 });
        const seed = recent[0] || (ctx.tastes[0] ? { title: ctx.tastes[0].name, author: ctx.tastes[0].name } : null);
        const artists = favoriteArtistItems(ctx, data);
        const albumRecommendations = albumsYoullEnjoy(ctx, data);
        const popularPlaylists = diversify((data.playlists || []).map(item => ({ item,
            score: Math.log1p(Math.max(0, Number(item.rank || item.fans || item.userCount || 0))) })),
        { id: 'home:popular-playlists', limit: 18 }).map(value => value.item);
        const radioSeeds = unique([...recent.slice(0, 2), ...mixSeeds(ctx, data).slice(0, 2)], 4);
        const radios = radioSeeds.map(value => {
            const radio = buildMix(ctx, data, 'radio', value);
            return { ...radio, id: `radio:${value.kind === 'artist' ? 'artist' : 'track'}:${hash(seedValue(value)).slice(0,12)}`, tracks: undefined };
        });
        const sections = [
            section('shortcuts', 'Your shortcuts', [...ctx.record.collections.mixes, ...playlistItems(ctx), ...ctx.record.collections.albums, ...recent].slice(0, 8)),
            section('custom-mixes', 'Custom mixes', mixes, 'cards'),
            section('suggested-new-albums', 'Suggested new albums for you', newAlbums),
            section('recently-played', 'Recently played', recent.slice(0, 18), 'tracks'),
            section('recommended-tracks', 'Recommended new tracks', rank(data.newTracks || [], ctx, { id: 'new-arrivals', filters: { fresh: true }, limit: 30 }), 'tracks'),
            section('albums-youll-enjoy', 'Albums you’ll enjoy', albumRecommendations),
            section('uploads', 'Your uploaded music', ctx.record.collections.uploads.slice(0, 12)),
            section('because-you-listened', seed ? `Because you listened to ${seed.title}` : 'Start exploring', rank(data.tracks, ctx, { id: 'radio', seed, familiar: true, limit: 12 }), 'tracks'),
            section('suggested-playlists', "User playlists you'll love", rank(data.playlists, ctx, { id: 'playlists', familiar: true, limit: 18 })),
            section('favorite-artists', 'Your favorite artists', artists, 'artists'),
            section('essentials', 'Current essentials', data.chartTracks.filter(item => allowed(item, ctx)), 'tracks'),
            section('popular-playlists', 'Popular playlists', popularPlaylists),
            section('personal-radio', 'Personal radio stations', radios),
            section('listening-history', 'Your listening history', recent.slice(0, 30), 'tracks'),
        ].filter(value => value.items.length);
        const genres = [...ctx.genres].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([genre]) => genre);
        for (const genre of genres) {
            const items = rank(data.tracks.filter(x => genreMatches(itemGenres(x), genre)), ctx, { id: `explore:genre:${genre}`, limit: 12, familiar: true });
            if (items.length) sections.splice(9, 0, section(`genre-${genre.replace(/[^\p{L}\p{N}]+/gu, '-')}`, genre[0].toUpperCase() + genre.slice(1), items));
        }
        const result = { title: 'For you', sections, profile: { ...profile(ctx), mixProgress: homeMixProgress }, mixProgress: homeMixProgress, freshness: data.freshness, degradedProviders: data.degradedProviders,
            ...(ctx.coldStart ? { welcome: 'Live charts and new releases help you get started. Save music and listen to personalize your mixes.' } : {}) };
        homeSnapshots.delete(ctx.userId);
        homeSnapshots.set(ctx.userId, { country: ctx.record.settings.country, savedAt: now(), data: clone(result) });
        while (homeSnapshots.size > MAX_HOME_SNAPSHOTS) homeSnapshots.delete(homeSnapshots.keys().next().value);
        return result;
    }
    function exploreSearchQuery(filters, fallbackQuery = '') {
        const terms = [];
        if (filters.mood) terms.push(MOOD_SEARCH_TERMS[MOODS.find(value => norm(value) === norm(filters.mood))] || filters.mood);
        if (filters.genre) terms.push(`${filters.genre} music`);
        if (filters.decade != null) terms.push(`${filters.decade}s`);
        return (terms.length ? terms.join(' ') : fallbackQuery).replace(/\s+/g, ' ').trim().slice(0, 150);
    }
    async function recoverExploreCatalog(ctx, filters, data, refresh, fallbackQuery = '', requestedKinds = null) {
        const relevantItems = {
            tracks: data.tracks || data.items?.filter(item => item.kind === 'track') || [],
            albums: data.albums || [], artists: data.artists || [], playlists: data.playlists || [],
        };
        const fields = Object.entries(relevantItems)
            .filter(([kind, items]) => (!requestedKinds || requestedKinds.includes(kind))
                && !items.some(item => allowed(item, ctx, { ...filters, queryRelevant: true })))
            .map(([kind]) => kind);
        const query = exploreSearchQuery(filters, fallbackQuery);
        if (!fields.length || query.length < 2) return data;
        const results = await Promise.all(fields.map(async kind => [kind, await cached(
            `explore-search:${ctx.record.settings.country}:${ctx.day}:${kind}:${hash(query)}`,
            () => kind === 'playlists'
                ? safe('searchPlaylists', query, { country: ctx.record.settings.country, limit: 100, timeoutMs: 12_000 })
                : safe('search', query, kind, { country: ctx.record.settings.country, limit: 100, timeoutMs: 12_000 }),
            refresh, 5 * 60_000,
        )]));
        const merged = { ...data, degradedProviders: [...(data.degradedProviders || [])] };
        for (const [kind, result] of results) {
            merged[kind] = unique([...(kind === 'tracks' ? data.tracks || data.items?.filter(item => item.kind === 'track') || [] : data[kind] || []), ...(result.items || [])], 5000);
            merged.degradedProviders.push(...(result.degradedProviders || []));
        }
        merged.items = [...(merged.tracks || []), ...(merged.albums || []), ...(merged.artists || [])];
        return merged;
    }
    async function recoverSparseDecadeCatalog(ctx, decade, data, refresh) {
        const filters = { decade, queryRelevant: true };
        const plans = [
            { kind: 'albums', minimum: 12, queries: [`${decade}s albums`, `classic albums from the ${decade}s`] },
            { kind: 'tracks', minimum: 24, queries: [`${decade}s songs`, `classic music from the ${decade}s`] },
        ].filter(plan => (data[plan.kind] || []).filter(item => allowed(item, ctx, filters)).length < plan.minimum);
        if (!plans.length) return data;
        const lookups = plans.flatMap(plan => plan.queries.map(query => ({ ...plan, query })));
        const results = await Promise.all(lookups.map(async lookup => [lookup.kind, await cached(
            `explore-decade:${ctx.record.settings.country}:${ctx.day}:${lookup.kind}:${hash(lookup.query)}`,
            () => safe('search', lookup.query, lookup.kind, { country: ctx.record.settings.country, limit: 100, timeoutMs: 12_000 }),
            refresh, 20 * 60_000,
        )]));
        const merged = { ...data, degradedProviders: [...(data.degradedProviders || [])] };
        for (const [kind, result] of results) {
            merged[kind] = unique([...(merged[kind] || []), ...(result.items || []).map(withArtworkFallbacks)], 5000);
            merged.degradedProviders.push(...(result.degradedProviders || []));
        }
        merged.items = [...(merged.tracks || []), ...(merged.albums || []), ...(merged.artists || [])];
        return merged;
    }
    async function freshExploreReleaseTracks(ctx, albums, refresh = false) {
        const selected = diverseReleaseAlbums((albums || []).filter(isFresh), ctx, 12);
        if (!selected.length) return [];
        const deadlineAt = Date.now() + 60_000;
        const details = await Promise.all(selected.map(album => cached(
            `explore-release-detail:${ctx.record.settings.country}:${ctx.day}:${album.id}`,
            () => safe('detail', 'album', album.id, { country: ctx.record.settings.country, includeVersions: false,
                timeoutMs: DISCOVERY_ALBUM_TIMEOUT_MS, trackPaginationTimeoutMs: DISCOVERY_ALBUM_PAGINATION_MS, deadlineAt }),
            refresh, 30 * 60_000,
        )));
        const tracks = [];
        for (let index = 0; index < details.length; index++) {
            const source = selected[index], detail = details[index];
            if (detail?.id && String(detail.id) !== String(source.id)) continue;
            const releaseDate = isFresh(detail) ? detail.releaseDate : source.releaseDate;
            const author = detail.author || source.author || source.artist || '';
            for (const track of detail.tracks || []) {
                const item = { ...track, kind: 'track', albumId: track.albumId || source.id,
                    album: track.album || detail.title || source.title, author: track.author || author,
                    artistId: track.artistId || detail.artistId || source.artistId,
                    thumbnail: track.thumbnail || detail.thumbnail || source.thumbnail || '',
                    artworkCandidates: track.artworkCandidates || detail.artworkCandidates || source.artworkCandidates,
                    artworkFallbacks: track.artworkFallbacks || detail.artworkFallbacks || source.artworkFallbacks,
                    releaseDate: track.releaseDate || releaseDate || '' };
                if (item.title && isFresh(item)) tracks.push(item);
            }
        }
        return unique(tracks, 5000);
    }
    async function explore(user, options = {}) {
        const ctx = await context(user), mode = options.mode || 'top';
        if (!['new', 'top', 'videos', 'clean'].includes(mode)) throw requestError('Unsupported Explore view.');
        const selectedGenre = String(options.genre || '').trim().slice(0, 100);
        const genres = selectedGenre
            ? await cached(`genres:${ctx.day}`, () => safe('genres'), options.refresh)
            : { items: [], degradedProviders: [] };
        const genre = genres.items?.find(x => x.id === selectedGenre)?.title || selectedGenre;
        const requestedMood = String(options.mood || options.activity || '').trim().slice(0, 80);
        const mood = MOODS.find(value => norm(value) === norm(requestedMood)) || '';
        if (requestedMood && !mood) throw requestError('Unsupported mood or activity view.');
        let decade;
        if (options.decade) {
            const match = /^(19\d0|20\d0)s?$/.exec(String(options.decade));
            if (!match) throw requestError('Decade must use a value such as 1990s.');
            decade = Number(match[1]);
        }
        const filters = { genre, mood, decade, clean: mode === 'clean' || options.clean === true || options.clean === 'true' };
        const requestOptions = { genre, mood, decade };
        const facets = { genres: [], moods: [...MOODS],
            activities: ['Workout', 'Study', 'Driving', 'Party', 'Sleep'], decades: ['1950s', '1960s', '1970s', '1980s', '1990s', '2000s', '2010s', '2020s'],
            modes: ['new', 'top', 'videos', 'clean'], selected: { genre, mood, decade: decade ? `${decade}s` : '', clean: filters.clean, mode } };
        if (mode === 'videos') return { ...await videoCollections(ctx, filters, options), facets };
        if (genre || mood || decade) {
            let [data, releases] = await Promise.all([publicCatalog(ctx, 'browse', requestOptions, options.refresh),
                publicCatalog(ctx, 'releases', genre ? { genre } : {}, options.refresh)]);
            data = await recoverExploreCatalog(ctx, filters, data, options.refresh);
            if (decade != null) data = await recoverSparseDecadeCatalog(ctx, decade, data, options.refresh);
            const title = [genre, mood, decade ? `${decade}s` : ''].filter(Boolean).join(' · ');
            const types = [genre && 'genre', mood && 'mood', decade && 'decade'].filter(Boolean);
            const queryFilters = { ...filters, queryRelevant: true };
            const select = (items, id, extra = {}, limit = 24) => rank(items || [], ctx, {
                id: `explore:${id}`, familiar: true, filters: { ...queryFilters, ...extra }, limit,
            });
            const albumShelf = (data.albums || []).map(album => {
                if (album.thumbnail || album.artworkFallbacks?.length || album.artworkCandidates?.length) return withArtworkFallbacks(album);
                const artist = norm(album.author), title = norm(album.title);
                const matchingTrack = (data.tracks || []).find(track => track.thumbnail
                    && ((album.id && String(track.albumId || '') === String(album.id))
                        || (norm(track.author) === artist && norm(typeof track.album === 'string' ? track.album : track.album?.title) === title)));
                return matchingTrack ? { ...album, thumbnail: matchingTrack.thumbnail,
                    artworkFallbacks: matchingTrack.artworkFallbacks || matchingTrack.artworkCandidates || [] } : album;
            }).filter(item => item.thumbnail || item.artworkFallbacks?.length || item.artworkCandidates?.length);
            return { title, category: { type: types[0], types, title, genre, mood, decade: decade ? `${decade}s` : '' }, facets,
                sections: [section('category-playlists', `${title} playlists`, select(data.playlists, 'category-playlists')),
                    section('category-tracks', `${title} tracks`, select(data.tracks || (data.items || []).filter(item => item.kind === 'track'), 'category-tracks', {}, 50), 'tracks'),
                    section('category-albums', `${title} albums`, select(albumShelf, 'category-albums')),
                    section('category-artists', `${title} artists`, select(data.artists, 'category-artists'), 'artists'),
                    section('category-new-releases', `New in ${title}`, select([...(data.newReleases || []), ...(releases.items || releases.albums || [])], 'category-new-releases', { fresh: true }))],
                degradedProviders: issuesOf([genres, data, releases]), freshness: { generatedAt: new Date(now()).toISOString(), refreshAfterSeconds: 600 },
                selectionReason: 'Results combine provider tags with category-focused catalog search; verified release years, explicit-content and your exclusions remain enforced.' };
        }
        let data = await publicCatalog(ctx, mode === 'new' ? 'releases' : 'charts', {}, options.refresh);
        let newReleaseTracks = [];
        if (mode === 'new') {
            const releasedAlbums = data.albums || data.items || [];
            newReleaseTracks = await freshExploreReleaseTracks(ctx, releasedAlbums, options.refresh);
            if (!newReleaseTracks.length) {
                const year = new Date(now()).getUTCFullYear();
                data = await recoverExploreCatalog(ctx, filters, { ...data, tracks: [] }, options.refresh, `new music ${year}`, ['tracks']);
                newReleaseTracks = (data.tracks || []).filter(isFresh);
            }
        } else if (!(data.tracks || data.items?.some(item => item.kind === 'track'))) {
            const fallback = mode === 'clean' ? 'clean popular music' : 'popular music charts';
            data = await recoverExploreCatalog(ctx, filters, data, options.refresh, fallback, ['tracks']);
        }
        const albums = rank(data.albums || (mode === 'new' ? data.items || [] : []), ctx, { id: 'explore:albums', familiar: true,
            filters: { ...filters, queryRelevant: true, fresh: mode === 'new' }, limit: 24 });
        const trackCandidates = mode === 'new' ? newReleaseTracks : data.tracks || (data.items || []).filter(item => item.kind === 'track');
        const tracks = rank(trackCandidates, ctx, { id: 'explore:tracks', familiar: true,
            filters: { ...filters, queryRelevant: true, fresh: mode === 'new' }, limit: 50 });
        return { title: { new: 'New releases', top: 'Explore', clean: 'Clean' }[mode], facets,
            sections: [section('explore-albums', mode === 'new' ? 'New albums' : 'Albums to explore', albums),
                section('explore-tracks', mode === 'clean' ? 'Clean tracks' : 'Tracks to explore', tracks, 'tracks')],
            degradedProviders: issuesOf([genres, data]), freshness: { generatedAt: new Date(now()).toISOString(), refreshAfterSeconds: 600 },
            ...(filters.clean ? { availability: { message: 'Only music explicitly marked clean by its provider is shown; unlabelled music is excluded.' } } : {}) };
    }
    function videoCollection(id, title, tracks, degradedProviders = []) {
        const artworkItems = collageItems(tracks);
        return { kind: 'mix', id, title, videoPlaylist: true, artworkType: 'video-playlist', subtitle: `${tracks.length} videos`, count: tracks.length,
            tracks, thumbnail: tracks[0]?.thumbnail || '', artworkItems, artworkImages: artworkItems.map(item => item.thumbnail), author: 'Live catalog selection', degradedProviders };
    }
    function videoToken(ctx, style, focus, filters) {
        const values = [1, style, filters.genre || '', filters.mood || '', filters.decade || null, Boolean(filters.clean), filters.genre ? '' : focus, ctx.record.settings.country];
        return `videos:collection:${Buffer.from(JSON.stringify(values)).toString('base64url')}`;
    }
    function videoRequest(ctx, query, country, refresh = false) {
        return cached(`video-query:${country}:${ctx.day}:${hash(query)}`, () => safe('search', query, 'videos', { country }), refresh);
    }
    async function videoCollections(ctx, filters = {}, options = {}) {
        const focus = String(filters.genre || filters.mood || ctx.record.settings.preferredGenres[0] || ctx.tastes[0]?.name || 'Pop').slice(0, 100);
        const country = ctx.record.settings.country;
        const scoped = Boolean(filters.genre || filters.mood || filters.decade != null);
        const queries = [`${focus} music videos`, `${focus} new music videos`,
            scoped ? `classic ${focus} music videos` : 'classic country music',
            scoped ? `best ${focus} music videos` : 'classic hip hop'];
        const results = await Promise.all(queries.map(query => videoRequest(ctx, query, country, options.refresh)));
        const group = data => unique(data.items || [], 60).filter(item => allowed(item, ctx, { ...filters, queryRelevant: true }));
        const all = group(results[0]), current = group(results[1]).filter(isFresh);
        const fresh = videoCollection(videoToken(ctx, 'new', focus, filters), 'New Video Arrivals', current, results[1].degradedProviders);
        const classics = [videoCollection(videoToken(ctx, 'country', focus, filters), scoped ? `Classic ${focus} Videos` : 'Classic Country Videos', group(results[2]), results[2].degradedProviders),
            videoCollection(videoToken(ctx, 'hip hop', focus, filters), scoped ? `More ${focus} Videos` : 'Classic Hip-Hop Videos', group(results[3]), results[3].degradedProviders)];
        return { title: 'Videos', sections: [section('videos-featured', 'Featured', all.slice(0, 8), 'videos'),
            section('videos-new-playlists', 'New Video Playlists', current.length ? [fresh] : []),
            section('videos-new-music', 'New Music Videos', current, 'videos'),
            section('videos-classic-playlists', 'Classics Video Playlists', classics.filter(item => item.count)),
            section('videos-classics', 'Classics', unique(classics.flatMap(item => item.tracks), 40), 'videos')],
            degradedProviders: issuesOf(results), freshness: { generatedAt: new Date(now()).toISOString(), refreshAfterSeconds: 600 } };
    }
    async function recordIntent(user, type, value) {
        if (!user || typeof store.recordSignal !== 'function') return;
        try { await store.recordSignal(userIdOf(user), { type, ...value }); }
        catch (_) { /* Discovery telemetry must never block catalog access. */ }
    }
    async function search(query, type = 'all', user) {
        const q = String(query || '').trim().slice(0, 160);
        if (!['all', 'tracks', 'albums', 'artists', 'videos'].includes(type)) throw requestError('Unsupported search type.');
        const result = envelope(await catalogSlot(() => catalog.search(q, type)));
        if (q.length >= 2) await recordIntent(user, 'search', { query: q, kind: type });
        return result;
    }
    async function detail(kind, id, opts = {}) {
        const { user, ...catalogOptions } = opts || {};
        const result = await catalogSlot(() => catalog.detail(kind, id, catalogOptions));
        if (user && catalogOptions.name && ['album', 'artist', 'playlist'].includes(kind) && result?.title) {
            const signalType = `${kind}-open`;
            const item = { ...result, kind, id: result.id || id, title: result.title || catalogOptions.name,
                author: result.author || catalogOptions.artist || '',
                genres: [...new Set([...(result.genres || []), ...(result.tracks || []).flatMap(itemGenres)])].slice(0, 12),
                tracks: undefined, albums: undefined, artists: undefined, epsAndSingles: undefined, appearsOn: undefined, creditedTracks: undefined };
            await recordIntent(user, signalType, { item });
        }
        return result;
    }
    async function seedFor(value, ctx, data) {
        if (!value) return null;
        if (typeof value === 'object' && !Array.isArray(value)) return { ...value };
        const raw = String(value).trim().slice(0, 2000);
        if (raw.startsWith('{')) {
            try {
                const item = JSON.parse(raw);
                if (item && typeof item === 'object' && !Array.isArray(item) && (item.title || item.author)) return item;
            } catch (_) {}
        }
        const existing = [...ctx.liked, ...ctx.recent, ...ctx.record.collections.artists, ...data.tracks, ...data.artists]
            .find(x => x.id === raw || x.url === raw || norm(x.title) === norm(raw) || norm(x.author) === norm(raw));
        if (existing) return existing;
        const known = /^(?:deezer|itunes|musicbrainz):(artist|track):/.exec(raw);
        if (known) {
            const found = await safe('detail', known[1], raw);
            if (found.title) return found;
        }
        if (!/^https?:\/\//i.test(raw)) {
            const found = await safe('search', raw, 'tracks');
            if (found.items?.[0]) return found.items[0];
            return { title: raw, author: raw };
        }
        return null;
    }
    async function mix(user, id = 'daily-discovery', seed) {
        if (/^monthly-\d{4}-(?:0[1-9]|1[0-2])$/.test(id)) return (await stats(user, id.slice(8))).monthlyMix;
        const token = /^videos:collection:([A-Za-z\d_-]{1,800})$/.exec(id);
        const videos = /^videos:(new|classics):([^:\r\n]{1,100})$/.exec(id);
        if (token || videos) {
            const ctx = await context(user);
            let style, focus, country = ctx.record.settings.country, filters = {};
            if (token) {
                let values;
                try { values = JSON.parse(Buffer.from(token[1], 'base64url').toString('utf8')); } catch (_) { throw requestError('Invalid video collection.'); }
                if (!Array.isArray(values) || values.length !== 8 || values[0] !== 1 || !['new', 'country', 'hip hop'].includes(values[1])
                    || ![values[2], values[3], values[6]].every(value => typeof value === 'string' && value.length <= 100)
                    || values[3] && !MOODS.includes(values[3]) || values[4] != null && (!Number.isInteger(values[4]) || values[4] < 1900 || values[4] > 2090 || values[4] % 10)
                    || typeof values[5] !== 'boolean' || !/^[A-Z]{2}$/.test(values[7])) throw requestError('Invalid video collection.');
                [, style, filters.genre, filters.mood, filters.decade, filters.clean, focus, country] = values;
                focus = filters.genre || focus || 'Pop';
            } else {
                // Old collection IDs stored a provider search query, never a
                // selected genre filter. Preserve their original membership.
                style = videos[1] === 'new' ? 'new' : videos[2]; focus = videos[2];
                if (!['new', 'country', 'hip hop'].includes(style)) throw requestError('Unknown video collection.');
            }
            const scoped = Boolean(filters.genre || filters.mood || filters.decade != null);
            const query = style === 'new' ? `${focus} new music videos`
                : style === 'country' ? scoped ? `classic ${focus} music videos` : 'classic country music'
                    : scoped ? `best ${focus} music videos` : 'classic hip hop';
            const data = await videoRequest(ctx, query, country);
            const tracks = unique(data.items || [], 60).filter(item => allowed(item, ctx, { ...filters, queryRelevant: true }) && (style !== 'new' || isFresh(item)));
            const title = style === 'new' ? 'New Video Arrivals' : scoped ? `${style === 'country' ? 'Classic' : 'More'} ${focus} Videos`
                : style === 'country' ? 'Classic Country Videos' : 'Classic Hip-Hop Videos';
            return videoCollection(id, title, tracks, data.degradedProviders);
        }
        const radioId = /^radio:(?:track|artist):[a-f\d]{12}$/.test(id) ? id : '';
        if (radioId) id = 'radio';
        if (!['daily-discovery', 'new-arrivals', 'radio', ...Array.from({ length: MIX_REQUIREMENTS.length }, (_, n) => `mix-${n + 1}`)].includes(id)) throw requestError('Unknown mix.');
        const ctx = await context(user), data = await discovery(ctx, { fullProfile: true }), selectedSeed = await seedFor(seed, ctx, data);
        if (id === 'radio' && selectedSeed) {
            const seedArtistId = selectedSeed.artistId || (selectedSeed.kind === 'artist' ? selectedSeed.id : '');
            const recommendationKey = hash([ctx.record.settings.country, seedArtistId || '', norm(selectedSeed.author || selectedSeed.title)]).slice(0, 24);
            const extra = await cached(`profile-radio:${recommendationKey}`, () => safe('recommendations', {
                artistId: seedArtistId, artist: selectedSeed.author || selectedSeed.title,
                query: selectedSeed.author || selectedSeed.title, country: ctx.record.settings.country,
            }), false, 30 * 60_000);
            const endpoint = String(extra.provenance?.endpoint || '');
            const verifiedRadio = Boolean(seedArtistId && extra.recommendationSource === 'provider-artist-radio'
                && extra.seedArtistId === seedArtistId && new RegExp(`^/artist/${String(seedArtistId).split(':').at(-1)}/radio(?:\\?|$)`).test(endpoint));
            const radioTracks = verifiedRadio ? (extra.items || []).filter(item => item.seedArtistId === seedArtistId && item.artistId === seedArtistId) : [];
            const fused = mergeCandidatePools([
                { channel: 'verified-provider-radio', weight: 0.92, items: radioTracks },
                { channel: 'existing-discovery-pool', weight: 0.65, items: data.tracks },
            ], { limit: 5000 });
            for (const [key, value] of fused.evidence) {
                const previous = ctx.candidateEvidence?.get(key);
                if (previous) value.rrfScore += previous.rrfScore;
                fused.evidence.set(key, { ...previous, ...value,
                    rrfScore: value.rrfScore,
                    channelCount: (previous?.channelCount || 0) + value.channelCount,
                    channels: [...(previous?.channels || []), ...value.channels],
                    profileGenres: [...new Set([...(previous?.profileGenres || []), ...(value.profileGenres || [])])],
                });
            }
            data.tracks = fused.items;
            ctx.candidateEvidence = fused.evidence;
            data.degradedProviders = issuesOf([data, extra]);
        }
        const result = buildMix(ctx, data, id, selectedSeed);
        return radioId ? { ...result, id: radioId } : result;
    }
    async function autoplayNext(user, seed, { exclude = [] } = {}) {
        const ctx = await context(user);
        if (ctx.record.settings.autoplay === false) return { enabled: false, track: null, reason: 'Autoplay is disabled in your account settings.', degradedProviders: [] };
        const radio = await mix(user, 'radio', seed), blocked = new Set();
        const recent = recentTracks(ctx).slice(0, 10);
        const exclusions = [...(Array.isArray(exclude) ? exclude.slice(0, 500) : []), ...recent, ...(seed && typeof seed === 'object' ? [seed] : [])];
        for (const item of exclusions) {
            if (typeof item === 'string') { blocked.add(item); blocked.add(canonicalTrackKey(item)); }
            else if (item) { if (item.id) blocked.add(item.id); blocked.add(canonicalTrackKey(item)); blocked.add(titleKey(item)); }
        }
        if (typeof seed === 'string') {
            blocked.add(seed);
            if (seed.startsWith('{')) {
                try { const item = JSON.parse(seed); blocked.add(itemKey(item)); blocked.add(canonicalTrackKey(item)); blocked.add(titleKey(item)); } catch (_) {}
            }
        }
        const track = radio.tracks.find(item => !blocked.has(item.id) && !blocked.has(canonicalTrackKey(item)) && !blocked.has(titleKey(item))) || null;
        return { enabled: true, track, ...(track ? {} : { reason: 'No eligible related tracks are currently available.' }), degradedProviders: radio.degradedProviders || [] };
    }
    async function library(user, kind = 'tracks') {
        const userId = userIdOf(user), preferences = (await store.read(userId, { eventLimit: 0 })).settings;
        if (kind === 'tracks') return { kind, preferences, items: (await favorites.list(userId)).map(x => ({ ...x, kind: 'track' })) };
        if (kind === 'playlists') return { kind, preferences, items: (await playlists.list(userId)).map(x => ({ ...x, kind: 'playlist', title: x.name, author: 'Your playlist' })) };
        if (!['albums', 'artists', 'videos', 'mixes', 'uploads', 'profiles', 'purchases', 'downloads'].includes(kind)) throw requestError('Unsupported library collection.');
        const items = await store.list(userId, kind);
        return { kind, preferences, items, ...(kind === 'purchases' ? { description: 'Your imported external purchases. There is no checkout in this player.' } : {}) };
    }
    async function stats(user, month) {
        const summary = await store.stats(user, month);
        const tracks = summary.topTracks.map(({ plays, seconds, lastPlayedAt, ...track }) => ({ ...track, reason: `Played ${plays} ${plays === 1 ? 'time' : 'times'} in ${monthName(summary.month)}` }));
        return { ...summary, monthlyMix: { kind: 'mix', id: `monthly-${summary.month}`, title: `Your ${monthName(summary.month)}`,
            subtitle: `${summary.totalPlays} plays · ${Math.floor(summary.totalSeconds / 60)} minutes of recorded listening`, thumbnail: tracks[0]?.thumbnail || '', tracks,
            reasons: ['Ranked by your actual listening events for this month'] } };
    }
    async function feed(user) {
        const ctx = await context(user), current = new Date(now());
        const previousMonth = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
        let summary = await stats(user, previousMonth);
        if (!summary.totalPlays) summary = await stats(user);
        const followed = await Promise.all(ctx.record.collections.artists.slice(0, 6).map(artist => safe('artistReleases', artist)));
        const items = unique(followed.flatMap(x => x.items || x.albums || []).filter(x => {
            const date = Date.parse(x.releaseDate || '');
            return Number.isFinite(date) && date <= now() && now() - date <= 120 * DAY && allowed(x, ctx);
        })).sort((a, b) => String(b.releaseDate).localeCompare(String(a.releaseDate))).map(x => ({ ...x, reason: `A recent release from an artist you follow` }));
        return { title: 'Your feed', sections: [section('monthly-listening', 'Your monthly listening', summary.totalPlays ? [summary.monthlyMix] : []),
            section('followed-releases', 'New from artists you follow', items, 'cards', ctx.record.collections.artists.length ? 'Recent provider releases' : 'Follow artists to see their new releases here')],
            stats: summary, degradedProviders: issuesOf(followed), freshness: { generatedAt: new Date(now()).toISOString() } };
    }
    async function persistFavorites(userId) {
        if (typeof favorites.saveNow === 'function' && favorites.saveNow(userId) === false) throw new Error('Your favorite could not be saved. Retry shortly.');
        else if (typeof favorites.flushAll === 'function') await favorites.flushAll();
    }
    async function editLibrary(user, body = {}) {
        const userId = userIdOf(user), operation = String(body.operation || ''), rawKind = String(body.kind || body.item?.kind || '');
        if (operation === 'removeDownload') return { ok: true, ...await store.removeDownload(userId, body.id || body.item?.id) };
        const kind = rawKind === 'mixes' ? 'mix' : rawKind.replace(/s$/, '');
        if (!['save', 'unsave', 'follow', 'unfollow', 'feedback', 'settings'].includes(operation)) throw requestError('Unsupported library operation.');
        if (operation === 'settings') return { ok: true, settings: await store.setSettings(userId, body.value || body.settings || {}) };
        if (operation === 'feedback') {
            const value = typeof body.value === 'boolean' ? body.value ? 'like' : 'dislike' : body.value;
            return { ok: true, feedback: await store.setFeedback(userId, body.item, value, body.reason) };
        }
        if ((operation === 'follow' || operation === 'unfollow') && kind !== 'artist') throw requestError('Only artists can be followed.');
        if (!body.item || typeof body.item !== 'object') throw requestError('A library item is required.');
        if (kind === 'track') {
            if (operation === 'save') {
                const result = favorites.add(userId, body.item);
                if (!result?.ok) throw requestError('The track could not be added to favorites.');
                await persistFavorites(userId);
                return { ...result, ok: true, saved: true };
            }
            if (operation !== 'unsave') throw requestError('Unsupported track operation.');
            const items = favorites.list(userId), key = canonicalTrackKey(body.item);
            const index = items.findIndex(x => canonicalTrackKey(x) === key || titleKey(x) === titleKey(body.item));
            if (index >= 0) favorites.remove(userId, index);
            await persistFavorites(userId);
            return { ok: true, saved: false, removed: index >= 0 };
        }
        if (kind === 'playlist') {
            const identifier = String(body.item.id || '').slice(0, 220);
            if (!identifier) throw requestError('A playlist identifier is required.');
            const lists = await playlists.list(userId);
            const existing = lists.find(item => item.id === identifier || item.sourceId === identifier);
            if (operation === 'unsave') {
                if (existing) await playlists.delete(userId, existing.id);
                return { ok: true, saved: false, removed: Boolean(existing) };
            }
            if (existing) return { ok: true, item: await playlists.get(userId, existing.id), saved: true };
            if (!/^[a-z][a-z\d_-]{1,39}:playlist:[^\s]{1,160}$/i.test(identifier)) throw requestError('Playlist not found.');
            const value = Array.isArray(body.item.tracks) ? body.item : { ...body.item, ...await catalog.detail('playlist', identifier) };
            if (!Array.isArray(value.tracks)) throw requestError('This playlist has no available tracklist.');
            const item = await playlists.create(userId, value.title || value.name, { sourceId: identifier,
                sourceProviderUrl: value.providerUrl || value.url, tracks: value.tracks.slice(0, 10000) });
            return { ok: true, item, saved: true, ...(value.tracksReport ? { sourceReport: value.tracksReport } : {}),
                ...((value.partial || value.truncated || value.tracks.length > 10000) ? { partial: true, truncated: Boolean(value.truncated || value.tracks.length > 10000) } : {}) };
        }
        if (!['album', 'artist', 'video', 'mix', 'profile', 'upload', 'purchase'].includes(kind)) throw requestError('Unsupported library collection.');
        if (operation === 'unsave' || operation === 'unfollow') return { ok: true, ...await store.remove(userId, kind, body.item), saved: false, followed: false };
        const value = kind === 'mix' && !Array.isArray(body.item.tracks)
            ? { ...body.item, ...await mix(userId, body.item.id, body.item.seed) } : body.item;
        const item = await store.save(userId, kind, { ...value, kind: value.kind || kind });
        return { ok: true, item, saved: true, ...(kind === 'artist' ? { followed: true } : {}) };
    }
    return { home, explore, search, detail, recordingCredits, mix, autoplayNext, library, stats, feed, editLibrary,
        settings: async user => ({ settings: (await store.read(user, { eventLimit: 0 })).settings }),
        recordPlay: (user, track, details = {}) => store.recordPlay(user, track, details),
        updatePlay: (user, eventId, details = {}) => store.updatePlay(user, eventId, details),
        recordSignal: (user, value) => store.recordSignal(user, value),
        recordDownload: (user, track, details = {}) => store.recordDownload(user, track, details),
        clearCache: () => { discoveryCache.clear(); enrichedProfileCache.clear(); recordingCredits.clearCache(); catalog.clearCache?.(); },
    };
}

module.exports = createPlatformService();
module.exports.createPlatformService = createPlatformService;
