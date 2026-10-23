'use strict';

const params = new URLSearchParams(location.search);
const urlToken = params.get('token') || '';
if (urlToken) sessionStorage.setItem('musicSessionToken', urlToken);
const token = urlToken || sessionStorage.getItem('musicSessionToken') || '';
let view = params.get('view') || 'player';
let state = null;
let stateRevision = 0;
let stateActionSeq = 0;
let pendingActionSeq = 0;
let lyrics = null;
let collection = [];
let collectionKind = '';
let syncAdjust = 0;
let lyricsFollowEnabled = true;
let songSyncAdjustments = {};
try { songSyncAdjustments = JSON.parse(localStorage.getItem('lyricsAdvanceByTrack') || '{}'); } catch (_) {}
let motionArtworkEnabled = true;
let artworkHls = null;
let motionExhaustedKey = '';
let statePerfAt = performance.now();
let fetchBusy = false;
const lyricsRequests = new Map();
let lyricsLoadSeq = 0;
let lyricsRetryTimer = null;
let lyricsRetryCount = 0;
let currentTrackKey = '';
let lyricsTrackKey = '';
let lyricsAudioJob = '';
let lastLine = -1;
let selectedIndexes = new Set();
let catalogType = 'tracks';
let catalogMode = 'search';
let catalogDetail = null;
let catalogRequest = 0;
let playlists = [];
let playlistDialogMode = '';
let playlistDialogTrack = null;
let playlistDialogId = '';
let seekWidth = 0;
let lastDisplayedSecond = -1;
let seekPreview = null;
const FALLBACK_ART = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="2" d="M-50 430C80 270 140 500 300 285S490 280 565 120M-60 295C105 185 166 385 306 176S490 122 565 48"/><circle cx="256" cy="256" r="165" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="2"/><circle cx="256" cy="256" r="144" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="1"/><text x="256" y="285" text-anchor="middle" fill="#fff" fill-opacity=".86" font-family="Arial,sans-serif" font-size="85" font-weight="700" letter-spacing="-7">! A</text></svg>`);

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const els = {
  stage: $('#stage'), cover: $('#cover'), coverVideo: $('#coverVideo'), miniCover: $('#miniCover'),
  miniTitle: $('#miniTitle'), miniArtist: $('#miniArtist'),
  elapsed: $('#elapsed'), duration: $('#duration'), seek: $('#seek'), seekFill: $('#seekFill'), seekKnob: $('#seekKnob'),
  playPause: $('#playPause'), pauseIcon: $('#pauseIcon'), loopButton: $('#loopButton'), loopMode: $('#loopMode'),
  lyricsPane: $('#lyricsPane'), lyricsScroller: $('#lyricsScroller'), lyricsSyncBadge: $('#lyricsSyncBadge'),
  collectionPane: $('#collectionPane'), collectionList: $('#collectionList'), collectionTitle: $('#collectionTitle'),
  collectionEyebrow: $('#collectionEyebrow'), selectedCount: $('#selectedCount'), volume: $('#volume'),
  toast: $('#toast'), more: $('#morePanel'), favCount: $('#favCount'), historyCount: $('#historyCount'),
  lyricsAdvance: $('#lyricsAdvance'), lyricsAdvanceValue: $('#lyricsAdvanceValue'), downloadDialog: $('#downloadDialog'),
  downloadUrl: $('#downloadUrl'), downloadStatus: $('#downloadStatus'), downloadSubmit: $('#downloadSubmit'),
  downloadProgress: $('#downloadProgress'), coverMotion: $('#coverMotion'), searchInput: $('#searchInput'),
  catalogPane: $('#catalogPane'), catalogList: $('#catalogList'), catalogTitle: $('#catalogTitle'),
  catalogDescription: $('#catalogDescription'), catalogEyebrow: $('#catalogEyebrow'),
  catalogTabs: $('#catalogTabs'), catalogActions: $('#catalogActions'), catalogBack: $('#catalogBack'),
  playlistDialog: $('#playlistDialog'), playlistName: $('#playlistName'), playlistSelect: $('#playlistSelect'),
  confirmDialog: $('#confirmDialog')
};

async function api(path, opt = {}) {
  const timeoutMs = Math.max(1500, Number(opt.timeoutMs ?? (path.startsWith('/api/download') ? 15 * 60_000 : path === '/api/state' ? 8000 : 60_000)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const { timeoutMs: _ignoredTimeout, ...fetchOptions } = opt;
  try {
    const r = await fetch(path, {
      ...fetchOptions, signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Music-Session': token, ...(opt.headers || {}) },
      cache: 'no-store', credentials: 'same-origin'
    });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) {
      let message = `Request failed (${r.status})`;
      try { message = ct.includes('json') ? (await r.json()).error || message : await r.text() || message; } catch (_) {}
      throw new Error(message);
    }
    return ct.includes('json') ? await r.json() : r;
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('Connection timed out. Retrying…');
    throw err;
  } finally { clearTimeout(timer); }
}

function fmt(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function toast(message) {
  els.toast.textContent = String(message || '');
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { els.toast.hidden = true; }, 2500);
}

function applyPalette(input) {
  const fallback = ['#171a22', '#2b3444', '#657085', '#090b10', '#1b202b', '#3f526b'];
  const p = Array.isArray(input) ? input.filter(Boolean) : [];
  for (let i = 0; i < 6; i++) {
    const name = `--c${i + 1}`;
    const color = p[i] || p[i % Math.max(1, p.length)] || fallback[i];
    if (document.documentElement.style.getPropertyValue(name) !== color) document.documentElement.style.setProperty(name, color);
  }
}

function elapsedNow() {
  const browserClock = window.MusicPlatform?.getBrowserClock();
  if (browserClock) return Math.max(0, Number(browserClock.elapsed || 0));
  if (!state?.track) return 0;
  if (state.paused || !state.playing) return Math.max(0, Number(state.elapsed || 0));
  return Math.max(0, Number(state.elapsed || 0) + (performance.now() - statePerfAt) / 1000 + Number(state.clientLatencyMs || 0) / 1000);
}

function setImage(img, src) {
  const value = String(src || '');
  if (img.dataset.requestedArt === value && !img.dataset.artSources) return;
  delete img.dataset.artSources;
  delete img.dataset.artIndex;
  img.dataset.requestedArt = value;
  img.classList.toggle('no-art', !value);
  img.src = value || FALLBACK_ART;
}

function setImageSources(img, sources) {
  const list = [...new Set((Array.isArray(sources) ? sources : []).map(x => String(x || '').trim()).filter(Boolean))].slice(0, 19);
  const signature = list.join('\n');
  if (img.dataset.artSources === signature) return;
  img.dataset.artSources = signature;
  img.dataset.artIndex = '0';
  img.dataset.requestedArt = list[0] || '';
  img.classList.toggle('no-art', !list.length);
  img.src = list[0] || FALLBACK_ART;
}

function imageFailed(img) {
  const list = String(img.dataset.artSources || '').split('\n').filter(Boolean);
  if (list.length) {
    const nextIndex = Number(img.dataset.artIndex || 0) + 1;
    if (nextIndex < list.length) {
      img.dataset.artIndex = String(nextIndex);
      img.dataset.requestedArt = list[nextIndex];
      img.classList.remove('no-art');
      img.src = list[nextIndex];
      return;
    }
  }
  if (img.src === FALLBACK_ART) return;
  img.classList.add('no-art');
  img.src = FALLBACK_ART;
}

function stopAnimatedCover() {
  const video = els.coverVideo;
  if (!video) return;
  if (artworkHls) { artworkHls.destroy(); artworkHls = null; }
  video.pause();
  video.removeAttribute('src');
  video.removeAttribute('poster');
  delete video.dataset.motionSources;
  delete video.dataset.motionIndex;
  delete video.dataset.motionKey;
  delete video.dataset.motionExpectedSrc;
  delete video.dataset.motionVariants;
  delete video.dataset.motionHls;
  try { video.load(); } catch (_) {}
  els.coverMotion?.classList.remove('motion-ready', 'motion-loading');
}

function tryAnimatedSource(index = 0) {
  const video = els.coverVideo;
  if (!video) return;
  const list = String(video.dataset.motionSources || '').split('\n').filter(Boolean);
  if (!list.length || index >= list.length) { motionExhaustedKey = video.dataset.motionKey || ''; stopAnimatedCover(); return; }
  if (artworkHls) { artworkHls.destroy(); artworkHls = null; }
  delete video.dataset.motionHls;
  const src = list[index];
  video.dataset.motionIndex = String(index);
  video.dataset.motionExpectedSrc = src;
  els.coverMotion?.classList.remove('motion-ready');
  els.coverMotion?.classList.add('motion-loading');
  try { video.pause(); } catch (_) {}
  let variants = [];
  try { variants = JSON.parse(video.dataset.motionVariants || '[]'); } catch (_) {}
  const variant = variants.find(item => item.url === src) || {};
  const isHls = /mpegurl|hls/i.test(`${variant.mime || ''} ${variant.format || ''}`) || /\.m3u8(?:$|\?)/i.test(src);
  if (isHls && window.Hls?.isSupported()) {
    const motionKey = video.dataset.motionKey;
    video.dataset.motionHls = src;
    const hls = artworkHls = new window.Hls({ enableWorker: false, autoStartLoad: false, capLevelToPlayerSize: false, capLevelOnFPSDrop: false, maxBufferLength: 18, maxMaxBufferLength: 30, backBufferLength: 0 });
    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (data.fatal && artworkHls === hls && video.dataset.motionKey === motionKey) tryAnimatedSource(index + 1);
    });
    hls.on(window.Hls.Events.MEDIA_ATTACHED, () => { if (artworkHls === hls && video.dataset.motionKey === motionKey) hls.loadSource(src); });
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      if (artworkHls !== hls || video.dataset.motionKey !== motionKey) return;
      // HLS.js filters unsupported codecs while parsing. Keep the best remaining
      // rendition instead of choosing an initial level from bandwidth or cover size.
      let highest = -1;
      for (let level = 0; level < hls.levels.length; level++) {
        const candidate = hls.levels[level], previous = hls.levels[highest];
        const pixels = Number(candidate.width || 0) * Number(candidate.height || 0);
        const previousPixels = Number(previous?.width || 0) * Number(previous?.height || 0);
        if (highest < 0 || pixels > previousPixels || pixels === previousPixels && Number(candidate.bitrate || 0) > Number(previous?.bitrate || 0)) highest = level;
      }
      if (highest >= 0) { hls.startLevel = highest; hls.currentLevel = highest; }
      hls.startLoad();
    });
    hls.attachMedia(video);
  } else if (isHls && !video.canPlayType('application/vnd.apple.mpegurl')) return tryAnimatedSource(index + 1);
  else video.src = src;
  const poster = String(state?.track?.thumbnail || '');
  if (poster) video.poster = poster;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';
  if (!video.dataset.motionHls) try { video.load(); } catch (_) {}
  const play = () => video.play().catch(() => {});
  if (!document.hidden) void play();
}

function normalizedMediaUrl(value) {
  try { return new URL(String(value || ''), window.location.href).href; } catch (_) { return String(value || ''); }
}

function currentMotionKey(track) {
  const list = [...new Set([
    ...(Array.isArray(track?.animatedArtworkSources) ? track.animatedArtworkSources.map(item => item.url) : []),
    track?.animatedArtwork,
    ...(Array.isArray(track?.animatedArtworkFallbacks) ? track.animatedArtworkFallbacks : [])
  ].map(x => String(x || '').trim()).filter(Boolean))].slice(0, 8);
  return { list, key: `${track?.url || ''}|${list.join('|')}`, variants: track?.animatedArtworkSources || [] };
}

function isCurrentMotionEvent(video) {
  if (!video) return false;
  const expectedSrc = normalizedMediaUrl(video.dataset.motionExpectedSrc || '');
  const actualSrc = normalizedMediaUrl(video.currentSrc || video.src || '');
  if (expectedSrc && actualSrc && expectedSrc !== actualSrc && normalizedMediaUrl(video.dataset.motionHls || '') !== expectedSrc) return false;
  const expectedState = currentMotionKey(state?.track);
  return Boolean(video.dataset.motionKey && video.dataset.motionKey === expectedState.key);
}

function setAnimatedCover(track) {
  const video = els.coverVideo;
  if (!video) return;
  if (!motionArtworkEnabled) { if (video.dataset.motionKey) stopAnimatedCover(); return; }
  const motionState = currentMotionKey(track);
  const list = motionState.list;
  const key = motionState.key;
  if (key === motionExhaustedKey) return;
  if (!list.length) {
    if (video.dataset.motionKey) stopAnimatedCover();
    return;
  }
  if (video.dataset.motionKey === key) {
    if (video.paused && !document.hidden) void video.play().catch(() => {});
    return;
  }
  video.dataset.motionKey = key;
  video.dataset.motionSources = list.join('\n');
  video.dataset.motionVariants = JSON.stringify(motionState.variants);
  video.dataset.motionIndex = '0';
  tryAnimatedSource(0);
}


function renderPlayIcon() {
  if (!state) return;
  els.pauseIcon.innerHTML = state.paused || !state.playing
    ? '<path d="M8 5l11 7-11 7z"/>'
    : '<path d="M8 5h3v14H8zM13 5h3v14h-3z"/>';
}

function renderControlState() {
  const shuffle = $('[data-action="shuffle"]');
  shuffle?.classList.toggle('is-active', Boolean(state?.shuffle));
  els.loopButton?.classList.toggle('is-active', Boolean(state?.loop || state?.loopQueue));
  if (els.loopMode) els.loopMode.textContent = state?.loop ? '1' : state?.loopQueue ? '∞' : '';
  const fav = $('.favorite-control');
  fav?.classList.toggle('is-active', Boolean(state?.favorited));
  fav?.setAttribute('aria-pressed', String(Boolean(state?.favorited)));
}

function renderAdvance() {
  const base = Number(state?.lyricsAdvanceMs || 0);
  const total = base + syncAdjust;
  els.lyricsAdvance.value = String(syncAdjust);
  els.lyricsAdvanceValue.textContent = `${total >= 0 ? '+' : ''}${(total / 1000).toFixed(2)}s`;
  const mode = lyrics?.timingMode || (lyrics?.estimatedSync ? 'estimated' : lyrics?.approximateSync ? 'adaptive' : lyrics?.syncedLines?.length ? 'synced' : 'plain');
  const label = { synced: 'Synced', estimated: 'Estimated follow', adaptive: 'Approximate follow', plain: 'Lyrics' }[mode] || 'Lyrics';
  els.lyricsPane.querySelector('.eyebrow').textContent = mode === 'synced' ? 'SYNCED LYRICS' : 'LYRICS';
  const wordMode = lyrics?.wordTimingMode;
  const wordLabel = mode === 'plain' ? '' : wordMode === 'provider' ? ' · Word cues' : wordMode === 'mixed' ? ' · Some word cues' : ' · Est. word fill';
  els.lyricsSyncBadge.textContent = `${label}${wordLabel}${lyrics?.romanizationStatus === 'partial' ? ' · Partial reading' : ''}${syncAdjust ? ` · ${syncAdjust > 0 ? '+' : ''}${(syncAdjust / 1000).toFixed(2)}s` : ''}`;
  els.lyricsSyncBadge.title = 'Word cues use source timestamps when available. Other word timings and the fill within each word are estimated; line sync and your adjustment stay the same.';
}

function renderState(next) {
  // Polls and control responses travel independently. A late response must not
  // switch the cover, lyrics and playback clock back to an older server snapshot.
  if (state && Number(next.serverNow || 0) > 0 && Number(next.serverNow) < Number(state.serverNow || 0)) return;
  next = window.MusicPlatform?.adaptPlayerState(next) || next;
  const oldKey = currentTrackKey;
  if (state && state.track?.url === next.track?.url && Number(state.playToken || 0) === Number(next.playToken || 0) && state.playing && next.playing && !next.paused) {
    const discrepancy = Number(next.elapsed || 0) + Number(next.clientLatencyMs || 0) / 1000 - elapsedNow();
    if (Math.abs(discrepancy) < 1.1) {
      next.elapsed = elapsedNow() + Math.max(-.14, Math.min(.14, discrepancy));
      next.clientLatencyMs = 0;
    }
  }
  state = next;
  stateRevision++;
  if (seekPointer == null) seekPreview = null;
  statePerfAt = performance.now();
  applyPalette(next.palette);
  const track = next.track;
  const oldLyricsAudioJob = lyricsAudioJob;
  lyricsAudioJob = window.MusicPlatform?.getLyricsAudioId() || '';
  currentTrackKey = track ? `${track.url || ''}|${track.title || ''}` : '';
  if (oldKey !== currentTrackKey || oldLyricsAudioJob !== lyricsAudioJob) {
    lyricsLoadSeq++;
    if (lyricsRetryTimer) { clearTimeout(lyricsRetryTimer); lyricsRetryTimer = null; }
    lyricsRetryCount = 0;
    lyrics = null; lyricsTrackKey = ''; lastLine = -1;
    syncAdjust = Number(songSyncAdjustments[currentTrackKey] || 0);
    lastDisplayedSecond = -1;
    resetLyricsView(Boolean(currentTrackKey));
    if (currentTrackKey) void loadLyrics(true); // new track gets its own request immediately; old requests cannot block it
  }
  const title = track?.title || 'Nothing playing';
  const artist = track?.author || 'Join voice and start a track from Discord';
  els.seek.classList.toggle('has-track', Number(track?.duration || 0) > 0);
  if (els.miniTitle.textContent !== title) els.miniTitle.textContent = title;
  if (els.miniArtist.textContent !== artist) els.miniArtist.textContent = artist;
  const duration = Number(track?.duration || 0);
  const durationLabel = duration > 0 ? fmt(duration) : 'LIVE';
  if (els.duration.textContent !== durationLabel) els.duration.textContent = durationLabel;
  const artSources = track ? [track.thumbnail, ...(Array.isArray(track.artworkFallbacks) ? track.artworkFallbacks : [])].filter(Boolean) : [];
  if (window.MusicPlatform?.watchArtwork) {
    window.MusicPlatform.watchArtwork(els.cover, track, {listen:false,eager:true});
    window.MusicPlatform.watchArtwork(els.miniCover, track, {listen:false,eager:true});
  } else { setImageSources(els.cover, artSources); setImageSources(els.miniCover, artSources); }
  setAnimatedCover(track);
  els.volume.value = String(next.volume || 90);
  els.favCount.textContent = next.counts?.favorites || 0;
  els.historyCount.textContent = next.counts?.history || 0;
  renderPlayIcon(); renderControlState(); renderAdvance();
  window.dispatchEvent(new CustomEvent('music:state', { detail: next }));
}

function renderFrame(now) {
  if (state) {
    const elapsed = seekPreview == null ? elapsedNow() : Math.max(0, Number(seekPreview) || 0);
    const duration = Number(state.track?.duration || 0);
    const progress = duration > 0 ? Math.max(0, Math.min(1, elapsed / duration)) : 0;
    const wholeSecond = Math.floor(elapsed);
    if (wholeSecond !== lastDisplayedSecond) { els.elapsed.textContent = fmt(elapsed); lastDisplayedSecond = wholeSecond; }
    els.seekFill.style.transform = `scaleX(${progress})`;
    els.seekKnob.style.transform = `translate3d(${progress * seekWidth - 5}px,0,0)`;
    const percent = String(Math.round(progress * 100));
    if (els.seek.getAttribute('aria-valuenow') !== percent) els.seek.setAttribute('aria-valuenow', percent);
    if (view === 'lyrics') updateLyrics(elapsed + (Number(state.lyricsAdvanceMs || 0) + syncAdjust) / 1000);
  }
  animateCoverFrame(now);
  requestAnimationFrame(renderFrame);
}

async function refreshState() {
  if (fetchBusy || pendingActionSeq || document.hidden) return;
  fetchBusy = true;
  const revision = stateRevision;
  const actionSeq = stateActionSeq;
  const started = performance.now();
  try {
    const next = await api('/api/state');
    if (revision !== stateRevision || actionSeq !== stateActionSeq || pendingActionSeq) return;
    next.clientLatencyMs = Math.max(0, (performance.now() - started) / 2);
    renderState(next);
    refreshState.lastErrorAt = 0;
  } catch (err) {
    // Do not flood mobile users with a toast every second during a brief Wi-Fi/4G handoff.
    if (!refreshState.lastErrorAt || Date.now() - refreshState.lastErrorAt > 6000) {
      toast(err.message); refreshState.lastErrorAt = Date.now();
    }
  } finally { fetchBusy = false; }
}

async function act(name, value) {
  if (window.MusicPlatform?.handlesPlayback(name)) return window.MusicPlatform.playbackAction(name, value);
  const actionSeq = ++stateActionSeq;
  pendingActionSeq = actionSeq;
  const revision = stateRevision;
  const snapshot = state ? { ...state } : null;
  if (state && name === 'pause') {
    state = { ...state, paused: !state.paused, playing: true, elapsed: elapsedNow(), clientLatencyMs: 0 };
    statePerfAt = performance.now(); renderPlayIcon();
  } else if (state && name === 'seekTo' && Number.isFinite(Number(value))) {
    state = { ...state, elapsed: Math.max(0, Number(value)), clientLatencyMs: 0 }; statePerfAt = performance.now();
  }
  try {
    const next = await api('/api/action', { method: 'POST', body: JSON.stringify({ action: name, value }) });
    if (actionSeq !== stateActionSeq) return;
    renderState(next);
    if (name === 'favorite') toast(next.favorited ? 'Added to Library' : 'Removed from Library');
  } catch (err) {
    if (actionSeq !== stateActionSeq) return;
    if (snapshot && revision === stateRevision) renderState(snapshot);
    toast(err.message);
  } finally { if (pendingActionSeq === actionSeq) pendingActionSeq = 0; }
}

async function setView(next, native = false) {
  if (!native && window.MusicPlatform) return window.MusicPlatform.navigateLegacy(next);
  const valid = ['player', 'lyrics', 'library', 'history', 'discover', 'search', 'playlists', 'queue'];
  if (!valid.includes(next)) next = 'player';
  view = next;
  $$('.view-pill').forEach(x => x.classList.toggle('active', x.dataset.view === next));
  $$('.side-link').forEach(x => x.classList.toggle('active', x.dataset.view === next));
  const isCatalog = ['search', 'playlists'].includes(next);
  els.stage.className = `stage ${next === 'lyrics' ? 'lyrics-view' : ['library', 'history', 'discover', 'queue'].includes(next) ? 'collection-view' : isCatalog ? 'catalog-view' : 'player-view'}`;
  els.lyricsPane.hidden = next !== 'lyrics';
  els.collectionPane.hidden = !['library', 'history', 'discover', 'queue'].includes(next);
  els.catalogPane.hidden = !isCatalog;
  if (!window.MusicPlatform) try { history.replaceState(null, '', `/player?view=${encodeURIComponent(next)}`); } catch (_) {}
  els.more.hidden = true;
  if (next === 'lyrics') await loadLyrics();
  if (['library', 'history', 'discover', 'queue'].includes(next)) await loadCollection(next === 'library' ? 'favorites' : next);
  if (next === 'search') await loadSearch();
  if (next === 'playlists') await showPlaylists();
}

function resetLyricsView(loading = false) {
  els.lyricsScroller.replaceChildren();
  els.lyricsScroller.dataset.y = '0';
  els.lyricsScroller.style.transform = 'translate3d(0,0,0)';
  lastLine = -1;
  if (loading && view === 'lyrics') {
    const node = document.createElement('div');
    node.className = 'lyric-line near';
    node.textContent = 'Loading lyrics…';
    els.lyricsScroller.append(node);
  }
}

function scheduleLyricsRetry(requestedKey) {
  if (requestedKey !== currentTrackKey || !requestedKey) return;
  if (lyricsRetryTimer) clearTimeout(lyricsRetryTimer);
  const delays = [12000, 22000, 45000, 60000];
  const delay = delays[Math.min(lyricsRetryCount, delays.length - 1)];
  lyricsRetryCount++;
  lyricsRetryTimer = setTimeout(() => {
    lyricsRetryTimer = null;
    if (requestedKey === currentTrackKey) void loadLyrics(true);
  }, delay);
}

async function loadLyrics(force = false) {
  if (!currentTrackKey) { resetLyricsView(false); return; }
  if (!force && lyrics && lyricsTrackKey === currentTrackKey) { renderLyrics(); return; }
  const requestedKey = currentTrackKey;
  const audioId = lyricsAudioJob;
  const requestKey = audioId ? `${requestedKey}|audio:${audioId}` : requestedKey;
  const seq = ++lyricsLoadSeq;
  if (view === 'lyrics' && lyricsTrackKey !== requestedKey) resetLyricsView(true);

  let request = lyricsRequests.get(requestKey);
  if (!request) {
    request = (audioId ? api(`/api/lyrics?audioId=${encodeURIComponent(audioId)}&track=${encodeURIComponent(requestedKey)}${force ? '&refresh=1' : ''}`) : api(`/api/lyrics?track=${encodeURIComponent(requestedKey)}${force ? '&refresh=1' : ''}`))
      .finally(() => { if (lyricsRequests.get(requestKey) === request) lyricsRequests.delete(requestKey); });
    lyricsRequests.set(requestKey, request);
  }

  try {
    const found = await request;
    if (seq !== lyricsLoadSeq || requestedKey !== currentTrackKey) return;
    if (found?.trackKey && found.trackKey !== requestedKey) return;
    lyrics = found; lyricsTrackKey = requestedKey;
    const hasSyncedLyrics = Boolean((found?.syncedLines || []).length) && !found?.approximateSync && !found?.estimatedSync && !found?.needsUpgrade;
    // Plain lyrics are useful immediately, but keep probing in the background for
    // timestamped lyrics so the Web Player can upgrade to live tracking without a
    // page refresh. Stop retrying only after synced timings are actually found.
    if (hasSyncedLyrics) {
      lyricsRetryCount = 0;
      if (lyricsRetryTimer) { clearTimeout(lyricsRetryTimer); lyricsRetryTimer = null; }
    } else {
      scheduleLyricsRetry(requestedKey);
    }
    if (view === 'lyrics') renderLyrics();
    renderAdvance();
  } catch (err) {
    if (seq !== lyricsLoadSeq || requestedKey !== currentTrackKey) return;
    const changed = /track changed/i.test(String(err?.message || ''));
    if (view === 'lyrics') {
      resetLyricsView(false);
      const node = document.createElement('div'); node.className = 'lyric-line near';
      node.textContent = changed ? 'Loading lyrics…' : 'Lyrics are unavailable for this version.';
      els.lyricsScroller.append(node);
    }
    if (changed && requestedKey === currentTrackKey) {
      // A skip can race the server-side lyrics lookup. Retry the *current* track
      // automatically instead of leaving the loading/old view stuck until refresh.
      setTimeout(() => {
        if (requestedKey === currentTrackKey) void loadLyrics(true);
      }, 180);
      return;
    }
    if (view === 'lyrics') toast(err.message);
  }
}

function renderLyrics() {
  const lines = lyrics?.syncedLines || [];
  els.lyricsScroller.replaceChildren();
  els.lyricsScroller.dataset.y = '0';
  els.lyricsScroller.style.transform = 'translate3d(0,0,0)';
  lastLine = -1;
  const fragment = document.createDocumentFragment();
  if (!lines.length) {
    const plain = String(lyrics?.plainLyrics || 'No synced lyrics available.').split(/\n+/).filter(Boolean).slice(0, 120);
    for (const text of plain) {
      const node = document.createElement('div'); node.className = 'lyric-line near'; node.textContent = text; fragment.append(node);
      node.dir = 'auto';
    }
  } else {
    lines.forEach((line, index) => {
      const node = document.createElement('div'); node.className = 'lyric-line'; node.dataset.i = String(index); buildKaraokeWords(node, line, index, lines); fragment.append(node);
      node.dir = 'auto'; node.tabIndex = 0; node.setAttribute('role', 'button'); node.setAttribute('aria-label', `Jump to ${line.text || 'this lyric'}`);
      node.addEventListener('click', () => void act('seekTo', Number(line.time || 0)));
      node.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.code === 'Space') { ev.preventDefault(); void act('seekTo', Number(line.time || 0)); } });
    });
  }
  els.lyricsScroller.append(fragment);
}

function updateLyrics(sec) {
  const lines = lyrics?.syncedLines || [];
  if (!lines.length) return;
  let lo = 0, hi = lines.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(lines[mid].time || 0) <= sec) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx >= 0 && Number.isFinite(Number(lines[idx].endTime)) && Number(lines[idx].endTime) > Number(lines[idx].time) && sec >= Number(lines[idx].endTime)) idx = -1;
  const activeNode=idx>=0?els.lyricsScroller.children[idx]:null;
  if(activeNode){
    const start=Number(lines[idx].time)||0;
    const end=Number(lines[idx].endTime)>start?Number(lines[idx].endTime):Number(lines[idx+1]?.time)>start?Number(lines[idx+1].time):start+5;
    const fill=Math.max(0,Math.min(1,(sec-start)/Math.max(.01,end-start)));
    if(activeNode._fill!==fill){activeNode._fill=fill;activeNode.style.setProperty('--fill',String(fill));}
    paintKaraokeWords(activeNode, sec, true);
  }
  if (idx === lastLine) return;
  const previous = lastLine;
  lastLine = idx;
  const nodes = els.lyricsScroller.children;
  if(previous<0)for(const node of nodes)if(node!==activeNode){node.classList.remove('active');node._fill=0;node.style.setProperty('--fill','0');paintKaraokeWords(node, sec, false);}
  if (previous >= 0 && nodes[previous]) {nodes[previous].classList.remove('active');nodes[previous]._fill=0;nodes[previous].style.setProperty('--fill','0');paintKaraokeWords(nodes[previous], sec, false);}
  for (let i = Math.max(0, idx - 4); i <= Math.min(nodes.length - 1, idx + 4); i++) {
    const node = nodes[i];
    node.classList.toggle('active', i === idx);
    node.classList.toggle('near', i !== idx && Math.abs(i - idx) <= 2);
    node.classList.toggle('past', i < idx - 2);
  }
  if (previous >= 0 && Math.abs(previous - idx) > 5) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      node.classList.toggle('active', i === idx);
      node.classList.toggle('near', i !== idx && Math.abs(i - idx) <= 2);
      node.classList.toggle('past', i < idx - 2);
    }
  }
  const active = idx >= 0 ? nodes[idx] : null;
  if (active && lyricsFollowEnabled) {
    const pane = els.lyricsPane.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    const targetY = pane.top + pane.height * .45;
    const delta = rect.top + rect.height * .5 - targetY;
    const current = Number(els.lyricsScroller.dataset.y || 0);
    const nextY = current - delta;
    els.lyricsScroller.dataset.y = String(nextY);
    els.lyricsScroller.style.transform = `translate3d(0,${nextY}px,0)`;
  }
}

function buildKaraokeWords(node, line, index, lines) {
  const text = String(line.text || '♪');
  const start = Number(line.time) || 0;
  const end = Number(line.endTime) > start ? Number(line.endTime) : Number(lines[index + 1]?.time) > start ? Number(lines[index + 1].time) : Number(lyrics?.duration) > start ? Number(lyrics.duration) : start + 5;
  const timed = Array.isArray(line.words) ? line.words : [];
  const segments = [];
  let cursor = 0;
  for (let i = 0; i < timed.length; i++) {
    const word = timed[i], value = String(word.text || '').trim();
    const charStart = text.indexOf(value, cursor);
    const time = word.time == null ? NaN : Number(word.time);
    if (!value || charStart < 0 || !Number.isFinite(time) || time < start || time > end) { segments.length = 0; break; }
    const finish = Number(word.endTime) > time ? Number(word.endTime) : Number(timed[i + 1]?.time) > time ? Number(timed[i + 1].time) : end;
    segments.push({ text: value, charStart, time, endTime: Math.min(end, finish), estimated: word.endTime == null });
    cursor = charStart + value.length;
  }
  const provider = segments.length > 0 && segments.map(segment => segment.text).join('').replace(/\s+/g, '') === text.replace(/\s+/g, '');
  if (!provider) segments.splice(0, segments.length, { text, charStart: 0, time: start, endTime: end, estimated: true });
  node._karaokeWords = [];
  node.dataset.wordTiming = provider ? 'provider' : 'estimated';
  // A gradient on a full-width div sweeps through empty padding and wrapped
  // rows. Each word has its own text-width gradient and source interval instead.
  node.style.background = 'none';
  cursor = 0;
  for (const segment of segments) {
    const pieces = [...segment.text.matchAll(/\S+/gu)];
    const weight = pieces.reduce((sum, piece) => sum + [...piece[0]].length, 0) || 1;
    let consumed = 0;
    for (const piece of pieces) {
      const charStart = segment.charStart + piece.index;
      if (charStart > cursor) node.append(document.createTextNode(text.slice(cursor, charStart)));
      const span = document.createElement('span'); span.className = 'lyric-word'; span.textContent = piece[0];
      span.style.display = 'inline-block';
      span.style.backgroundClip = 'text'; span.style.webkitBackgroundClip = 'text';
      const duration = Math.max(0, segment.endTime - segment.time);
      const time = segment.time + duration * consumed / weight;
      consumed += [...piece[0]].length;
      const endTime = segment.time + duration * consumed / weight;
      node._karaokeWords.push({ node: span, time, endTime });
      node.append(span);
      cursor = charStart + piece[0].length;
    }
    if (provider && (pieces.length > 1 || segment.estimated)) node.dataset.wordTiming = 'mixed';
  }
  if (cursor < text.length) node.append(document.createTextNode(text.slice(cursor)));
  paintKaraokeWords(node, start, false);
}

function paintKaraokeWords(node, sec, active) {
  for (const word of node._karaokeWords || []) {
    const fill = active ? Math.max(0, Math.min(1, (sec - word.time) / Math.max(.01, word.endTime - word.time))) : 0;
    if (word.fill === fill && word.active === active) continue;
    word.fill = fill; word.active = active;
    word.node.style.setProperty('--fill', String(fill));
    word.node.style.color = active ? 'transparent' : 'inherit';
    word.node.style.backgroundImage = active ? 'linear-gradient(to right,#fff calc(var(--fill,0)*100%),rgba(255,255,255,.32) calc(var(--fill,0)*100%))' : 'none';
    if (active && /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u.test(word.node.textContent)) word.node.style.backgroundImage = word.node.style.backgroundImage.replace('to right', 'to left');
  }
}

async function loadCollection(kind) {
  collectionKind = kind;
  selectedIndexes = new Set(); updateSelectionCount();
  els.collectionTitle.textContent = { favorites: 'Your Library', history: 'Recently Played', discover: 'Made for You', queue: 'Up Next' }[kind] || 'Music';
  els.collectionEyebrow.textContent = { favorites: 'SAVED SONGS', history: 'PLAYBACK HISTORY', discover: 'FROM YOUR LISTENING', queue: 'CURRENT SESSION' }[kind] || 'YOUR MUSIC';
  $('.collection-actions').hidden = kind === 'queue';
  $('#clearHistory').hidden = kind !== 'history';
  els.collectionList.innerHTML = '<div class="track-artist">Loading…</div>';
  try {
    const data = await api(`/api/collection?kind=${encodeURIComponent(kind)}`);
    collection = data.tracks || [];
    renderCollection();
  } catch (err) { els.collectionList.textContent = err.message; }
}

const ROW_ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z" fill="currentColor" stroke="none"/></svg>',
  add: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20S4 15 4 9a4 4 0 0 1 8-1.5A4 4 0 0 1 20 9c0 6-8 11-8 11z"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h11"/></svg>',
  remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7"/></svg>',
};
function updateSelectionCount() { els.selectedCount.textContent = `${selectedIndexes.size} selected`; }
function toggleSelection(index, row) {
  if (selectedIndexes.has(index)) selectedIndexes.delete(index); else selectedIndexes.add(index);
  row?.classList.toggle('selected', selectedIndexes.has(index));
  const dot = row?.querySelector('.select-dot'); if (dot) dot.innerHTML = selectedIndexes.has(index) ? ROW_ICONS.check : '';
  updateSelectionCount();
}
function escapeAttr(value) { return String(value).replace(/[&<>'"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c])); }

function renderCollection() {
  els.collectionList.replaceChildren();
  if (!collection.length) { const empty = document.createElement('div'); empty.className = 'track-artist'; empty.textContent = 'No tracks yet.'; els.collectionList.append(empty); updateSelectionCount(); return; }
  const fragment = document.createDocumentFragment();
  collection.forEach((track, index) => {
    const row = document.createElement('div'); row.className = `track-row${selectedIndexes.has(index) ? ' selected' : ''}`;
    row.innerHTML = `<img alt="" loading="lazy" decoding="async"><div class="track-main"><div class="track-title"></div><div class="track-artist"></div></div><span class="track-duration">${fmt(track.duration)}</span><div class="row-actions"><button class="select-dot" data-select="${index}" aria-label="Select track">${selectedIndexes.has(index) ? ROW_ICONS.check : ''}</button><button class="mini-action" data-play="${index}" aria-label="Play track">${ROW_ICONS.play}</button></div>`;
    const artwork = row.querySelector('img');
    artwork.addEventListener('error', () => imageFailed(artwork));
    setImage(artwork, track.thumbnail);
    row.querySelector('.track-title').textContent = track.title || 'Unknown';
    row.querySelector('.track-artist').textContent = track.author || 'Unknown';
    if (collectionKind === 'queue') row.querySelector('[data-select]').remove();
    else row.querySelector('[data-select]').addEventListener('click', ev => { ev.stopPropagation(); toggleSelection(index, row); });
    row.querySelector('[data-play]').addEventListener('click', ev => { ev.stopPropagation(); playCollection(index); });
    if (collectionKind !== 'queue') {
      addRowButton(row, '≡', 'Add to playlist', () => openPlaylistDialog('add', track));
    }
    if (['favorites', 'history', 'queue'].includes(collectionKind) && !(collectionKind === 'queue' && index === state?.index)) {
      addRowButton(row, '×', 'Remove', () => removeCollectionTrack(index, track));
    }
    row.addEventListener('dblclick', () => playCollection(index));
    fragment.append(row);
  });
  els.collectionList.append(fragment); updateSelectionCount();
}

async function playCollection(index) {
  try {
    const body = collectionKind === 'queue' ? { action: 'jumpQueue', index } : { action: 'playCollection', kind: collectionKind, index };
    renderState(await api('/api/action', { method: 'POST', body: JSON.stringify(body) }));
    toast('Playing'); await setView('player');
  } catch (err) { toast(err.message); }
}
async function runCollectionAction(action, indexes) {
  if (!collection.length) return;
  const chosen = Array.isArray(indexes) ? indexes : [];
  if (!chosen.length) return toast('Select at least one track.');
  try {
    renderState(await api('/api/action', { method: 'POST', body: JSON.stringify({ action, kind: collectionKind, indexes: chosen }) }));
    toast(action === 'playCollection' ? 'Playing selection' : 'Added to queue');
    if (action === 'playCollection') await setView('player');
  } catch (err) { toast(err.message); }
}

function addRowButton(row, symbol, label, click) {
  const button = document.createElement('button');
  button.className = 'row-icon'; button.type = 'button';
  const icon = ({ '▶': 'play', '+': 'add', '♡': 'heart', '≡': 'list', '×': 'remove' })[symbol];
  if (icon) button.innerHTML = ROW_ICONS[icon]; else button.textContent = symbol;
  button.title = label; button.setAttribute('aria-label', label);
  button.addEventListener('click', ev => { ev.stopPropagation(); void click(); });
  row.querySelector('.row-actions').append(button);
  return button;
}

function confirmChange(title, description, buttonText = 'Remove') {
  $('#confirmTitle').textContent = title;
  $('#confirmCopy').textContent = description;
  $('#confirmSubmit').textContent = buttonText;
  els.confirmDialog.showModal();
  return new Promise(resolve => {
    const finish = accepted => { els.confirmDialog.close(); resolve(accepted); };
    $('#confirmCancel').onclick = () => finish(false);
    $('#confirmSubmit').onclick = () => finish(true);
    els.confirmDialog.oncancel = ev => { ev.preventDefault(); finish(false); };
  });
}

async function libraryAction(operation, extra = {}) {
  return api('/api/library', { method: 'POST', body: JSON.stringify({ operation, ...extra }) });
}

async function removeCollectionTrack(index, track) {
  const kind = collectionKind;
  if (!await confirmChange('Remove this song?', `Remove “${track.title}” from ${kind === 'favorites' ? 'your favorites' : kind === 'history' ? 'your history' : 'the queue'}?`)) return;
  try {
    if (kind === 'queue') renderState(await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'removeQueue', index }) }));
    else await libraryAction(kind === 'favorites' ? 'removeFavorite' : 'removeHistory', { index });
    await loadCollection(kind); toast('Removed');
  } catch (err) { toast(err.message); }
}

function showCatalogHeader(title, eyebrow, description, showTabs = false) {
  els.catalogTitle.textContent = title;
  els.catalogEyebrow.textContent = eyebrow;
  els.catalogDescription.textContent = description;
  els.catalogTabs.hidden = !showTabs;
  els.catalogBack.hidden = catalogMode === 'search' || catalogMode === 'playlists';
  els.catalogActions.replaceChildren(); els.catalogActions.hidden = true;
  els.catalogList.replaceChildren();
}

function catalogMessage(message) {
  els.catalogList.replaceChildren();
  const p = document.createElement('p'); p.className = 'catalog-empty'; p.textContent = message;
  els.catalogList.append(p);
}

async function loadSearch() {
  catalogMode = 'search'; catalogDetail = null;
  const query = els.searchInput.value.trim();
  showCatalogHeader(query ? `Results for “${query}”` : 'Explore Music', 'SONGS · ALBUMS · ARTISTS',
    query ? 'Find the sound you want.' : 'Search songs, albums and artists to build your listening space.', true);
  $$('.catalog-tab').forEach(x => x.classList.toggle('active', x.dataset.type === catalogType));
  if (query.length < 2) return catalogMessage('Type at least two characters to search.');
  const requestId = ++catalogRequest;
  catalogMessage('Searching the catalog…');
  try {
    const result = await api(`/api/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(catalogType)}`);
    if (requestId !== catalogRequest || view !== 'search' || catalogMode !== 'search') return;
    renderCatalogItems(result.items || []);
  } catch (err) {
    if (requestId === catalogRequest) catalogMessage(err.message);
  }
}

function cardImage(item) {
  const image = document.createElement('img');
  image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
  image.addEventListener('error', () => imageFailed(image));
  setImage(image, item.thumbnail);
  return image;
}

function makeCatalogCard(item, open) {
  const card = document.createElement('button'); card.className = 'catalog-card'; card.type = 'button';
  const image = cardImage(item); card.append(image);
  const copy = document.createElement('span'); copy.className = 'catalog-card-copy';
  const title = document.createElement('strong'); title.textContent = item.title || item.name || 'Unknown';
  const sub = document.createElement('small'); sub.textContent = item.subtitle || item.author || '';
  copy.append(title, sub); card.append(copy);
  card.addEventListener('click', open);
  return card;
}

function makeCatalogSong(item, index = 0, extra = {}) {
  const row = document.createElement('div'); row.className = 'catalog-song';
  row.append(cardImage(item));
  const copy = document.createElement('div'); copy.className = 'track-main';
  const title = document.createElement('strong'); title.className = 'track-title'; title.textContent = item.title || 'Unknown';
  const artist = document.createElement('span'); artist.className = 'track-artist'; artist.textContent = item.author || 'Unknown';
  copy.append(title, artist); row.append(copy);
  const duration = document.createElement('span'); duration.className = 'track-duration'; duration.textContent = item.duration ? fmt(item.duration) : '';
  row.append(duration);
  const actions = document.createElement('div'); actions.className = 'row-actions'; row.append(actions);
  addRowButton(row, '▶', 'Play song', () => playCatalog(item));
  addRowButton(row, '+', 'Add to queue', () => playCatalog(item, true));
  addRowButton(row, '♡', 'Add to favorites', async () => {
    try { await libraryAction('addFavorite', { track: item }); toast('Added to Library'); }
    catch (err) { toast(err.message); }
  });
  addRowButton(row, '≡', 'Add to playlist', () => openPlaylistDialog('add', item));
  if (extra.remove) addRowButton(row, '×', 'Remove from playlist', () => extra.remove(index, item));
  row.addEventListener('dblclick', () => playCatalog(item));
  return row;
}

function renderCatalogItems(items) {
  els.catalogList.replaceChildren();
  if (!items.length) return catalogMessage('No results found. Try a different search.');
  const fragment = document.createDocumentFragment();
  if (catalogType === 'tracks') {
    const list = document.createElement('div'); list.className = 'catalog-songs';
    items.forEach((item, index) => list.append(makeCatalogSong(item, index))); fragment.append(list);
  } else {
    const grid = document.createElement('div'); grid.className = 'catalog-grid';
    items.forEach(item => grid.append(makeCatalogCard(item, () => openCatalogDetail(item.kind, item.id)))); fragment.append(grid);
  }
  els.catalogList.append(fragment);
}

async function playCatalog(item, queue = false) {
  try {
    toast(queue ? 'Adding to queue…' : 'Starting song…');
    renderState(await api('/api/action', { method: 'POST', body: JSON.stringify({ action: queue ? 'queueTrack' : 'playTrack', track: item }) }));
    toast(queue ? 'Added to queue' : 'Now playing');
    if (!queue) await setView('player');
  } catch (err) { toast(err.message); }
}

function catalogAction(label, handler, primary = false) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = `mini-action${primary ? ' primary' : ''}`;
  button.textContent = label; button.addEventListener('click', handler);
  els.catalogActions.hidden = false; els.catalogActions.append(button);
}

async function playCatalogList(tracks, queue = false) {
  if (!tracks.length) return toast('No songs here yet.');
  try {
    toast('Finding playable songs…');
    renderState(await api('/api/action', { method: 'POST', body: JSON.stringify({ action: queue ? 'queueTracks' : 'playTracks', tracks }) }));
    toast(queue ? 'Added to queue' : 'Now playing');
    if (!queue) await setView('player');
  } catch (err) { toast(err.message); }
}

async function openCatalogDetail(type, id) {
  if (!id) return;
  catalogMode = type; catalogDetail = { type, id }; ++catalogRequest;
  showCatalogHeader('Loading…', type === 'artist' ? 'ARTIST' : 'ALBUM', 'Loading collection…');
  try {
    const data = await api(`/api/detail?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`);
    if (view !== 'search' || catalogDetail?.id !== id) return;
    showCatalogHeader(data.title, type === 'artist' ? 'ARTIST' : 'ALBUM', data.author || data.subtitle || '');
    if (type === 'artist') {
      if (data.tracks?.length) {
        const h = document.createElement('h3'); h.textContent = 'Popular songs'; els.catalogList.append(h);
        const songs = document.createElement('div'); songs.className = 'catalog-songs';
        data.tracks.forEach((item, i) => songs.append(makeCatalogSong(item, i))); els.catalogList.append(songs);
      }
      const h = document.createElement('h3'); h.textContent = 'Albums'; els.catalogList.append(h);
      const grid = document.createElement('div'); grid.className = 'catalog-grid';
      (data.albums || []).forEach(item => grid.append(makeCatalogCard(item, () => openCatalogDetail('album', item.id))));
      els.catalogList.append(grid);
    } else {
      const songs = data.tracks || [];
      catalogAction('▶ Play album', () => playCatalogList(songs), true);
      catalogAction('+ Queue album', () => playCatalogList(songs, true));
      const list = document.createElement('div'); list.className = 'catalog-songs';
      songs.forEach((item, i) => list.append(makeCatalogSong(item, i))); els.catalogList.append(list);
      if (!songs.length) catalogMessage('No album tracks were available for this release.');
    }
  } catch (err) { catalogMessage(err.message); }
}

async function refreshPlaylists() {
  const response = await api('/api/playlists');
  playlists = response.playlists || [];
  return playlists;
}

async function showPlaylists() {
  catalogMode = 'playlists'; catalogDetail = null;
  showCatalogHeader('Your Playlists', 'PERSONAL COLLECTION', 'Songs grouped your way.');
  catalogAction('+ New playlist', () => openPlaylistDialog('create'), true);
  try {
    await refreshPlaylists();
    if (view !== 'playlists' || catalogMode !== 'playlists') return;
    if (!playlists.length) return catalogMessage('No playlists yet. Create one to get started.');
    const grid = document.createElement('div'); grid.className = 'catalog-grid';
    playlists.forEach(list => grid.append(makeCatalogCard({ title: list.name, author: `${list.count} songs`, thumbnail: list.thumbnail }, () => openPlaylist(list.id))));
    els.catalogList.append(grid);
  } catch (err) { catalogMessage(err.message); }
}

async function openPlaylist(id) {
  catalogMode = 'playlist'; catalogDetail = { type: 'playlist', id };
  showCatalogHeader('Loading playlist…', 'YOUR PLAYLIST', '');
  try {
    const list = playlists.find(p => p.id === id);
    const result = await api(`/api/collection?kind=${encodeURIComponent(`playlist:${id}`)}`);
    if (view !== 'playlists' || catalogDetail?.id !== id) return;
    const songs = result.tracks || [];
    showCatalogHeader(list?.name || 'Playlist', 'YOUR PLAYLIST', `${songs.length} songs`);
    catalogAction('▶ Play all', () => playCatalogList(songs), true);
    catalogAction('+ Queue all', () => playCatalogList(songs, true));
    catalogAction('Rename', () => openPlaylistDialog('rename', null, id));
    catalogAction('Delete', async () => {
      if (!await confirmChange('Delete playlist?', `Delete “${list?.name || 'Playlist'}” and its track list?`)) return;
      try { await libraryAction('deletePlaylist', { id }); await showPlaylists(); toast('Playlist deleted'); }
      catch (err) { toast(err.message); }
    });
    const rows = document.createElement('div'); rows.className = 'catalog-songs';
    songs.forEach((item, index) => rows.append(makeCatalogSong(item, index, { remove: async i => {
      if (!await confirmChange('Remove from playlist?', `Remove “${item.title}”?`)) return;
      try { await libraryAction('removeFromPlaylist', { id, index: i }); await openPlaylist(id); toast('Removed'); }
      catch (err) { toast(err.message); }
    } })));
    els.catalogList.append(rows);
    if (!songs.length) catalogMessage('This playlist is empty. Add a song from Search or your Library.');
  } catch (err) { catalogMessage(err.message); }
}

async function openPlaylistDialog(mode, track = null, id = '') {
  playlistDialogMode = mode; playlistDialogTrack = track; playlistDialogId = id;
  $('#playlistDialogTitle').textContent = mode === 'add' ? 'Add to playlist' : mode === 'rename' ? 'Rename playlist' : 'Create playlist';
  $('#playlistDialogCopy').textContent = mode === 'add' ? 'Choose one of your playlists.' : 'Give your playlist a name.';
  els.playlistSelect.hidden = mode !== 'add'; els.playlistName.hidden = mode === 'add';
  $('#playlistSubmit').textContent = mode === 'add' ? 'Add song' : 'Save playlist';
  els.playlistName.value = mode === 'rename' ? playlists.find(p => p.id === id)?.name || '' : '';
  if (mode === 'add') {
    try { await refreshPlaylists(); } catch (err) { return toast(err.message); }
    els.playlistSelect.replaceChildren();
    if (!playlists.length) { toast('Create a playlist first.'); return openPlaylistDialog('create', track); }
    playlists.forEach(p => {
      const option = document.createElement('option'); option.value = p.id; option.textContent = p.name; els.playlistSelect.append(option);
    });
  }
  els.playlistDialog.showModal();
  if (mode !== 'add') els.playlistName.focus();
}

async function submitPlaylistDialog() {
  const mode = playlistDialogMode;
  const id = mode === 'add' ? els.playlistSelect.value : playlistDialogId;
  const name = els.playlistName.value.trim();
  const button = $('#playlistSubmit'); button.disabled = true;
  try {
    if (mode === 'add') await libraryAction('addToPlaylist', { id, track: playlistDialogTrack });
    else {
      const result = await libraryAction(mode === 'rename' ? 'renamePlaylist' : 'createPlaylist', { id, name });
      if (mode === 'create' && playlistDialogTrack && result.playlists?.[0]?.id) {
        await libraryAction('addToPlaylist', { id: result.playlists[0].id, track: playlistDialogTrack });
      }
    }
    els.playlistDialog.close();
    toast(mode === 'add' ? 'Song added' : 'Playlist saved');
    if (view === 'playlists') mode === 'rename' ? await openPlaylist(id) : await showPlaylists();
  } catch (err) { toast(err.message); }
  finally { button.disabled = false; }
}

function openDownload() {
  els.more.hidden = true;
  els.downloadUrl.value = state?.track?.url || '';
  els.downloadStatus.textContent = '';
  els.downloadDialog.showModal();
  setTimeout(() => els.downloadUrl.focus(), 40);
}

async function downloadAudio() {
  const url = els.downloadUrl.value.trim(); if (!url) return;
  // iOS/Safari can block a synthetic download click after an awaited request.
  // Open the destination tab synchronously while the real user gesture is active,
  // then navigate it to the streamed MP3 after preparation finishes.
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let mobileTarget = null;
  if (isiOS) { try { mobileTarget = window.open('about:blank', '_blank'); if (mobileTarget) mobileTarget.opener = null; } catch (_) {} }
  els.downloadSubmit.disabled = true;
  els.downloadStatus.textContent = 'Preparing high-quality MP3…';
  els.downloadProgress.parentElement.classList.add('active');
  try {
    const result = await api('/api/download/prepare', { method: 'POST', body: JSON.stringify({ url }), timeoutMs: 15 * 60_000 });
    if (!result?.id) throw new Error('Download preparation failed.');
    const href = `/api/download/file?id=${encodeURIComponent(result.id)}&token=${encodeURIComponent(token)}`;
    if (mobileTarget && !mobileTarget.closed) mobileTarget.location.replace(href);
    else {
      const anchor = document.createElement('a'); anchor.href = href; anchor.download = result.filename || 'Music.mp3'; anchor.rel = 'noopener';
      document.body.append(anchor); anchor.click(); anchor.remove();
    }
    els.downloadStatus.textContent = `Ready · ${Math.max(.1, Number(result.bytes || 0) / 1024 / 1024).toFixed(1)} MB MP3`;
  } catch (err) {
    try { if (mobileTarget && !mobileTarget.closed) mobileTarget.close(); } catch (_) {}
    els.downloadStatus.textContent = err.message || 'Download failed';
  } finally { els.downloadSubmit.disabled = false; els.downloadProgress.parentElement.classList.remove('active'); }
}

$$('[data-action]').forEach(button => button.addEventListener('click', () => act(button.dataset.action)));
$$('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
$('#moreToggle').addEventListener('click', () => { els.more.hidden = !els.more.hidden; });
$('#moreClose').addEventListener('click', () => { els.more.hidden = true; });
$('#refreshCollection').addEventListener('click', () => collectionKind && loadCollection(collectionKind));
$('#playSelected').addEventListener('click', () => runCollectionAction('playCollection', [...selectedIndexes]));
$('#queueSelected').addEventListener('click', () => runCollectionAction('queueCollection', [...selectedIndexes]));
$('#playAll').addEventListener('click', () => runCollectionAction('playCollection', collection.map((_, i) => i)));
$('#queueAll').addEventListener('click', () => runCollectionAction('queueCollection', collection.map((_, i) => i)));
$('#clearSelected').addEventListener('click', () => { selectedIndexes.clear(); renderCollection(); });
$('#clearHistory').addEventListener('click', async () => {
  if (!await confirmChange('Delete listening history?', 'All saved listening history for your account will be cleared.')) return;
  try { await libraryAction('clearHistory'); await loadCollection('history'); toast('History cleared'); }
  catch (err) { toast(err.message); }
});

$('#searchForm').addEventListener('submit', ev => { ev.preventDefault(); void setView('search'); });
els.searchInput.addEventListener('input', () => {
  if (window.MusicPlatform) return;
  clearTimeout(els.searchInput.timer);
  els.searchInput.timer = setTimeout(() => { if (els.searchInput.value.trim().length >= 2) void setView('search'); }, 160);
});
els.searchInput.addEventListener('focus', () => { if (!window.MusicPlatform && view !== 'search') void setView('search'); });
document.addEventListener('keydown', ev => {
  if (ev.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    ev.preventDefault(); els.searchInput.focus();
  }
});
$$('.catalog-tab').forEach(button => button.addEventListener('click', () => {
  catalogType = button.dataset.type; void loadSearch();
}));
els.catalogBack.addEventListener('click', () => {
  if (view === 'playlists') void showPlaylists();
  else void loadSearch();
});
$('#playlistSubmit').addEventListener('click', submitPlaylistDialog);
els.playlistName.addEventListener('keydown', ev => {
  if (ev.key === 'Enter') { ev.preventDefault(); void submitPlaylistDialog(); }
});
els.playlistDialog.querySelector('.close-dialog').addEventListener('click', () => els.playlistDialog.close());
const updateSeekWidth = () => { seekWidth = els.seek.getBoundingClientRect().width; };
if ('ResizeObserver' in window) new ResizeObserver(updateSeekWidth).observe(els.seek);
else {
  window.addEventListener('resize', updateSeekWidth, { passive: true });
  window.addEventListener('orientationchange', updateSeekWidth, { passive: true });
}
updateSeekWidth();
// Track a stable, untransformed zone. Rotated cover bounds shift under the
// pointer and would otherwise create a jittery enter/leave loop at the edges.
const coverPhysics = typeof window.createCoverPhysics === 'function' ? window.createCoverPhysics() : null;
const reduceCoverMotion = matchMedia('(prefers-reduced-motion: reduce)');
function animateCoverFrame(now) {
  if (!coverPhysics) return;
  if (reduceCoverMotion.matches || document.hidden || window.innerWidth <= 760) {
    coverPhysics.reset();
    els.coverMotion.classList.remove('is-interacting');
    els.coverMotion.classList.remove('is-moving');
    if (els.coverMotion.style.transform) {
      els.coverMotion.style.removeProperty('transform');
    }
    return;
  }
  const pose = coverPhysics.tick(now);
  const moving = Math.abs(pose.rx) + Math.abs(pose.ry) > .03;
  const element = els.coverMotion;
  if (moving) element.style.transform = `rotateX(${pose.rx.toFixed(3)}deg) rotateY(${pose.ry.toFixed(3)}deg)`;
  else if (element.style.transform) element.style.removeProperty('transform');
  element.classList.toggle('is-moving', moving);
  element.style.setProperty('--light-x', `${pose.lightX.toFixed(2)}%`);
  element.style.setProperty('--light-y', `${pose.lightY.toFixed(2)}%`);
  element.style.setProperty('--reflect', pose.glow.toFixed(3));
}
const artZone = els.coverMotion.parentElement;
let coverLayoutRevision = 0;
let pointerNeedsPhysicalMove = true;
let lastPointerClient = null;
let lastCoverMetrics = null;

function stableCoverRect() {
  const zone = artZone.getBoundingClientRect();
  const width = els.coverMotion.offsetWidth;
  const height = els.coverMotion.offsetHeight;
  if (!width || !height) return null;
  return {
    left: zone.left + (zone.width - width) / 2,
    top: zone.top + (zone.height - height) / 2,
    width,
    height,
  };
}
function releaseCoverInteraction(reset = false) {
  if (!coverPhysics) return;
  if (reset) coverPhysics.reset();
  else coverPhysics.release();
  els.coverMotion.classList.remove('is-interacting');
}
const measureCoverPerspective = () => {
  const rect = stableCoverRect();
  if (!rect || !coverPhysics) return;
  artZone.style.setProperty('--cover-perspective', `${(rect.width * coverPhysics.perspectiveRatio).toFixed(2)}px`);
  const metrics = [rect.left, rect.top, rect.width, rect.height];
  const layoutChanged = !lastCoverMetrics || metrics.some((value, i) => Math.abs(value - lastCoverMetrics[i]) > .35);
  lastCoverMetrics = metrics;
  if (layoutChanged) {
    coverLayoutRevision++;
    pointerNeedsPhysicalMove = true;
    lastPointerClient = null;
    releaseCoverInteraction(true);
    els.coverMotion.classList.remove('is-moving');
    els.coverMotion.style.removeProperty('transform');
  }
};
if ('ResizeObserver' in window) new ResizeObserver(measureCoverPerspective).observe(els.coverMotion);
else window.addEventListener('resize', measureCoverPerspective, { passive: true });
window.addEventListener('resize', measureCoverPerspective, { passive: true });
window.addEventListener('orientationchange', measureCoverPerspective, { passive: true });
measureCoverPerspective();
artZone.addEventListener('pointermove', ev => {
  if (!coverPhysics || ev.pointerType === 'touch' || reduceCoverMotion.matches || window.innerWidth <= 760) return;
  const previous = lastPointerClient;
  const moved = (previous && Math.hypot(ev.clientX - previous.x, ev.clientY - previous.y) > .25) || Math.hypot(ev.movementX || 0, ev.movementY || 0) > .25;
  lastPointerClient = { x: ev.clientX, y: ev.clientY, revision: coverLayoutRevision };
  const rect = stableCoverRect();
  if (!rect) return;
  // Strictly use the untransformed artwork rectangle. The old ±1.08 halo was
  // visibly activating the card before the cursor actually reached its edge.
  const x = (ev.clientX - rect.left - rect.width / 2) * 2 / rect.width;
  const y = (ev.clientY - rect.top - rect.height / 2) * 2 / rect.height;
  if (Math.abs(x) > 1 || Math.abs(y) > 1) {
    releaseCoverInteraction();
    return;
  }
  // Browsers can synthesize pointermove while layout changes under a stationary
  // cursor. After resize/reflow require a real coordinate delta before arming.
  if (pointerNeedsPhysicalMove && !moved) {
    releaseCoverInteraction();
    return;
  }
  pointerNeedsPhysicalMove = false;
  coverPhysics.setPointer(x, y);
  els.coverMotion.classList.add('is-interacting');
});
artZone.addEventListener('pointerleave', () => {
  releaseCoverInteraction();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  coverPhysics?.reset();
  els.coverMotion.classList.remove('is-interacting');
  els.coverMotion.classList.remove('is-moving');
  els.coverMotion.style.removeProperty('transform');
});

els.volume.addEventListener('input', () => {
  clearTimeout(els.volume.timer);
  els.volume.timer = setTimeout(() => act('volume', Number(els.volume.value)), 90);
});

function seekTargetFromClientX(clientX) {
  if (!state?.track?.duration) return null;
  const rect = els.seek.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
  return ratio * Number(state.track.duration || 0);
}
function previewSeek(clientX) {
  const target = seekTargetFromClientX(clientX);
  if (target != null) seekPreview = target;
  return target;
}
let seekPointer = null;
els.seek.addEventListener('pointerdown', ev => {
  if (!state?.track?.duration) return;
  seekPointer = ev.pointerId;
  els.seek.setPointerCapture?.(ev.pointerId);
  previewSeek(ev.clientX);
});
els.seek.addEventListener('pointermove', ev => {
  if (seekPointer === ev.pointerId) previewSeek(ev.clientX);
});
els.seek.addEventListener('pointerup', ev => {
  if (seekPointer !== ev.pointerId) return;
  const target = previewSeek(ev.clientX);
  seekPointer = null;
  seekPreview = null;
  try { els.seek.releasePointerCapture?.(ev.pointerId); } catch (_) {}
  if (target != null && Math.abs(target - elapsedNow()) >= .25) void act('seekTo', target);
});
els.seek.addEventListener('pointercancel', ev => {
  if (seekPointer === ev.pointerId) { seekPointer = null; seekPreview = null; }
});
els.seek.addEventListener('keydown', ev => {
  if (!state?.track?.duration || !['ArrowLeft','ArrowRight','Home','End'].includes(ev.key)) return;
  ev.preventDefault();
  let target = elapsedNow();
  if (ev.key === 'ArrowLeft') target -= Number(state.seekSeconds || 20);
  if (ev.key === 'ArrowRight') target += Number(state.seekSeconds || 20);
  if (ev.key === 'Home') target = 0;
  if (ev.key === 'End') target = Number(state.track.duration || 0) - .25;
  void act('seekTo', Math.max(0, target));
});

els.lyricsAdvance.value = String(syncAdjust);
els.lyricsAdvance.addEventListener('input', () => {
  syncAdjust = Number(els.lyricsAdvance.value || 0);
  if (currentTrackKey) { songSyncAdjustments[currentTrackKey] = syncAdjust; try { localStorage.setItem('lyricsAdvanceByTrack', JSON.stringify(songSyncAdjustments)); localStorage.removeItem('lyricsAdvanceAdjust'); } catch (_) {} }
  renderAdvance();
});

$('#downloadOpen').addEventListener('click', openDownload);
$('#downloadQuick').addEventListener('click', () => { if(window.MusicPlatform?.downloadItem)void window.MusicPlatform.downloadItem();else openDownload(); });
$('.close-dialog').addEventListener('click', () => els.downloadDialog.close());
els.downloadSubmit.addEventListener('click', downloadAudio);
els.downloadUrl.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); void downloadAudio(); } });

document.addEventListener('pointerdown', ev => {
  if (!els.more.hidden && !els.more.contains(ev.target) && !$('#moreToggle').contains(ev.target)) els.more.hidden = true;
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshState(); });
if (els.coverVideo) {
  els.coverVideo.addEventListener('loadeddata', () => {
    if (!isCurrentMotionEvent(els.coverVideo)) return;
    const expected = String(state?.track?.animatedArtwork || '');
    const currentList = String(els.coverVideo.dataset.motionSources || '').split('\n').filter(Boolean);
    const current = currentList[Number(els.coverVideo.dataset.motionIndex || 0)] || '';
    if (!current || (!expected && !currentList.length)) return;
    els.coverMotion?.classList.remove('motion-loading');
    els.coverMotion?.classList.add('motion-ready');
    if (!document.hidden) void els.coverVideo.play().catch(() => {});
  });
  els.coverVideo.addEventListener('error', () => {
    if (!isCurrentMotionEvent(els.coverVideo)) return;
    const next = Number(els.coverVideo.dataset.motionIndex || 0) + 1;
    tryAnimatedSource(next);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (els.coverVideo.dataset.motionSources) void els.coverVideo.play().catch(() => {});
  });
}
els.cover.addEventListener('error', () => { if(!window.MusicPlatform?.artworkFailed(els.cover)) imageFailed(els.cover); });
els.miniCover.addEventListener('error', () => { if(!window.MusicPlatform?.artworkFailed(els.miniCover)) imageFailed(els.miniCover); });

const lyricsFollowControl = document.createElement('label');
lyricsFollowControl.className = 'lyrics-follow-control';
const lyricsFollowInput = document.createElement('input'); lyricsFollowInput.type = 'checkbox'; lyricsFollowInput.checked = true; lyricsFollowInput.setAttribute('aria-label', 'Follow lyrics');
lyricsFollowControl.append(lyricsFollowInput, document.createTextNode('Follow'));
els.lyricsPane.querySelector('.lyrics-heading').append(lyricsFollowControl);
lyricsFollowInput.addEventListener('change', () => {
  lyricsFollowEnabled = lyricsFollowInput.checked;
  els.lyricsPane.querySelector('.lyrics-window').style.overflowY = lyricsFollowEnabled ? 'hidden' : 'auto';
  if (lyricsFollowEnabled) lastLine = -1;
});

window.MusicPlayerUI = {
  token, api, act, renderState, refreshState, getState: () => state, elapsedNow,
  setView: next => setView(next, true), showToast: toast, fmt, setImage, setImageSources, imageFailed,
  openDownload, openPlaylistDialog, confirmChange,
  setMotionEnabled: enabled => { motionArtworkEnabled = enabled; if (!enabled) stopAnimatedCover(); else { motionExhaustedKey = ''; setAnimatedCover(state?.track); } }
};

if (!token) toast('Missing private session token.');
else {
  refreshState();
  setInterval(refreshState, 1000);
  if (!$('#platformContent')) setView(view);
  requestAnimationFrame(renderFrame);
}
