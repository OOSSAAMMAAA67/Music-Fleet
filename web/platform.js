'use strict';

// Catalog navigation, persisted collection actions and browser media are separate
// from the existing Discord playback/lyrics engine. Both share the same session.
(() => {
  const player = window.MusicPlayerUI;
  if (!player) return;
  const q = selector => document.querySelector(selector);
  const content = q('#platformContent');
  const menu = q('#itemMenu');
  const dialog = q('#platformDialog');
  const dialogContent = q('#platformDialogContent');
  const mediaPrepareTimeout = 15 * 60 * 1000;
  const current = { route: null, seq: 0, abort: null, data: null, searchType: 'all', playlists: [], preferences: {}, saved: new Map(), queueSignature: '', fullTab: 'similar', fullSeq: 0, videoSeq: 0, videoAbort: null, sortAscending: true };
  const domItems = new WeakMap();
  const iconPaths = {
    play: '<path d="m8 5 11 7-11 7z"/>',
    heart: '<path d="M12 20S4 15 4 9a4 4 0 0 1 8-1.5A4 4 0 0 1 20 9c0 6-8 11-8 11z"/>',
    more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    queue: '<path d="M4 6h16M4 12h16M4 18h10M18 16l4 3-4 3z"/>',
    artist: '<circle cx="12" cy="8" r="4"/><path d="M4 22v-2a8 8 0 0 1 16 0v2"/>',
    album: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
    radio: '<circle cx="12" cy="12" r="2"/><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4 4a11 11 0 0 0 0 16M20 4a11 11 0 0 1 0 16"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M4 19v3h16v-3"/>',
    lyrics: '<path d="M4 5h16M4 10h12M4 15h14M4 20h9"/>',
    hide: '<circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/>',
    check: '<path d="m5 12 4.5 4.5L19 6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    left: '<path d="m14 6-6 6 6 6"/>',
    right: '<path d="m10 6 6 6-6 6"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    history: '<path d="M4 4v5h5M5 17a8 8 0 1 0-1-8M12 7v5l3 2"/>',
    upload: '<path d="M12 17V3M6 9l6-6 6 6M4 17v5h16v-5"/>',
    shuffle: '<path d="M4 6h3c5 0 5 12 10 12h3M17 15l3 3-3 3M4 18h3c1.5 0 2.7-1.3 3.7-3M15 6h5M17 3l3 3-3 3"/>',
    new: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 2v6M16 2v6M4 11h16"/>',
    top: '<path d="M8 3h8v7a4 4 0 0 1-8 0zM8 5H4v2a4 4 0 0 0 4 4M16 5h4v2a4 4 0 0 1-4 4M12 14v6M8 21h8"/>',
    video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
    hires: '<path d="M3 10v4M7 6v12M11 3v18M15 7v10M19 10v4"/>',
    clean: '<path d="M9 3h6l7 7-7 11H9L2 10zM9 9h6M9 13h6"/>'
  };
  Object.assign(iconPaths, {
    music: '<path d="M9 18V5l11-2v13M9 7l11-2"/><ellipse cx="5.5" cy="18.5" rx="3.5" ry="2.5"/><ellipse cx="16.5" cy="16.5" rx="3.5" ry="2.5"/>',
    settings: '<path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3z"/><circle cx="12" cy="12" r="3"/>',
    sort: '<path d="M4 5h16M7 12h13M11 19h9"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m9 10 6-4M9 14l6 4"/>',
    atmos: '<path d="M3 5h5a7 7 0 0 1 0 14H3zM21 5h-5a7 7 0 0 0 0 14h5z"/>'
  });
  const svg = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name] || iconPaths.more}</svg>`;
  const create = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = String(text); return el; };
  function canonicalSource(value) {
    try {
      const url = new URL(value, location.origin); url.hash = '';
      if (/^(?:www\.)?youtu\.be$/.test(url.hostname)) return `youtube:${url.pathname.slice(1)}`;
      if (/(^|\.)youtube\.com$/.test(url.hostname)) { const id = url.searchParams.get('v') || url.pathname.match(/\/(?:shorts|embed)\/([^/]+)/)?.[1]; if (id) return `youtube:${id}`; }
      for (const name of [...url.searchParams.keys()]) if (/^utm_|^(?:si|feature|fbclid|ref)$/.test(name)) url.searchParams.delete(name);
      return url.href;
    } catch (_) { return String(value || ''); }
  }
  const keyOf = item => `${item?.kind || 'track'}:${item?.id ? `id:${item.id}` : item?.linkedOriginalUrl || item?.providerUrl || item?.url ? `source:${canonicalSource(item.linkedOriginalUrl || item.providerUrl || item.url)}` : `title:${String(item?.title || '').normalize('NFKC').toLowerCase()}|${String(item?.author || '').normalize('NFKC').toLowerCase()}`}`;
  const songKey = item => `${item?.url || ''}|${item?.title || ''}`;
  const titleOf = item => item?.title || item?.name || 'Untitled';
  const serializeSeed = value => typeof value === 'string' ? value : value && typeof value === 'object' ? JSON.stringify(value) : '';
  const kindOf = item => item?.kind || (item?.tracks ? 'playlist' : 'track');
  const isProviderPlaylist = item => kindOf(item) === 'playlist' && /^[a-z][a-z\d_-]{1,39}:playlist:/i.test(String(item?.id || ''));
  const isLocalPlaylist = item => kindOf(item) === 'playlist' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(String(item?.id || ''));
  const savedKind = item => ({ track: 'tracks', album: 'albums', artist: 'artists', video: 'videos', mix: 'mixes', playlist: 'playlists' })[kindOf(item)] || 'tracks';
  const isSaved = item => current.saved.get(savedKind(item))?.has(keyOf(item)) || Boolean(item?.saved || item?.favorited || item?.followed);
  function partialTrackSummary(item) {
    const report = item?.tracksReport || item?.sourceReport || {};
    if (!item?.partial && !item?.truncated && !report.partial && !report.truncated && report.complete !== false) return '';
    const returned = Math.max(0, Number(report.returned ?? item?.tracks?.length ?? item?.count) || 0);
    const total = Number(report.total), known = report.totalKnown === true && Number.isFinite(total) && total >= returned;
    const cause = item?.truncated || report.truncated ? 'The tracklist limit was reached.' : report.missing > 0 ? 'Some recordings are currently unavailable.' : 'The provider tracklist is incomplete.';
    return `Showing ${returned}${known ? ` of ${total}` : ''} tracks. ${cause}`;
  }

  function button(label, handler, className = 'pill-button', icon = '') {
    const b = create('button', className); b.type = 'button';
    if (icon) b.innerHTML = svg(icon);
    if (label) b.append(create('span', '', label));
    b.addEventListener('click', ev => { ev.stopPropagation(); void Promise.resolve(handler(ev)).catch(report); });
    return b;
  }
  function iconButton(label, icon, handler, className = 'row-icon') {
    const b = button('', handler, className, icon); b.setAttribute('aria-label', label); b.title = label; return b;
  }
  const report = err => { if (err?.name !== 'AbortError') player.showToast(err?.message || 'This action could not be completed.'); };

  async function request(path, { body, signal, headers = {}, timeout, ...options } = {}) {
    const catalogRead = body == null && /^\/api\/(?:platform\/(?:home|explore|search|detail|mix|stats|feed|library)|collection)(?:\?|$)/.test(path);
    const timeoutMs = Number.isFinite(Number(timeout)) && Number(timeout) > 0
      ? Math.max(1500, Number(timeout)) : catalogRead ? 180000 : 45000;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) throw new DOMException('Superseded request', 'AbortError');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetch(path, { ...options, body: body == null ? undefined : typeof body === 'string' || body instanceof Blob ? body : JSON.stringify(body), signal: controller.signal, cache: 'no-store', credentials: 'same-origin', headers: { 'X-Music-Session': player.token, ...(body instanceof Blob ? {} : { 'Content-Type': 'application/json' }), ...headers } });
      let data;
      try { data = await response.json(); }
      catch(err) { if(controller.signal.aborted || err.name==='AbortError')throw err; if(response.ok)throw new Error('The server returned an invalid response. Please try again.');data={}; }
      if (!response.ok) throw new Error(data?.error || `Request failed (${response.status}).`);
      return data;
    } catch (err) {
      if (err.name === 'AbortError' && !signal?.aborted) throw new Error('The provider took too long to respond. Please try again.');
      throw err;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  const post = (path, body, options = {}) => request(path, { ...options, method: 'POST', body });
  const artworkManager=window.MusicArtwork.createArtworkManager({request:(body,options)=>post('/api/platform/artwork/resolve',body,{...options,timeout:30000}),setSources:player.setImageSources,imageFailed:player.imageFailed});
  window.addEventListener('pagehide',()=>artworkManager.close(),{once:true});

  function image(item, extraClass = '') {
    const img = create('img', extraClass); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    artworkManager.watch(img,item);
    return img;
  }

  // At most one small frame loop runs for a moving catalog cover. Stable wrappers
  // keep hover boundaries fixed while the inner surface tilts and reflects light.
  const motionModels = new WeakMap();
  const activeMotion = new Set();
  let motionFrame = 0;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const phone = matchMedia('(max-width: 760px)');
  function scheduleMotion() { if (!motionFrame && activeMotion.size) motionFrame = requestAnimationFrame(tickMotion); }
  function tickMotion(now) {
    motionFrame = 0;
    for (const entry of activeMotion) {
      if (!entry.surface.isConnected || document.hidden || reducedMotion.matches) { entry.model.reset(); entry.surface.style.removeProperty('transform'); activeMotion.delete(entry); continue; }
      const pose = entry.model.tick(now);
      const moving = Math.abs(pose.rx) + Math.abs(pose.ry) + Math.abs(entry.model.vx) + Math.abs(entry.model.vy) > .025;
      entry.surface.style.transform = moving ? `rotateX(${pose.rx.toFixed(3)}deg) rotateY(${pose.ry.toFixed(3)}deg)` : '';
      entry.surface.style.setProperty('--light-x', `${pose.lightX.toFixed(2)}%`);
      entry.surface.style.setProperty('--light-y', `${pose.lightY.toFixed(2)}%`);
      entry.surface.style.setProperty('--reflect', pose.glow.toFixed(3));
      entry.surface.classList.toggle('is-moving', moving);
      if (!moving && !entry.hovered) activeMotion.delete(entry);
    }
    scheduleMotion();
  }
  function attachMotion(wrap, surface) {
    if (!window.createCoverPhysics) return;
    const entry = { wrap, surface, model: window.createCoverPhysics(), hovered: false, pointer: null };
    motionModels.set(wrap, entry);
    wrap.addEventListener('pointermove', ev => {
      if (reducedMotion.matches || ev.pointerType === 'touch') return;
      const rect = wrap.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      wrap.style.setProperty('--cover-perspective', `${rect.width * entry.model.perspectiveRatio}px`);
      const x = (ev.clientX - rect.left) * 2 / rect.width - 1;
      const y = (ev.clientY - rect.top) * 2 / rect.height - 1;
      if (Math.abs(x) > 1 || Math.abs(y) > 1) { entry.hovered = false; entry.model.release(); return; }
      if (entry.pointer && Math.hypot(entry.pointer.x - ev.clientX, entry.pointer.y - ev.clientY) < .2) return;
      entry.pointer = { x: ev.clientX, y: ev.clientY };
      entry.hovered = true; entry.model.setPointer(x, y); activeMotion.add(entry); scheduleMotion();
    }, { passive: true });
    wrap.addEventListener('pointerleave', () => { entry.hovered = false; entry.pointer = null; entry.model.release(); activeMotion.add(entry); scheduleMotion(); }, { passive: true });
  }
  function resetCardMotion() {
    for (const entry of activeMotion) { entry.model.reset(); entry.surface.style.removeProperty('transform'); entry.surface.classList.remove('is-moving'); entry.hovered = false; entry.pointer = null; }
    activeMotion.clear();
  }
  window.addEventListener('resize', resetCardMotion, { passive: true });
  content.addEventListener('scroll', resetCardMotion, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) resetCardMotion(); });

  function artSurface(item, wrapClass = 'art-wrap') {
    const wrap = create('div', wrapClass);
    if(kindOf(item)==='artist')wrap.classList.add('artist-surface');
    const surface = create('div', 'card-motion');
    if (item.artworkType) {
      surface.classList.add('mix-cover', item.artworkType);
      const images = create('div', 'mix-art-images');
      (item.artworkImages?.length ? item.artworkImages : [item.thumbnail]).filter(Boolean).slice(0,4).forEach(thumbnail => {
        const identity = [...(item.artworkItems || []), ...(item.tracks || [])].find(value => value.thumbnail === thumbnail);
        images.append(image(identity || {thumbnail, artworkFallbacks:item.artworkFallbacks}));
      });
      const label = create('div', 'mix-art-label');
      if (/radio$/.test(item.artworkType)) {
        label.append(create('small','',item.artworkType === 'artist-radio' ? 'Artist Radio' : 'Track Radio'));
        let seed; try { seed=typeof item.seed==='string'?JSON.parse(item.seed):item.seed; } catch(_) {}
        const fullTitle = String(seed?.author || seed?.title || item.title || '').replace(/\s+/g, ' ').trim();
        const shortTitle = fullTitle.length > 24 ? `${fullTitle.slice(0, 23).trimEnd()}…` : fullTitle;
        const title = create('span', '', shortTitle);
        title.title = fullTitle;
        title.setAttribute('aria-label', `${item.artworkType === 'artist-radio' ? 'Artist Radio' : 'Track Radio'}: ${fullTitle}`);
        label.append(title);
      } else label.append(create('span','',item.title));
      const mark = create('span', 'mix-art-mark'); mark.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 5; i++) mark.append(create('i'));
      surface.append(images, create('div','mix-art-pattern'), mark, label);
    } else surface.append(image(item, kindOf(item) === 'artist' ? 'artist-art' : ''));
    surface.append(create('span', 'cover-glare'));
    wrap.append(surface); attachMotion(wrap, surface); return { wrap, surface };
  }
  function card(item) {
    const article = create('article', 'platform-card'); domItems.set(article, item);
    const { wrap } = artSurface(item); article.append(wrap);
    const open = iconButton(`Open ${titleOf(item)}`, '', () => openItem(item), 'card-open'); open.replaceChildren(); wrap.append(open);
    const controls = create('div', 'card-controls');
    controls.append(iconButton(`Play ${titleOf(item)}`, 'play', () => playItem(item), 'card-play'), iconButton(`More options for ${titleOf(item)}`, 'more', ev => showMenu(item, ev.currentTarget), 'card-menu'));
    if (kindOf(item) !== 'playlist') controls.append(saveButton(item, 'card-save'));
    wrap.append(controls);
    if (['mix', 'video'].includes(kindOf(item))) wrap.append(create('span', 'card-kind', kindOf(item) === 'video' ? 'VIDEO' : /radio/i.test(item.id || item.title || '') ? 'RADIO' : 'MIX'));
    const copy = create('div', 'card-copy');
    copy.append(button(titleOf(item), () => openItem(item), 'card-title-link'), create('small', '', item.subtitle || item.author || (kindOf(item) === 'artist' ? 'Artist' : item.count != null ? `${item.count} tracks` : '')));
    article.append(copy); return article;
  }
  function saveButton(item, className = 'row-icon save-button') {
    const b = iconButton(isSaved(item) ? `Remove ${titleOf(item)} from collection` : `Save ${titleOf(item)}`, 'heart', async () => { await toggleSave(item); updateSaveButton(b, item); }, className);
    updateSaveButton(b, item); return b;
  }
  function updateSaveButton(b, item) {
    b.classList.toggle('is-saved', isSaved(item));
    b.setAttribute('aria-pressed', String(isSaved(item)));
    b.setAttribute('aria-label', isSaved(item) ? `Remove ${titleOf(item)} from collection` : `Save ${titleOf(item)}`);
    b.title = b.getAttribute('aria-label');
  }
  async function toggleSave(item) {
    const kind = kindOf(item), was = isSaved(item);
    const response = await post('/api/platform/library', { operation: kind === 'artist' ? was ? 'unfollow' : 'follow' : was ? 'unsave' : 'save', kind, item });
    const type = savedKind(item); if (!current.saved.has(type)) current.saved.set(type, new Set());
    if (was) current.saved.get(type).delete(keyOf(item)); else current.saved.get(type).add(keyOf(item));
    item.saved = !was; item.favorited = !was; item.followed = !was;
    content.querySelectorAll('.platform-card,.compact-track,.track-table tr').forEach(el => { const other = domItems.get(el); if (other && keyOf(other) === keyOf(item)) { other.saved = !was; other.favorited = !was; other.followed = !was; el.querySelectorAll('.card-save,.save-button').forEach(b => updateSaveButton(b, other)); } });
    if (kind === 'playlist' && !was && (partialTrackSummary(response) || partialTrackSummary(item))) {
      const count = response.item?.tracks?.length ?? response.item?.count ?? item.tracks?.length ?? response.sourceReport?.returned ?? 0;
      player.showToast(`Saved ${count} available tracks · collection is incomplete`);
    } else player.showToast(kind === 'artist' ? was ? 'Artist unfollowed' : 'Following artist' : was ? 'Removed from collection' : 'Saved to collection');
    if (kind === 'playlist') await refreshSidebar();
    if (kind === 'track') void player.refreshState();
  }
  function authorButton(item, className = '') {
    return button(item.author || 'Unknown artist', () => goToArtist(item), className);
  }
  async function goToArtist(item){
    let name=String(item.author||item.artist||titleOf(item)).trim();
    if(item.artistId)return navigate({type:'detail',kind:'artist',id:item.artistId,name});
    let data;
    try{data=await post('/api/platform/artist',{track:item});name=data.query||name;}
    catch(_){data=await request(`/api/platform/search?q=${encodeURIComponent(name)}&type=artists`);}
    const items=data.items||data.sections?.flatMap(s=>s.items||[])||[];
    const norm=v=>String(v||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
    const exact=items.filter(value=>kindOf(value)==='artist'&&norm(titleOf(value))===norm(name));
    if(exact.length===1)return navigate({type:'detail',kind:'artist',id:exact[0].id,name:titleOf(exact[0])});
    return navigate({type:'search',query:name,searchType:'artists'});
  }
  function compactTrack(item, extra = {}) {
    const record = item.kind === 'download' ? item : null; if (record) item = { ...record.track, downloadRecord: record };
    const row = create('div', 'compact-track'); domItems.set(row, item);
    const art = create('div', 'compact-track-art'); art.append(image(item), iconButton(`Play ${titleOf(item)}`, 'play', () => playItem(item)));
    const copy = create('div', 'track-copy'); const title = create('strong'); title.append(button(titleOf(item), () => playItem(item), '')); if(item.explicit===true)title.append(create('span','explicit-badge','E'));const sub = create('small'); sub.append(authorButton(item)); copy.append(title, sub);
    const actions = create('div', 'row-actions');
    if (extra.remove) actions.append(iconButton(`Remove ${titleOf(item)} from queue`, 'close', extra.remove));
    else { actions.append(saveButton(item), iconButton(`More options for ${titleOf(item)}`, 'more', ev => showMenu(item, ev.currentTarget), 'row-icon menu-button')); }
    row.append(art, copy, actions); row.addEventListener('dblclick', () => void playItem(item)); return row;
  }
  function trackTable(items, options = {}) {
    const wrap = create('div', 'table-wrap');
    const table = create('table', 'track-table'); table.setAttribute('aria-label', options.label || 'Tracks');
    const head = create('thead'); const headings = create('tr');
    for (const title of ['#', 'TITLE', 'ARTIST', 'ALBUM', 'TIME', '']) headings.append(create('th', '', title));
    head.append(headings); const body = create('tbody'); table.append(head, body); wrap.append(table);
    let rendered = 0; let sentinel = null;
    const renderPage = () => {
      const fragment = document.createDocumentFragment();
      for (const item of items.slice(rendered, rendered + 70)) {
        const index = rendered++;
        const row = create('tr'); domItems.set(row, item);
        const pos = create('td', 'table-position'); pos.append(create('span', '', index + 1), iconButton(`Play ${titleOf(item)}`, 'play', () => playList(items.slice(index), false)));
        const titleCell = create('td'); const title = create('div', 'table-track'); title.append(image(item));
        const copy = create('div', 'track-copy'); const strong = create('strong'); strong.append(button(titleOf(item), () => playList(items.slice(index), false), ''));if(item.explicit===true)strong.append(create('span','explicit-badge','E'));const small = create('small', '', item.author || ''); copy.append(strong, small); title.append(copy); titleCell.append(title);
        const artist = create('td'); artist.append(authorButton(item, 'table-link'));
        const album = create('td'); if (item.album) album.append(button(typeof item.album === 'string' ? item.album : item.album.title || '', () => item.albumId ? navigate({ type: 'detail', kind: 'album', id: item.albumId, name: typeof item.album === 'string' ? item.album : item.album.title, artist: item.author }) : navigate({ type: 'search', query: typeof item.album === 'string' ? item.album : item.album.title, searchType: 'albums' }), 'table-link'));
        const duration = create('td', 'track-time', item.duration ? player.fmt(item.duration) : '');
        const actionCell = create('td'); const actions = create('div', 'row-actions'); actions.append(saveButton(item), iconButton(`More options for ${titleOf(item)}`, 'more', ev => showMenu(item, ev.currentTarget), 'row-icon menu-button')); actionCell.append(actions);
        row.append(pos, titleCell, artist, album, duration, actionCell);
        row.addEventListener('dblclick', () => void playList(items.slice(index), false));
        if (options.playlistId) domItems.set(row, { ...item, playlistId: options.playlistId, playlistIndex: index });
        fragment.append(row);
      }
      body.append(fragment);
      if (sentinel) { sentinel.remove(); sentinel = null; }
      if (rendered < items.length) {
        sentinel = create('div', 'table-paging');
        sentinel.append(button(`Show more · ${items.length - rendered} remaining`, renderPage, 'pill-button'));
        wrap.append(sentinel);
      }
    };
    renderPage(); return wrap;
  }
  function empty(title, description, action) {
    const e = create('div', 'empty-state'); e.innerHTML = svg('album'); e.append(create('strong', '', title), create('p', '', description)); if (action) e.append(action); return e;
  }
  function errorPane(err, retry) {
    const pane = empty('Music is taking a moment', err?.message || 'The provider is unavailable right now.', button('Try again', retry)); pane.setAttribute('role', 'status'); return pane;
  }
  function degraded(data,target) {
    if(!data?.degradedProviders?.length)return;
    const useful=data.items?.length||data.tracks?.length||data.sections?.some(section=>section.items?.length);
    if(!useful)target.append(button('Refresh results',()=>navigate(current.route,{replace:true}),'text-button catalog-retry'));
  }
  function section(data, grid = false) {
    const s = create('section', 'platform-section'); s.dataset.section = data.id || '';
    if (data.type === 'videos') s.classList.add('video-shelf');
    if ((data.items || []).some(x => x.videoPlaylist)) s.classList.add('video-playlist-shelf');
    const head = create('div', 'section-head'), heading = create('div', 'section-heading');
    heading.append(create('h2', '', data.title || 'Music')); if (data.subtitle) heading.append(create('p', '', data.subtitle));
    const tools = create('div', 'section-tools'); head.append(heading, tools); s.append(head);
    const items = Array.isArray(data.items) ? data.items : [];
    if (data.type === 'tracks') {
      const rows = create('div', 'compact-track-grid'); items.slice(0, grid ? 90 : phone.matches ? 6 : 12).forEach(item => rows.append(compactTrack(item))); s.append(rows);
      if (items.length > 6) tools.append(button('View all', () => openShelf(data), 'text-button'));
    } else {
      const shelf = create('div', grid ? 'card-grid' : 'card-shelf');
      items.slice(0, grid ? 180 : phone.matches && data.type !== 'videos' ? 4 : 30).forEach(item => shelf.append(card(data.type === 'artists' ? { ...item, kind: 'artist' } : item))); s.append(shelf);
      if (!grid && items.length) {
        tools.append(iconButton(`Previous ${data.title}`, 'left', () => { shelf.scrollBy({ left: -shelf.clientWidth * .8, behavior: reducedMotion.matches ? 'auto' : 'smooth' }); }, 'icon-button'), iconButton(`Next ${data.title}`, 'right', () => { shelf.scrollBy({ left: shelf.clientWidth * .8, behavior: reducedMotion.matches ? 'auto' : 'smooth' }); }, 'icon-button'), button('View all', () => openShelf(data), 'text-button'));
      }
    }
    if (!items.length) s.append(create('p', 'queue-empty', 'No music is available in this section yet.'));
    return s;
  }
  function openShelf(data) { navigate({ type: 'shelf', id: data.id || data.title, title: data.title }, { data }); }
  function shortcut(item) {
    const b = button('', () => openItem(item), 'shortcut'); b.append(image(item)); const copy = create('span'); copy.append(create('strong', '', titleOf(item)), create('small', '', item.author || item.subtitle || '')); b.append(copy); return b;
  }
  function homeTabs(tab) {
    const tabs = create('nav', 'home-tabs'); tabs.setAttribute('aria-label', 'Music');
    for (const [id, title] of [['for-you', 'For you'], ['staff', 'Staff Picks'], ['uploads', 'Uploads']]) tabs.append(button(title, () => navigate({ type: 'home', tab: id }), id === tab ? 'active' : ''));
    return tabs;
  }
  function pageHeader(title, {back=false, mobile=false, settings=false, stats=false}={}) {
    const head=create('div',mobile?'mobile-view-header':'page-view-header');
    if(back)head.append(iconButton('Back','left',()=>history.back(),'icon-button'));
    head.append(create('h1','',title));const actions=create('div','mobile-header-actions');
    if(stats)actions.append(iconButton('Your listening statistics','hires',()=>navigate({type:'stats'}),'icon-button'));
    if(settings)actions.append(iconButton('Account and settings','settings',openSettings,'icon-button'));
    head.append(actions);return head;
  }
  function renderHome(data, route, page) {
    page.append(pageHeader('Home',{mobile:true,settings:true}),homeTabs(route.tab || 'for-you'));
    const sections = Array.isArray(data.sections) ? data.sections.filter(value => value.items?.length) : [];
    const shortcuts = sections.find(s => s.id === 'shortcuts' || s.type === 'shortcuts');
    if (shortcuts) {
      const grid = create('div', 'shortcut-grid'), items=(shortcuts.items || []).slice(0,5);
      items.slice(0,4).forEach(item=>grid.append(shortcut(item)));
      const my=button('My Tracks',()=>navigate({type:'library',kind:'tracks'}),'shortcut shortcut-my-tracks','music');grid.append(my);
      if(items[4])grid.append(shortcut(items[4]));page.append(grid);
    }
    if (!sections.length) page.append(empty('Your next favorite starts here', 'Play or save a few tracks to build recommendations around your listening.', button('Explore music', () => navigate({ type: 'explore' }), 'pill-button primary')));
    for (const data of sections) if (data !== shortcuts) page.append(section(data));
  }
  function hasHomeSections(data) { return (data?.sections || []).some(value => Array.isArray(value.items) && value.items.length); }
  function mergeHomePayload(previous, next) {
    const oldSections = new Map((previous?.sections || []).map(value => [value.id, value]));
    const sections = (next?.sections || []).map(value => {
      const old = oldSections.get(value.id);
      oldSections.delete(value.id);
      return old?.items?.length && !value.items?.length ? old : value;
    });
    for (const value of oldSections.values()) if (value.items?.length) sections.push(value);
    return { ...previous, ...next, sections };
  }
  function paintHomeUpdate(data, route, seq, signal, previous) {
    if (seq !== current.seq || signal.aborted || current.route.type !== 'home'
        || (current.route.tab || 'for-you') !== 'for-you') return previous;
    const updated = mergeHomePayload(previous, data);
    if (!hasHomeSections(updated) && hasHomeSections(current.data)) return current.data;
    const scrollTop = content.scrollTop;
    current.data = updated;
    const page = create('div', 'platform-page');
    renderHome(updated, route, page);
    content.replaceChildren(page);
    content.scrollTop = scrollTop;
    content.setAttribute('aria-busy', 'false');
    return updated;
  }
  async function refreshHomeStages({ data, route, seq, signal }) {
    let visible = data;
    if (!data?.staleSnapshot) {
      try {
        const featured = await request('/api/platform/home?tab=for-you&stage=featured', { signal, timeout: 10000 });
        if (hasHomeSections(featured)) visible = paintHomeUpdate(featured, route, seq, signal, visible);
        else visible = paintHomeUpdate(visible, route, seq, signal, visible);
      } catch (_) {
        // Keep the loading skeleton until the featured wait ends, then show the
        // best local fallback without surfacing provider errors to listeners.
        visible = paintHomeUpdate(visible, route, seq, signal, visible);
      }
    }
    try {
      const full = await request('/api/platform/home?tab=for-you&stage=full', { signal });
      paintHomeUpdate(full, route, seq, signal, visible);
    } catch (_) { /* Keep the best home already rendered; provider recovery continues next visit. */ }
  }
  function renderExplore(data, route, page) {
    if(route.mode==='videos'){page.classList.add('videos-page');page.append(pageHeader('Videos',{back:true}));degraded(data,page);for(const s of data.sections||[])page.append(section(s));return;}
    const category=route.genre||route.mood||route.decade;
    if(category||route.mode){
      page.classList.add('category-page');page.dataset.category=category||route.mode;
      page.append(pageHeader(data.title||category||({new:'New',top:'Top',clean:'Clean Content'})[route.mode]||'Explore',{back:true}));
      degraded(data,page);const rows=(data.sections||[]).filter(section=>section.items?.length);for(const row of rows)page.append(section(row));
      if(!rows.length)page.append(empty('More music is on its way','Try another category or refresh the results.',button('Refresh',()=>navigate(route,{replace:true}),'pill-button')));
      return;
    }
    if(!phone.matches || route.mode)page.append(pageHeader(route.mode ? ({ new: 'New', top: 'Top', atmos:'Dolby Atmos', hires: 'HiRes', clean: 'Clean Content' })[route.mode] || 'Explore' : 'Explore',{back:phone.matches&&Boolean(route.mode)}));
    const defaults = {
      genres: ['Hip-Hop', 'Pop', 'R&B / Soul', 'Rock / Indie', 'Dance & Electronic', 'Latin', 'Country', 'Jazz', 'Reggae / Dancehall', 'Classical', 'Metal', 'K-Pop', 'Blues', 'Gospel / Christian', 'Folk / Americana', 'Global'],
      moods: ['For DJs', 'Record Labels', 'Artist Experiences', 'Autumn', 'Sleep', 'Wellness', 'Workout', 'Celebration', 'Party', 'Relax', 'Focus', 'Happy'],
      decades: ['1950s', '1960s', '1970s', '1980s', '1990s', '2000s', '2010s', '2020s']
    };
    for (const [key, label, param] of [['genres', 'Genres', 'genre'], ['moods', 'Moods, Activities & Events', 'mood'], ['decades', 'Decades', 'decade']]) {
      const facet = create('section', 'facet-section'), head = create('div', 'section-head'); head.append(create('h2', '', label)); facet.append(head);
      const chips = create('div', 'facet-chips');
      const values = defaults[key];
      const facetAction = value => button(value, () => navigate({type:'explore',[param]:value}),
        `facet-chip${route[param] === value ? ' active' : ''}`);
      values.forEach(value => chips.append(facetAction(value)));
      facet.append(chips); page.append(facet);
    }
    const modes = create('div', 'explore-modes');
    for (const [mode, label] of [['new', 'New'], ['top', 'Top'], ['videos', 'Videos'], ['clean', 'Clean Content']]) {const b=button(label, () => navigate({ ...route, type: 'explore', mode: route.mode === mode ? '' : mode }), `explore-mode${route.mode === mode ? ' active' : ''}`, mode === 'videos' ? 'video' : mode);b.dataset.mode=mode;modes.append(b);}
    page.append(modes); degraded(data, page);
    if (route.genre || route.mood || route.decade) page.append(create('p', 'platform-notice', `Exploring ${[route.genre, route.mood, route.decade].filter(Boolean).join(' · ')}.`));
    if (route.mode === 'hires') page.append(create('p', 'platform-notice', 'The catalog shows formats reported by the source. Playback quality depends on the available stream.'));
    if(data.availability?.message)page.append(create('p','platform-notice',data.availability.message));
    if(!phone.matches||route.mode||route.genre||route.mood||route.decade)for (const s of data.sections || []) page.append(section(s));
  }
  function renderSearch(data, route, page) {
    if(!route.query || route.query.length<2){renderExplore(data,{type:'explore'},page);return;}
    page.append(create('h1', 'search-result-title', `Results for “${route.query}”`));
    const tabs = create('nav', 'home-tabs search-result-tabs');
    for (const [type, label] of [['all', 'All'], ['tracks', 'Tracks'], ['albums', 'Albums'], ['artists', 'Artists'], ['videos', 'Videos']]) tabs.append(button(label, () => navigate({ ...route, searchType: type }, { replace: true }), (route.searchType || 'all') === type ? 'active' : ''));
    page.append(tabs); degraded(data, page);
    if (!route.query || route.query.length < 2) { page.append(empty('Find your next favorite', 'Search for tracks, artists, albums and music videos.')); return; }
    if (data.sections?.length) { data.sections.forEach(s => page.append(section(s))); return; }
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) { page.append(empty('No results yet', 'Try a different title, artist or spelling.')); return; }
    const tracks = items.filter(i => kindOf(i) === 'track');
    if (tracks.length) { if ((route.searchType || 'all') === 'all') page.append(create('h2', '', 'Tracks')); page.append(trackTable(tracks)); }
    for (const kind of ['album', 'artist', 'video', 'mix', 'playlist']) {
      const group = items.filter(i => kindOf(i) === kind); if (group.length) page.append(section({ id: kind, title: ({ album: 'Albums', artist: 'Artists', video: 'Videos', mix: 'Mixes', playlist: 'Playlists' })[kind], type: kind === 'artist' ? 'artists' : 'cards', items: group }, true));
    }
  }
  function renderFeed(data, page) {
    if(phone.matches){
      page.classList.add('updates-page');page.append(pageHeader('Updates',{mobile:true}));degraded(data,page);
      const monthly=(data.sections||[]).find(s=>s.id==='monthly-listening')?.items||[],releases=(data.sections||[]).find(s=>s.id==='followed-releases')?.items||[];
      const rows=(title,items)=>{if(!items.length)return;page.append(create('h2','',title));const list=create('div','updates-list');items.forEach(item=>{const b=button('',()=>openItem(item),'update-row');b.append(image(item));const copy=create('span');copy.append(create('strong','',titleOf(item)),create('small','',item.subtitle||item.author||''));b.append(copy);list.append(b);});page.append(list);};
      rows('Your monthly listening',monthly);rows('Last week',releases.filter(x=>Date.now()-Date.parse(x.releaseDate)<7*86400000));rows('Older',releases.filter(x=>Date.now()-Date.parse(x.releaseDate)>=7*86400000));
      if(!monthly.length&&!releases.length)page.append(empty('Your updates start here','Listen to music and follow artists to receive monthly listening summaries and their new releases.',button('Your listening history',()=>navigate({type:'stats'}))));return;
    }
    page.append(create('h1', '', 'Feed'));
    const stats = button('', () => navigate({ type: 'stats' }), 'listening-banner'); stats.setAttribute('aria-label', 'Your listening history');
    const icon = create('span', 'listening-icon'); icon.innerHTML = svg('history'); const copy = create('span'); copy.append(create('strong', '', 'Your listening history'), create('small', '', 'The tracks and artists that made your month.')); stats.append(icon, copy); page.append(stats);
    degraded(data, page);
    if (!(data.sections || []).length) page.append(empty('Stay close to the music', 'Follow artists to see their latest releases here.', button('Find artists', () => navigate({ type: 'search', query: '', searchType: 'artists' }))));
    for (const s of data.sections || []) page.append(section(s));
  }
  function renderStats(data, page) {
    const month = /^\d{4}-\d{2}$/.test(data.month || '') ? new Date(`${data.month}-01T12:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'Your listening';
    page.append(create('h1', '', month));
    if (data.availableMonths?.length) {
      const select = create('select', 'month-select'); select.setAttribute('aria-label', 'Listening month');
      data.availableMonths.forEach(value => { const opt = create('option', '', new Date(`${value}-01T12:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })); opt.value = value; opt.selected = value === data.month; select.append(opt); });
      select.addEventListener('change', () => void navigate({ type: 'stats', month: select.value })); page.append(select);
    }
    const grid = create('div', 'stats-grid');
    for (const [value, title] of [[Number(data.totalPlays || 0).toLocaleString('en'), 'Tracks played'], [Math.round(Number(data.totalSeconds || 0) / 60).toLocaleString('en'), 'Minutes of music'], [(data.topArtists || []).length, 'Artists this month']]) { const b = create('div', 'stat-box'); b.append(create('strong', '', value), create('small', '', title)); grid.append(b); }
    page.append(grid);
    if (data.monthlyMix?.tracks?.length) { const actions = create('div', 'toolbar-actions'); actions.append(button('Play monthly mix', () => playList(data.monthlyMix.tracks), 'pill-button primary', 'play'), button('Queue monthly mix', () => playList(data.monthlyMix.tracks, true), 'pill-button', 'plus')); page.append(actions); }
    if (data.topArtists?.length) page.append(section({ id: 'top-artists', title: 'Your top artists', type: 'artists', items: data.topArtists.map(a => ({ ...a, kind: 'artist', subtitle: `${a.plays || a.count || 0} plays` })) }));
    if (data.topTracks?.length) { page.append(create('h2', '', 'Your most played tracks'), trackTable(data.topTracks.map(t => ({ ...t, kind: 'track' })), { label: 'Most played tracks' })); }
    if (!data.totalPlays) page.append(empty('A new month of music', 'Your listening will appear here as you play music.'));
  }
  function renderLibrary(data, route, page) {
    const kind = route.kind || 'tracks'; const titles = { tracks: 'Tracks', albums: 'Albums', artists: 'Artists', videos: 'Videos', mixes: 'Mixes & Radio', playlists: 'Playlists', profiles: 'Profiles', purchases: 'Purchases', uploads: 'Your uploads',downloads:'Downloads' };
    page.dataset.libraryKind = kind;
    const head=pageHeader(titles[kind]||'Collection',{back:phone.matches});page.append(head);
    const items = data.items || [];
    if (kind === 'playlists') {
      const actions = create('div', 'toolbar-actions'); actions.append(button('Create playlist', createPlaylist, 'pill-button primary', 'plus'), button('Import playlist', openImport, 'pill-button', 'download')); page.append(actions);
    } else if (kind === 'tracks' && items.length) {
      const actions = create('div', 'toolbar-actions library-actions'); actions.append(button(phone.matches?'Play':'Play tracks', () => playList(items), 'pill-button primary', 'play'), button(phone.matches?'Shuffle':'Shuffle tracks', () => playList(shuffled(items)), 'pill-button', 'shuffle'), button('Queue tracks', () => playList(items, true), 'pill-button queue-library', 'plus')); page.append(actions);
      const row=create('label','library-download-row','Download'),toggle=create('input');toggle.type='checkbox';toggle.setAttribute('aria-label','Download saved tracks');row.append(toggle);page.append(row);
      toggle.addEventListener('change',()=>{if(toggle.checked){toggle.disabled=true;void downloadItems(items,'My Tracks').catch(report).finally(()=>{toggle.disabled=false;toggle.checked=false;});}});
    }
    if (kind === 'profiles' || kind === 'purchases') {
      if (!items.length) {
        const external = create('div', 'external-links');
        for (const [title, href] of kind === 'purchases' ? [['Bandcamp purchases', 'https://bandcamp.com/'], ['Qobuz store', 'https://www.qobuz.com/']] : [['Spotify profile', 'https://open.spotify.com/']]) { const a = create('a', '', title); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; external.append(a); }
        page.append(empty(kind === 'purchases' ? 'Your purchased music' : 'Your music profiles', kind === 'purchases' ? 'Import music you own into your collection. Purchases are completed with the original music store.' : 'Visit your provider profile or import a public playlist into your collection.', external));
        if (kind === 'purchases') page.append(button('Import purchased music', () => navigate({ type: 'upload' }), 'pill-button'));
        return;
      }
    }
    if (!items.length) { page.append(empty(kind==='downloads'?'Your downloads':'Make this collection yours', kind === 'tracks' ? 'Save tracks with the heart button. Your favorites stay with your account.' : kind==='downloads'?'Completed audio transfers appear here. Download a recording from its options menu.':`Save ${kind === 'mixes' ? 'mixes and radio stations' : kind} while you explore your music.`, button('Explore music', () => navigate({ type: 'explore' })))); return; }
    const filter = create('label', `filter-field${kind === 'tracks' ? ' library-track-filter' : ''}`); filter.id = `collection-filter-${kind}`; filter.innerHTML = svg('search'); const input = create('input'); input.type = 'search'; input.placeholder = `Filter ${kind}`; input.setAttribute('aria-label', `Filter ${kind}`); filter.append(input); page.append(filter);
    const list = create('div'); page.append(list);
    let sort='recent';
    const render = () => { const term = input.value.trim().toLowerCase(); const filtered = items.filter(i => `${titleOf(i)} ${i.author || ''}`.toLowerCase().includes(term));if(sort==='title')filtered.sort((a,b)=>titleOf(a).localeCompare(titleOf(b)));if(sort==='artist')filtered.sort((a,b)=>(a.author||'').localeCompare(b.author||''));list.replaceChildren(); if (kind === 'tracks' || kind === 'uploads') list.append(trackTable(filtered));else if(kind==='downloads'){for(const item of filtered){const row=create('div','download-record');row.append(compactTrack(item),create('p','download-copy',`${item.quality||'Original source'} · ${(Number(item.bytes||0)/1024**2).toFixed(1)} MB · ${new Date(item.completedAt).toLocaleDateString('en')}`));list.append(row);}}else { const grid = create('div', 'card-grid'); filtered.slice(0, 240).forEach(i => grid.append(card(i))); list.append(grid); } };
    const search = iconButton(`Search ${kind}`, 'search', () => {
      if (phone.matches && kind === 'tracks') {
        const opened = filter.classList.toggle('is-open'); search.setAttribute('aria-expanded', String(opened));
        if (!opened) { input.value = ''; render(); return; }
      }
      input.focus();
    }, 'icon-button');
    search.setAttribute('aria-controls', filter.id); if (kind === 'tracks') search.setAttribute('aria-expanded', 'false');
    head.querySelector('.mobile-header-actions').append(search,iconButton(`Sort ${kind}`,'sort',()=>{openDialog(`Sort ${kind}`);for(const [id,title]of[['recent','Recently added'],['title','Title'],['artist','Artist']])dialogContent.append(button(title,()=>{sort=id;render();dialog.close();},'pill-button'));},'icon-button'));
    input.addEventListener('input', render); render();
  }
  function renderCollection(data,page){
    page.classList.add('collection-home');page.append(pageHeader('Collection',{mobile:true,settings:true,stats:true}));if(!phone.matches)page.append(create('h1','','Collection'));
    const links=create('nav','collection-links');links.setAttribute('aria-label','Your collection');
    for(const [kind,title,icon]of[['mixes','Mixes & Radio','radio'],['playlists','Playlists','queue'],['albums','Albums','album'],['purchases','Purchases','album'],['tracks','Tracks','music'],['videos','Videos','video'],['artists','Artists','artist'],['downloads','Downloads','download']])links.append(button(title,()=>navigate({type:'library',kind}),'',icon));page.append(links);
    if(data.items?.length)page.append(section({id:'recent-activity',title:'Recent activity',items:data.items}));
  }
  function detailSaveLabel(item) {
    const kind = kindOf(item); if (kind === 'artist') return isSaved(item) ? 'Following artist' : 'Follow artist';
    return `${isSaved(item) ? 'Saved' : 'Save'} ${kind === 'playlist' ? 'playlist' : kind === 'mix' ? 'mix' : kind === 'video' ? 'video' : 'album'}`;
  }
  function renderDetail(data, route, page) {
    const item = { ...data, kind: data.kind || route.kind || (route.type === 'mix' ? 'mix' : route.type === 'playlist' ? 'playlist' : 'album'), id: data.id || route.id };
    current.data = item;
    page.classList.toggle('artist-detail', kindOf(item) === 'artist');
    const hero = create('div', 'detail-hero');
    const { wrap } = artSurface(item, `detail-art${kindOf(item) === 'artist' ? ' artist' : ''}`); hero.append(wrap);
    const copy = create('div'); copy.append(create('div', 'detail-eyebrow', kindOf(item).toUpperCase()), create('h1', '', titleOf(item)));
    const byline = create('div', 'detail-byline');
    if (item.author && kindOf(item) !== 'artist') byline.append(authorButton(item));
    const availability = partialTrackSummary(item), report = item.tracksReport;
    if (item.tracks?.length) {
      const count = availability ? report?.totalKnown && report.total >= item.tracks.length ? `${item.tracks.length} of ${report.total} tracks` : `${item.tracks.length} available tracks` : `${item.tracks.length} tracks`;
      byline.append(document.createTextNode(`${item.author ? ' · ' : ''}${count} · ${player.fmt(item.tracks.reduce((total, t) => total + Number(t.duration || 0), 0))}`));
    }
    if (item.subtitle || item.description) byline.append(create('p', '', item.subtitle || item.description));
    copy.append(byline); hero.append(copy); page.append(hero);
    const artist=kindOf(item)==='artist',tracks=Array.isArray(item.tracks)?item.tracks:[];
    const playback=artist&&item.playbackTracks?.length?item.playbackTracks:tracks;
    const actions = create('div', 'toolbar-actions');
    if (playback.length) actions.append(button(artist?'Play artist':availability?'Play available tracks':kindOf(item)==='album'?'Play album':'Play all',()=>playList(artist?shuffled(playback):playback),'pill-button primary','play'),button(availability?'Shuffle available tracks':'Shuffle',()=>playList(shuffled(playback)),'pill-button','shuffle'),button(availability?'Add available tracks to queue':'Add to queue',()=>playList(playback,true),'pill-button','plus'));
    if (kindOf(item) === 'video') actions.append(button('Play video', () => playVideo(item), 'pill-button primary', 'play'));
    if (kindOf(item) !== 'playlist' || isProviderPlaylist(item)) {
      const save = button(detailSaveLabel(item), async () => { save.disabled = true; try { await toggleSave(item); save.querySelector('span').textContent = detailSaveLabel(item); save.setAttribute('aria-pressed', String(isSaved(item))); } finally { save.disabled = false; } }, 'pill-button detail-save', kindOf(item) === 'artist' ? 'plus' : 'heart'); save.setAttribute('aria-pressed', String(isSaved(item))); actions.append(save);
    }
    actions.append(iconButton(`More options for ${titleOf(item)}`, 'more', ev => showMenu(item, ev.currentTarget), 'icon-button'));
    if (isLocalPlaylist(item)) actions.append(button('Rename', () => renamePlaylist(item), 'text-button'), button('Delete playlist', () => deletePlaylist(item), 'text-button'));
    page.append(actions);
    if (availability) { const notice = create('p', 'platform-notice track-report', availability); notice.setAttribute('role', 'status'); page.append(notice); }
    if (item.reason || item.reasons?.length) page.append(create('p', 'platform-notice', item.reason || item.reasons.join(' · ')));
    if (tracks.length) { if (artist) page.append(create('h2', '', 'Popular tracks')); page.append(trackTable(artist?tracks.slice(0,10):tracks, { label: artist ? 'Popular tracks' : `${titleOf(item)} tracks`, playlistId: route.type === 'playlist' ? item.id : '' })); }
    else if (!item.albums?.length && kindOf(item) !== 'video') page.append(empty('No tracks available', 'The provider has not supplied playable tracks for this collection.'));
    if (item.albums?.length) page.append(section({ id: 'artist-albums', title: 'Albums', type: 'cards', items: item.albums }));
    if(item.epsAndSingles?.length)page.append(section({id:'artist-eps-singles',title:'EPs & Singles',items:item.epsAndSingles}));
    if(item.otherVersions?.length)page.append(section({id:'album-other-versions',title:'Other versions',items:item.otherVersions}));
    if(item.appearsOn?.length)page.append(section({id:'artist-appears-on',title:'Appears on',items:item.appearsOn}));
    if(item.creditedTracks?.length){page.append(create('h2','','Contributed recordings'),trackTable(item.creditedTracks,{label:'Contributed recordings'}));}
    if(item.discographyPartial)page.append(create('p','track-report','Some releases are still loading. Refresh to retrieve more.'));
    if (item.artists?.length) page.append(section({ id: 'related-artists', title: 'Related artists', type: 'artists', items: item.artists }));
    if (item.videos?.length) page.append(section({ id: 'artist-videos', title: 'Videos', type: 'cards', items: item.videos }));
    if (item.bio) { page.append(create('h2', '', 'About'), create('p', 'detail-bio', item.bio)); }
    if (hasCredits(item.credits)) { page.append(create('h2', '', 'Credits'), credits(item.credits)); }
  }
  async function recordingCredits(item) {
    if(item?.id){try{const value=await request(`/api/platform/detail?kind=${encodeURIComponent(kindOf(item)==='album'?'album':kindOf(item)==='video'?'video':'track')}&id=${encodeURIComponent(item.id)}`);if(hasCredits(value.credits))return value.credits;}catch(_){} }
    if(hasCredits(item?.credits))return item.credits;
    try{const value=await post('/api/platform/credits',{track:item},{timeout:25000});if(hasCredits(value.credits))return value.credits;}catch(_){}
    if(item?.albumId){try{const value=await request(`/api/platform/detail?kind=album&id=${encodeURIComponent(item.albumId)}`);if(hasCredits(value.credits))return {...value.credits,scope:'album'};}catch(_){} }
    return [];
  }
  function hasCredits(value) { return Array.isArray(value) ? value.length > 0 : Boolean(value && (value.label || value.copyright || value.contributors?.length || value.labels?.length)); }
  function credits(value) {
    const grid = create('div', 'detail-credit-grid');
    if(value?.scope==='album')grid.append(create('p','credits-scope','Album credits · The provider has not supplied recording-specific credits.'));
    let items = value;
    if (!Array.isArray(value)) {
      items = [...(value?.contributors || [])];
      if (value?.label) items.unshift({ role: 'Record label', name: value.label });
      for (const label of value?.labels || []) items.push({ role: 'Record label', name: [label.title, label.catalogNumber].filter(Boolean).join(' · ') });
      if (value?.copyright) items.push({ role: 'Copyright', name: value.copyright });
    }
    for (const item of items || []) { const entry = create('div'); if (typeof item === 'string') entry.append(create('span', '', item)); else {entry.append(create('small','',item.role||item.type||'Contributor'));const name=item.name||item.title||item.value||'';entry.append(item.artistId||item.id?button(name,()=>{dialog.close();return navigate({type:'detail',kind:'artist',id:item.artistId||item.id});},'credit-person'):create('span','',name));} grid.append(entry); }
    return grid;
  }
  function externalLink(title, href) {
    const a = create('a', 'pill-button', title);
    try { const u = new URL(href, location.origin); if (!['http:', 'https:'].includes(u.protocol)) return create('span'); a.href = u.href; } catch (_) { return create('span'); }
    a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
  }
  function shuffled(items) { const list = [...items]; for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } return list; }

  function closeFullPlayer() { q('#stage').hidden = true; content.hidden = false; document.body.classList.remove('full-player-open'); current.fullSeq++; q('#fullPlayerPanels').hidden = false; void player.setView('player'); }
  function closeMobileNav() { document.body.classList.remove('mobile-nav-open'); q('#navScrim').hidden = true; q('#mobileNavToggle').setAttribute('aria-expanded', 'false'); }
  function routeURL(route) {
    const url = new URL('/player', location.origin); url.searchParams.set('view', ({ home: 'music', library: 'collection' })[route.type] || route.type);
    for (const key of ['tab', 'kind', 'id', 'query', 'searchType', 'genre', 'mood', 'decade', 'mode', 'seed', 'month','name']) if (route[key]) url.searchParams.set(key === 'query' ? 'q' : key, route[key]);
    return `${url.pathname}${url.search}`;
  }
  function parseRoute() {
    const p = new URLSearchParams(location.search), view = p.get('view') || 'music';
    const type = ({ music: 'home', discover: 'home', collection: p.get('kind') ? 'library' : 'collection', playlists: 'library', history: 'stats', player: 'home', lyrics: 'home', queue: 'home' })[view] || (['home', 'explore', 'feed', 'upload', 'search', 'detail', 'mix', 'playlist', 'stats','collection'].includes(view) ? view : 'home');
    const route = { type }; for (const key of ['tab', 'kind', 'id', 'searchType', 'genre', 'mood', 'decade', 'mode', 'seed', 'month','name']) if (p.get(key)) route[key] = p.get(key);
    if (p.get('q')) route.query = p.get('q'); if (view === 'playlists') route.kind = 'playlists'; if (type === 'home') route.tab ||= 'for-you'; if (type === 'library') route.kind ||= 'tracks'; return route;
  }
  function updateNavigation(route) {
    q('#platformNav').querySelectorAll('[data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === route.type && (b.dataset.kind ? b.dataset.kind === route.kind : true)));
    q('#collectionToggle').classList.toggle('active', ['collection','library', 'playlist'].includes(route.type));
    content.dataset.route = route.type; document.body.dataset.route = route.type; document.body.dataset.mode = route.mode || '';document.body.dataset.category=String(Boolean(route.genre||route.mood||route.decade||route.mode));
    const nav=['library','playlist','stats','collection'].includes(route.type)?'collection':['search','explore','detail','shelf','mix'].includes(route.type)?'search':route.type;
    q('#mobileBottomNav').querySelectorAll('button').forEach(b=>{const active=b.dataset.mobileNav===nav;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    if (route.type === 'search') {q('#searchInput').value = route.query || '';if(document.activeElement!==q('#mobileSearchInput'))q('#mobileSearchInput').value=route.query||'';}
  }
  async function navigate(route, options = {}) {
    if(q('#videoDialog').open)closeVideo();
    current.abort?.abort(); const abort = new AbortController(); current.abort = abort;
    const seq = ++current.seq; current.route = { ...route }; current.data = null;
    resetCardMotion(); closeMenu(); closeMobileNav(); closeFullPlayer();
    updateNavigation(route); content.setAttribute('aria-busy', 'true'); content.scrollTop = 0;
    if (!options.history) {
      try { history[options.replace ? 'replaceState' : 'pushState']({ platform: route }, '', routeURL(route)); } catch (_) {}
    }
    const loading = create('div');
    if (route.type === 'home') { loading.append(homeTabs(route.tab || 'for-you')); for (let n = 0; n < 3; n++) { const shelf = create('div', 'skeleton-shelf'); for (let i = 0; i < 6; i++) shelf.append(create('span', 'skeleton-card')); loading.append(shelf); } }
    else loading.append(create('div', 'platform-loading', 'Loading music…'));
    content.replaceChildren(loading);
    const signal = abort.signal;
    let data, backgroundHome = false;
    try {
      switch (route.type) {
        case 'home':
          if ((route.tab || 'for-you') === 'for-you') {
            data = await request(`/api/platform/home?tab=for-you&stage=initial`, { signal });
            backgroundHome = true;
          } else data = await request(`/api/platform/home?tab=${encodeURIComponent(route.tab)}`, { signal });
          break;
        case 'explore': { const search = new URLSearchParams(); for (const key of ['genre', 'mood', 'decade', 'mode']) if (route[key]) search.set(key, route[key]); data = await request(`/api/platform/explore?${search}`, { signal }); break; }
        case 'search': data = (route.query || '').trim().length < 2 ? await request('/api/platform/explore',{signal}) : await request(`/api/platform/search?q=${encodeURIComponent(route.query)}&type=${encodeURIComponent(route.searchType || 'all')}`, { signal }); break;
        case 'feed': data = await request('/api/platform/feed', { signal }); break;
        case 'stats': data = await request(`/api/platform/stats${route.month ? `?month=${encodeURIComponent(route.month)}` : ''}`, { signal }); break;
        case 'detail': data = await request(`/api/platform/detail?kind=${encodeURIComponent(route.kind)}&id=${encodeURIComponent(route.id)}&name=${encodeURIComponent(route.name||'')}&artist=${encodeURIComponent(route.artist||'')}`, { signal }); break;
        case 'mix': data = await request(`/api/platform/mix?id=${encodeURIComponent(route.id || 'radio')}${route.seed ? `&seed=${encodeURIComponent(route.seed)}` : ''}`, { signal }); break;
        case 'playlist': { const lists = await refreshSidebar(); const list = lists.find(p => p.id === route.id); data = { ...list, id: route.id, title: list?.name || 'Playlist', kind: 'playlist', ...(await request(`/api/collection?kind=${encodeURIComponent(`playlist:${route.id}`)}`, { signal })) }; break; }
        case 'library':
          if (route.kind === 'playlists') { const lists = await refreshSidebar(); data = { items: lists.map(p => ({ ...p, title: p.name, kind: 'playlist' })) }; }
          else data = await request(`/api/platform/library?kind=${encodeURIComponent(route.kind || 'tracks')}`, { signal });
          break;
        case 'collection': {
          const values=await Promise.all(['albums','tracks','mixes'].map(kind=>request(`/api/platform/library?kind=${kind}`,{signal}).catch(()=>({items:[]}))));
          data={items:values.flatMap(x=>x.items||[]).sort((a,b)=>String(b.savedAt||'').localeCompare(String(a.savedAt||''))).slice(0,8)};break;
        }
        case 'upload': data = await request('/api/platform/library?kind=uploads', { signal }); break;
        case 'shelf': data = options.data || current.shelf; break;
        default: data = { sections: [] };
      }
      if (seq !== current.seq || signal.aborted) return;
      current.data = data;
      if (route.type === 'library' && route.kind !== 'playlists') current.saved.set(route.kind, new Set((data.items || []).map(keyOf)));
      const page = create('div', 'platform-page');
      if (route.type === 'home') renderHome(data, route, page);
      if (route.type === 'explore') renderExplore(data, route, page);
      if (route.type === 'search') renderSearch(data, route, page);
      if (route.type === 'feed') renderFeed(data, page);
      if (route.type === 'stats') renderStats(data, page);
      if (route.type === 'library') renderLibrary(data, route, page);
      if (route.type === 'collection') renderCollection(data,page);
      if (['detail', 'mix', 'playlist'].includes(route.type)) renderDetail(data, route, page);
      if (route.type === 'upload') renderUpload(data, page);
      if (route.type === 'shelf') { current.shelf = data; page.append(create('h1', '', route.title || data?.title || 'Music')); if (data?.type === 'tracks') page.append(trackTable(data.items || [])); else page.append(section(data || { items: [] }, true)); }
      const waitForFeaturedHome = backgroundHome && !data?.staleSnapshot;
      if (!waitForFeaturedHome) {
        content.replaceChildren(page);
        content.setAttribute('aria-busy', 'false');
      }
      if (backgroundHome) {
        void refreshHomeStages({ data, route, seq, signal });
      }
    } catch (err) {
      if (seq !== current.seq || err.name === 'AbortError') return;
      if (route.type === 'home') {
        const fallback = { title: 'For you', sections: [], backgroundLoading: true };
        current.data = fallback;
        if ((route.tab || 'for-you') === 'for-you') {
          void refreshHomeStages({ data: fallback, route, seq, signal });
          return;
        }
        const page = create('div', 'platform-page');
        renderHome(fallback, route, page);
        content.replaceChildren(page);
        content.setAttribute('aria-busy', 'false');
        return;
      }
      content.replaceChildren(errorPane(err, () => navigate(route, { replace: true }))); content.setAttribute('aria-busy', 'false');
    }
  }

  async function refreshSidebar() {
    const data = await request('/api/playlists'); current.playlists = data.playlists || [];
    current.saved.set('playlists', new Set(current.playlists.flatMap(list => [keyOf({ kind: 'playlist', id: list.id }), ...(list.sourceId ? [keyOf({ kind: 'playlist', id: list.sourceId })] : [])])));
    const detailSave = content.querySelector('.detail-save');
    if (detailSave && kindOf(current.data) === 'playlist') { detailSave.querySelector('span').textContent = detailSaveLabel(current.data); detailSave.setAttribute('aria-pressed', String(isSaved(current.data))); }
    const target = q('#playlistSidebar'); target.replaceChildren();
    const lists = [...current.playlists].sort((a, b) => current.sortAscending ? (a.name || '').localeCompare(b.name || '') : (b.name || '').localeCompare(a.name || ''));
    for (const list of lists) { const b = button('', () => navigate({ type: 'playlist', id: list.id }), ''); if (list.thumbnail) b.append(image(list)); b.append(create('span', '', list.name || 'Playlist')); target.append(b); }
    if (!lists.length) target.append(create('span', 'sidebar-empty', 'Your playlists will appear here.'));
    return current.playlists;
  }
  async function openItem(item) {
    const kind = kindOf(item);
    if (kind === 'video') return playVideo(item);
    if (kind === 'playlist') return isProviderPlaylist(item) ? navigate({ type: 'detail', kind: 'playlist', id: item.id, name: titleOf(item), artist: item.author || '' }) : navigate({ type: 'playlist', id: item.id });
    if (kind === 'mix') {
      const month = String(item.id || '').match(/(?:monthly[-:]|month[-:])(\d{4}-\d{2})/); if (month) return navigate({ type: 'stats', month: month[1] });
      return navigate({ type: 'mix', id: item.id || 'radio', seed: serializeSeed(item.seed) });
    }
    if (['artist', 'album'].includes(kind)) return item.id ? navigate({ type: 'detail', kind, id: item.id, name:titleOf(item), artist:item.author||'' }) : navigate({ type: 'search', query: titleOf(item), searchType: kind === 'artist' ? 'artists' : 'albums' });
    return playItem(item);
  }
  async function getItemTracks(item) {
    const kind = kindOf(item); let data;
    if (kind === 'mix') data = await request(`/api/platform/mix?id=${encodeURIComponent(item.id || 'radio')}${item.seed ? `&seed=${encodeURIComponent(serializeSeed(item.seed))}` : ''}`);
    else if (item.tracks?.length) return item.tracks;
    else if (kind === 'playlist') data = isProviderPlaylist(item) ? await request(`/api/platform/detail?kind=playlist&id=${encodeURIComponent(item.id)}&name=${encodeURIComponent(titleOf(item))}&artist=${encodeURIComponent(item.author||'')}`) : await request(`/api/collection?kind=${encodeURIComponent(`playlist:${item.id}`)}`);
    else if (['album', 'artist'].includes(kind) && item.id) data = await request(`/api/platform/detail?kind=${kind}&id=${encodeURIComponent(item.id)}&name=${encodeURIComponent(titleOf(item))}&artist=${encodeURIComponent(item.author||'')}`);
    return kind==='artist'&&data?.playbackTracks?.length?data.playbackTracks:data?.tracks||[];
  }
  async function playItem(item, queue = false) {
    if(item.kind==='download')item={...item.track,downloadRecord:item};
    if (kindOf(item) === 'video' && !queue) return playVideo(item);
    if (['album', 'artist', 'mix', 'playlist'].includes(kindOf(item))) return playList(await getItemTracks(item), queue, {title:titleOf(item),route:kindOf(item)==='mix'?{type:'mix',id:item.id,seed:serializeSeed(item.seed)}:kindOf(item)==='playlist'&&!isProviderPlaylist(item)?{type:'playlist',id:item.id}:{type:'detail',kind:kindOf(item),id:item.id}});
    if(!queue)setPlayingContext();
    const response = await post('/api/action', { action: queue ? 'queueTrack' : 'playTrack', track: item }); player.renderState(response);
    player.showToast(queue ? 'Added to queue' : 'Now playing');
  }
  async function playList(items, queue = false, context) {
    if (!items.length) return player.showToast('There are no playable tracks here yet.');
    if(!queue)setPlayingContext(context);
    if(!queue&&kindOf(items[0])==='video'){current.videoQueue=items.filter(i=>kindOf(i)==='video');current.videoIndex=0;return playVideo(items[0],true);}
    const response = await post('/api/action', { action: queue ? 'queueTracks' : 'playTracks', tracks: items.slice(0, 1000) }); player.renderState(response);
    player.showToast(queue ? 'Added to queue' : 'Now playing');
  }
  function setPlayingContext(value) {
    current.playingContext=value||{title:current.data?.title||({home:'For you',library:current.route?.kind==='tracks'?'My Tracks':'Your collection',search:'Search results',explore:'Explore'})[current.route?.type]||'Your queue',route:{...current.route}};
    q('#playingContext span').textContent=current.playingContext.title;
  }
  async function shareItem(item) {
    if(!item)return player.showToast('Choose a recording to share');
    const raw=item.linkedOriginalUrl||item.providerUrl||item.url;let url;try{url=new URL(raw);if(!['https:','http:'].includes(url.protocol))throw new Error();}catch(_){return player.showToast('This recording has no public provider link.');}
    if(item.source==='upload'||item.provider==='local-upload'||/(?:^|\.)invalid$/.test(url.hostname))return player.showToast('Your uploads stay private. Share the original file from your device.');
    if(navigator.share){try{await navigator.share({title:`${item.author||''} — ${titleOf(item)}`,url:url.href});return;}catch(e){if(e.name==='AbortError')return;}}
    try{await navigator.clipboard.writeText(url.href);player.showToast('Recording link copied');}
    catch(_){openDialog('Share recording');const f=field('Recording link','shareRecordingUrl');f.input.value=url.href;f.input.readOnly=true;dialogContent.append(f.wrapper);f.input.focus();f.input.select();}
  }
  async function downloadItems(items,title='Audio') {
    if(!items?.length)return player.showToast('Choose music to download');
    const tracks=items.map(i=>i.kind==='download'?i.track:i).slice(0,1000),controller=new AbortController();openDialog(tracks.length>1?'Download your tracks':'Download original audio');
    dialogContent.append(create('p','',tracks.length>1?`Preparing ${tracks.length} original audio files in one ZIP. Keep this page open while the sources are prepared.`:'The file keeps the available source codec and quality.'));
    const status=create('div','download-progress-status','Preparing audio…'),cancel=button('Cancel',()=>{controller.abort();dialog.close();},'pill-button');dialogContent.append(status,cancel);
    const close=()=>controller.abort();dialog.addEventListener('close',close,{once:true});
    try{
      const result=await post('/api/platform/download',tracks.length>1?{tracks,title}:{track:tracks[0]},{signal:controller.signal,timeout:tracks.length>1?60*60*1000:mediaPrepareTimeout});controller.signal.throwIfAborted();
      status.textContent=`Ready · ${result.quality||'Original source'} · ${(Number(result.bytes)/1024**2).toFixed(1)} MB`;
      const link=create('a','pill-button primary',`Save ${result.filename}`);link.href=authenticatedMediaURL(result.url);link.download=result.filename;dialogContent.insertBefore(link,cancel);cancel.querySelector('span').textContent='Close';link.click();player.showToast('Download started');
    }catch(e){if(e.name==='AbortError')return;status.textContent=e.message;throw e;}
    finally{dialog.removeEventListener('close',close);}
  }

  function closeMenu() { menu.hidden = true; menu.replaceChildren(); }
  function showMenu(item, anchor) {
    const downloadRecord=item.downloadRecord;
    closeMenu();
    const kind = kindOf(item); const add = (label, icon, action) => menu.append(button(label, async () => { closeMenu(); await action(); }, '', icon));
    add(kind === 'video' ? 'Play video' : 'Play', 'play', () => playItem(item));
    add('Add to play queue', 'queue', () => playItem(item, true));
    if (['track', 'video'].includes(kind)) add('Add to playlist', 'plus', () => addToPlaylist(item));
    if (kind !== 'playlist' || isProviderPlaylist(item)) add(kind === 'artist' ? isSaved(item) ? 'Unfollow artist' : 'Follow artist' : isSaved(item) ? 'Remove from collection' : 'Save to collection', 'heart', () => toggleSave(item));
    menu.append(create('hr'));
    if (item.author && kind !== 'artist') add('Go to artist', 'artist', () => goToArtist(item));
    if (item.albumId || item.album) add('Go to album', 'album', () => item.albumId ? navigate({ type: 'detail', kind: 'album', id: item.albumId, name: typeof item.album === 'string' ? item.album : item.album?.title, artist: item.author }) : navigate({ type: 'search', query: typeof item.album === 'string' ? item.album : item.album?.title, searchType: 'albums' }));
    add('Start radio', 'radio', () => navigate({ type: 'mix', id: 'radio', seed: JSON.stringify(item) }));
    if (['track', 'video'].includes(kind)) {
      if (item.url || item.metadataOnly) add('Download original audio', 'download', () => downloadItems([item],titleOf(item)));
      add('Share recording','share',()=>shareItem(item));
      add('Credits', 'artist', () => showCredits(item));
      add('Less like this', 'hide', () => sendFeedback(item, 'dislike'));
      add('Hide this recommendation', 'hide', () => sendFeedback(item, 'hide'));
    }
    if(downloadRecord)add('Remove download history','close',async()=>{await post('/api/platform/library',{operation:'removeDownload',id:downloadRecord.id});await navigate({type:'library',kind:'downloads'},{replace:true});});
    if(item.source==='upload')add('Remove uploaded recording','close',async()=>{if(await player.confirmChange('Remove uploaded recording?',`Remove “${titleOf(item)}” from your account?`)){await post('/api/platform/library',{operation:'removeUpload',id:item.id,item});await navigate({type:'upload'},{replace:true});}});
    if (isLocalPlaylist(item)) { add('Rename playlist', 'lyrics', () => renamePlaylist(item)); add('Delete playlist', 'close', () => deletePlaylist(item)); }
    if (item.playlistId != null) add('Remove from playlist', 'close', async () => { await post('/api/library', { operation: 'removeFromPlaylist', id: item.playlistId, index: item.playlistIndex }); await navigate({ type: 'playlist', id: item.playlistId }, { replace: true }); });
    const parent=document.fullscreenElement||[...document.querySelectorAll('dialog[open]')].at(-1)||document.body;
    parent.append(menu);
    const rect = anchor.getBoundingClientRect(); menu.hidden = false;
    const width = menu.offsetWidth, height = menu.offsetHeight;
    menu.style.left = `${Math.max(10, Math.min(innerWidth - width - 10, rect.right - width))}px`;
    menu.style.top = `${Math.max(10, Math.min(innerHeight - height - 95, rect.bottom + 6))}px`;
    menu.querySelector('button')?.focus({ preventScroll: true });
  }
  async function sendFeedback(item, value) {
    await post('/api/platform/library', { operation: 'feedback', kind: kindOf(item), item, value, reason: value === 'hide' ? 'not-interested' : 'less-like-this' });
    content.querySelectorAll('.platform-card,.compact-track').forEach(el => { const other = domItems.get(el); if (other && keyOf(other) === keyOf(item)) el.remove(); });
    player.showToast(value === 'hide' ? 'Recommendation hidden' : 'We will recommend less like this');
  }
  async function showCredits(item) {
    openDialog('Credits');
    const seq=current.dialogSeq;
    const loading = create('p', '', 'Loading credits…'); dialogContent.append(loading);
    try {
      const value=await recordingCredits(item);
      if(!dialog.open||seq!==current.dialogSeq)return;
      loading.remove();
      if (hasCredits(value)) dialogContent.append(credits(value));
      else dialogContent.append(create('p', '', 'Credits are not available for this recording yet.'));
    } catch (err) { if(dialog.open&&seq===current.dialogSeq)loading.textContent = err.message; }
  }
  function openDialog(title) { current.dialogSeq=(current.dialogSeq||0)+1;dialogContent.replaceChildren(create('h2', '', title));(document.fullscreenElement||document.body).append(dialog);if (!dialog.open) dialog.showModal();return dialogContent; }
  function field(label, id, type = 'text') { const wrapper = create('label', '', label), input = create(type === 'textarea' ? 'textarea' : 'input'); input.id = id; if (type !== 'textarea') input.type = type; wrapper.append(input); return { wrapper, input }; }
  function submitButton(title, handler) {
    const status = create('div', 'dialog-status'); status.setAttribute('role', 'status');
    const b = button(title, async () => { b.disabled = true; status.textContent = ''; try { await handler(status); } catch (err) { status.textContent = err.message; } finally { b.disabled = false; } }, 'pill-button primary');
    dialogContent.append(b, status); return b;
  }
  function createPlaylist() {
    openDialog('Create playlist'); dialogContent.append(create('p', '', 'A new home for your favorite tracks.'));
    const { wrapper, input } = field('Playlist name', 'newPlaylistName'); input.maxLength = 80; dialogContent.append(wrapper);
    submitButton('Create playlist', async () => { if (!input.value.trim()) throw new Error('Give your playlist a name.'); await post('/api/library', { operation: 'createPlaylist', name: input.value.trim() }); dialog.close(); await refreshSidebar(); player.showToast('Playlist created'); if (current.route.type === 'library' && current.route.kind === 'playlists') await navigate(current.route, { replace: true }); }); input.focus();
  }
  function renamePlaylist(item) {
    openDialog('Rename playlist'); const { wrapper, input } = field('Playlist name', 'renamePlaylistName'); input.value = item.name || item.title || ''; input.maxLength = 80; dialogContent.append(wrapper);
    submitButton('Save name', async () => { if (!input.value.trim()) throw new Error('Give your playlist a name.'); await post('/api/library', { operation: 'renamePlaylist', id: item.id, name: input.value.trim() }); dialog.close(); await refreshSidebar(); await navigate({ type: 'playlist', id: item.id }, { replace: true }); }); input.focus();
  }
  async function deletePlaylist(item) {
    if (!await player.confirmChange('Delete playlist?', `Delete “${titleOf(item)}” and its track list?`)) return;
    await post('/api/library', { operation: 'deletePlaylist', id: item.id }); await refreshSidebar(); await navigate({ type: 'library', kind: 'playlists' }); player.showToast('Playlist deleted');
  }
  async function addToPlaylist(item) {
    const lists = await refreshSidebar(); openDialog('Add to playlist'); dialogContent.append(create('p', '', titleOf(item)));
    if (!lists.length) { dialogContent.append(create('p', '', 'Create a playlist to start collecting your tracks.'), button('Create playlist', createPlaylist, 'pill-button primary')); return; }
    const label = create('label', '', 'Choose playlist'), select = create('select'); select.id = 'addPlaylistSelect';
    lists.forEach(list => { const opt = create('option', '', list.name); opt.value = list.id; select.append(opt); }); label.append(select); dialogContent.append(label);
    submitButton('Add track', async () => { await post('/api/library', { operation: 'addToPlaylist', id: select.value, track: item }); dialog.close(); await refreshSidebar(); player.showToast('Added to playlist'); });
  }
  function openImport() {
    openDialog('Import your music'); dialogContent.append(create('p', '', 'Paste a public playlist URL, track links, an M3U playlist or a JSON track list. Music is resolved from supported providers.'));
    const name = field('New playlist name', 'importName'); name.input.value = 'Imported music'; name.input.maxLength = 80;
    const source = field('Public playlist URL', 'importUrl', 'url'); source.input.placeholder = 'https://…';
    const text = field('Or paste track links / playlist text', 'importText', 'textarea'); text.input.placeholder = 'One track link per line';
    dialogContent.append(name.wrapper, source.wrapper, text.wrapper);
    submitButton('Import music', async status => {
      if (!source.input.value.trim() && !text.input.value.trim()) throw new Error('Paste a playlist URL or some track links.');
      status.textContent = 'Resolving your music…';
      const result = await post('/api/platform/import', { playlistName: name.input.value.trim() || 'Imported music', url: source.input.value.trim() || undefined, text: text.input.value.trim() || undefined }, { timeout: 180000 });
      const failedCount = Array.isArray(result.failed) ? result.failed.length : Number(result.failed || 0);
      await refreshSidebar(); player.showToast(`${Number(result.added || 0)} tracks imported${failedCount ? ` · ${failedCount} unavailable` : ''}`);
      if (failedCount) {
        openDialog('Import finished'); dialogContent.append(create('p', '', `${Number(result.added || 0)} tracks were imported. ${failedCount} could not be resolved.`));
        for (const failure of Array.isArray(result.failed) ? result.failed.slice(0, 20) : []) dialogContent.append(create('p', 'platform-notice', `${failure.title || 'Track'} · ${failure.error || 'Source unavailable'}`));
        dialogContent.append(button('Open playlist', async () => { dialog.close(); if (result.playlist?.id) await navigate({ type: 'playlist', id: result.playlist.id }); }, 'pill-button primary'));
      } else { dialog.close(); if (result.playlist?.id) await navigate({ type: 'playlist', id: result.playlist.id }); }
    });
  }
  function renderUpload(data, page) {
    page.append(create('h1', '', 'Upload your music'), create('p', 'page-subtitle', 'Keep your own recordings and purchased music with the rest of your collection.'));
    const zone = create('div', 'upload-zone'); zone.innerHTML = svg('upload'); zone.append(create('h2', '', 'Bring your music with you'), create('p', '', 'Choose audio files or drop them here.\nSupported formats include MP3, FLAC, M4A, OGG and WAV.'));
    const input = create('input'); input.id = 'uploadFiles'; input.type = 'file'; input.accept = 'audio/*,.mp3,.flac,.m4a,.ogg,.wav,.aac,.opus,.aiff'; input.multiple = true; input.setAttribute('aria-label', 'Choose audio files'); zone.append(input);
    const status = create('div', 'upload-status'); status.setAttribute('role', 'status'); zone.append(status); page.append(zone);
    const progress = create('div', 'upload-progress-list'); zone.append(progress);
    const upload = async files => {
      files = [...files].slice(0, 50);
      if (!files.length) return;
      input.disabled = true; progress.replaceChildren(); status.textContent = 'Uploading your music…'; let complete = 0;
      for (const file of files) {
        const row = create('div', 'upload-progress-row'); row.append(create('span', '', file.name)); const result = create('span', '', 'Uploading…'); row.append(result); progress.append(row);
        try { await request('/api/platform/upload', { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-upload-name': encodeURIComponent(file.name), 'x-upload-title': encodeURIComponent(file.name.replace(/\.[^.]+$/, '')) }, timeout: 180000 }); result.textContent = 'Added to collection'; complete++; }
        catch (err) { result.textContent = err.message; }
      }
      input.disabled = false; input.value = ''; status.textContent = complete === files.length ? 'Upload complete' : `${complete} of ${files.length} files uploaded`;
      const updated = await request('/api/platform/library?kind=uploads').catch(() => null);
      if (updated) uploadedTracks.replaceChildren(updated.items?.length ? trackTable(updated.items) : empty('Your uploads will appear here', 'Upload music to play in your connected voice channel.'));
    };
    input.addEventListener('change', () => void upload(input.files));
    for (const type of ['dragenter', 'dragover']) zone.addEventListener(type, ev => { ev.preventDefault(); zone.classList.add('dragging'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
    zone.addEventListener('drop', ev => { ev.preventDefault(); zone.classList.remove('dragging'); if (!input.disabled) void upload(ev.dataTransfer.files); });
    page.append(create('h2', '', 'Your uploads')); const uploadedTracks = create('div'); page.append(uploadedTracks); uploadedTracks.append(data.items?.length ? trackTable(data.items) : empty('Your uploads will appear here', 'Upload music to play in your connected voice channel.'));
  }
  async function openSettings() {
    openDialog('Your listening settings');
    const loading = create('p', '', 'Loading your saved preferences…'); dialogContent.append(loading);
    let data;
    try { data = await request('/api/platform/settings'); }
    catch (err) { loading.textContent = err.message; return; }
    if (!dialog.open) return;
    loading.remove(); dialogContent.append(create('p', '', 'Recommendations follow these preferences on your account.'));
    const settings = { ...(data.settings || data) }; applyPreferences(settings);
    const toggle = (name, description, checked) => { const row = create('label', 'settings-row'), copy = create('div'); copy.append(create('span', '', name), create('small', '', description)); const input = create('input'); input.type = 'checkbox'; input.checked = checked; input.setAttribute('aria-label', name); row.append(copy, input); dialogContent.append(row); return input; };
    const explicit = toggle('Explicit content', 'Include releases labeled explicit in recommendations.', settings.explicit !== false);
    const autoplay = toggle('Autoplay', 'Continue with related music when your queue ends.', settings.autoplay === true);
    const motion = toggle('Motion artwork', 'Animate supported artwork while you listen.', settings.motionArtwork !== false);
    const preferred = field('Preferred genres · separated by commas', 'preferredGenres'); preferred.input.value = (settings.preferredGenres || []).join(', ');
    const excluded = field('Excluded genres · separated by commas', 'excludedGenres'); excluded.input.value = (settings.excludedGenres || []).join(', ');
    const discovery = field('Discovery · familiar favorites to new music', 'discoveryPreference', 'range'); discovery.input.min = '0'; discovery.input.max = '1'; discovery.input.step = '.05'; discovery.input.value = String(settings.discovery ?? .45);
    const country = field('Catalog country · two-letter country code', 'catalogCountry'); country.input.value = settings.country || 'US'; country.input.maxLength = 2; country.input.autocomplete = 'country';
    dialogContent.append(preferred.wrapper, excluded.wrapper, discovery.wrapper, country.wrapper);
    submitButton('Save settings', async () => {
      const genres = value => value.split(',').map(x => x.trim()).filter(Boolean).slice(0, 30);
      const value = { preferredGenres: genres(preferred.input.value), excludedGenres: genres(excluded.input.value), explicit: explicit.checked, autoplay: autoplay.checked, motionArtwork: motion.checked, discovery: Number(discovery.input.value), country: country.input.value.trim().toUpperCase() };
      if (!/^[A-Z]{2}$/.test(value.country)) throw new Error('Use a two-letter country code such as US or GB.');
      const saved = await post('/api/platform/settings', value); applyPreferences(saved.settings || value); dialog.close(); player.showToast('Settings saved');
      if (!document.body.classList.contains('full-player-open') && ['home', 'explore', 'feed'].includes(current.route?.type)) await navigate(current.route, { replace: true });
    });
  }
  function applyPreferences(settings) { current.preferences = { ...settings }; player.setMotionEnabled(settings.motionArtwork !== false); }

  async function refreshQueue(force = false) {
    if (q('#queueDrawer').hidden) return;
    const state = player.getState(); const signature = `discord:${state?.botKey || ''}:${state?.voiceChannelId || ''}:${songKey(state?.track)}:${state?.index}:${state?.queueLength}:${state?.queueRevision || 0}`;
    if (!force && signature === current.queueSignature) return;
    current.queueSignature = signature;
    const seq = current.queueRequestSeq = (current.queueRequestSeq || 0) + 1;
    q('#queueContents').replaceChildren(create('div', 'platform-loading', 'Loading queue…'));
    const results = await Promise.allSettled([request('/api/collection?kind=history'), request('/api/collection?kind=queue')]);
    if (seq !== current.queueRequestSeq || current.queueSignature !== signature || q('#queueDrawer').hidden) return;
    const queue = results[1].status === 'fulfilled' ? results[1].value.tracks || [] : [];
    const historyTracks = results[0].status === 'fulfilled' ? results[0].value.tracks || [] : [];
    const target = q('#queueContents'); target.replaceChildren();
    const group = (title, items, extra = {}) => { const section = create('section', `queue-group${extra.current ? ' current' : ''}`); const head = create('div', 'queue-group-head'); head.append(create('h3', '', title)); if (extra.clear) head.append(button('Clear', async () => { await player.act('clear'); await refreshQueue(true); }, 'text-button')); section.append(head); if (!items.length) section.append(create('p', 'queue-empty', 'Nothing here yet.')); items.forEach((item, i) => section.append(compactTrack(item, extra.remove ? { remove: async () => { await post('/api/action', { action: 'removeQueue', index: extra.startIndex + i }); await player.refreshState(); await refreshQueue(true); } } : {}))); target.append(section); };
    group('History', historyTracks.filter(t => songKey(t) !== songKey(state?.track)).slice(0, 5));
    group('Playing now', state?.track ? [state.track] : [], { current: true });
    const activeIndex = Math.max(0, Number(state?.index || 0));
    group('Next up', queue.slice(activeIndex + 1, activeIndex + 101), { clear: true, remove: true, startIndex: activeIndex + 1 });
    if (results[1].status === 'rejected') target.append(create('p', 'platform-notice', results[1].reason.message));
  }
  function toggleQueue(open) { const drawer = q('#queueDrawer'); drawer.hidden = open == null ? !drawer.hidden : !open; document.body.classList.toggle('queue-open', !drawer.hidden); q('#queueToggle').setAttribute('aria-expanded', String(!drawer.hidden)); if (!drawer.hidden) void refreshQueue(true).catch(report); }

  async function openFullPlayer(tab = phone.matches ? 'cover' : 'similar') {
    content.hidden = true; q('#stage').hidden = false; document.body.classList.add('full-player-open'); closeMobileNav(); closeMenu();
    const seq=++current.fullSeq;
    current.fullTab = tab; q('#fullPlayerTabs').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.playerTab === tab));
    q('#fullPlayerPanels').hidden = tab === 'lyrics' || tab === 'cover';
    await player.setView(tab === 'lyrics' ? 'lyrics' : 'player');
    if(seq!==current.fullSeq||!document.body.classList.contains('full-player-open'))return;
    q('#stage').classList.toggle('cover-view',tab==='cover');
    if (tab === 'lyrics' || tab === 'cover') return;
    const item = player.getState()?.track; const panels = q('#fullPlayerPanels'); panels.replaceChildren(create('div', 'platform-loading', tab === 'credits' ? 'Loading credits…' : 'Finding similar music…'));
    if (!item) { panels.replaceChildren(empty('Start listening', 'Choose a track to open your listening room.')); return; }
    try {
      if (tab === 'credits') {
        const value=await recordingCredits(item);
        if (seq !== current.fullSeq || !document.body.classList.contains('full-player-open')) return;
        panels.replaceChildren(create('h2', '', 'Credits'));
        if (hasCredits(value)) panels.append(credits(value)); else panels.append(create('p','platform-notice','Credits are not available for this recording yet.'));
      } else {
        const data = await request(`/api/platform/mix?id=radio&seed=${encodeURIComponent(JSON.stringify(item))}`);
        if (seq !== current.fullSeq || !document.body.classList.contains('full-player-open')) return;
        panels.replaceChildren(create('h2', '', 'Mixes & Radio'));
        const shelf = create('div', 'card-shelf'); shelf.append(card({ ...data, kind: 'mix' })); panels.append(shelf, create('h3', '', 'Suggested tracks'));
        const tracks = create('div', 'compact-track-grid'); (data.tracks || []).slice(0, 35).forEach(i => tracks.append(compactTrack(i))); panels.append(tracks);
      }
    } catch (err) { if (seq === current.fullSeq) panels.replaceChildren(errorPane(err, () => openFullPlayer(tab))); }
  }

  function authenticatedMediaURL(value, fallback) {
    const url = new URL(value || fallback, location.origin);
    if (url.origin !== location.origin) throw new Error('The prepared media source is not authorized for this session.');
    url.searchParams.set('token', player.token); return url.href;
  }
  const videoSync=window.MusicVideoSync.createDiscordVideoSync({video:q('#musicVideo'),getState:()=>player.getState(),getElapsed:()=>player.elapsedNow(),
    onMismatch:()=>{if(q('#videoDialog').open)q('#videoStatus').textContent='Choose a video to match the music playing in Discord.';},
    onFrame:({target,paused})=>{
      const video=q('#musicVideo'),duration=Number(video.duration)||0;
      if(!current.videoSeeking){q('#videoSeek').max=String(duration||100);q('#videoSeek').value=String(target);}
      const time=player.fmt(target),total=player.fmt(duration);if(q('#videoElapsed').textContent!==time)q('#videoElapsed').textContent=time;if(q('#videoDuration').textContent!==total)q('#videoDuration').textContent=total;
      if(current.videoPaused!==paused){current.videoPaused=paused;q('#videoPlayPause').innerHTML=paused?svg('play'):'<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>';q('#videoPlayPause').setAttribute('aria-label',paused?'Play video in Discord':'Pause video in Discord');}
    }});
  async function playVideo(item,fromQueue=false) {
    if(!fromQueue){current.videoQueue=[item];current.videoIndex=0;}
    const seq=++current.videoSeq,video=q('#musicVideo');current.videoAbort?.abort();const abort=new AbortController();current.videoAbort=abort;
    current.videoItem=item;current.videoTab='similar';q('#videoTitle').textContent=titleOf(item);q('#videoTrackTitle').textContent=titleOf(item);q('#videoTrackArtist').textContent=item.author||'';
    q('#videoFullscreenRoot').classList.remove('video-info-open');
    q('#videoDialog').querySelectorAll('[data-video-tab]').forEach(b=>b.setAttribute('aria-expanded','false'));
    q('#videoQuality').textContent='';q('#videoStatus').textContent='Preparing video…';q('#videoRetry').hidden=true;
    q('#videoPlayPause').disabled=true;q('#videoSeek').disabled=true;
    document.body.classList.add('video-player-open');q('#videoFullscreenRoot').append(menu);updateVideoControls();
    videoSync.stop();video.muted=true;video.defaultMuted=true;video.removeAttribute('src');video.load();if(!q('#videoDialog').open)q('#videoDialog').showModal();void renderVideoInfo('similar');
    try{const result=await post('/api/video/prepare',{track:item},{timeout:mediaPrepareTimeout,signal:abort.signal});if(seq!==current.videoSeq||!q('#videoDialog').open)return;
      if(result.mime&&!video.canPlayType(result.mime))throw new Error('The prepared video format is not supported by this browser.');
      video.src=authenticatedMediaURL(result.url,`/api/video/file?id=${encodeURIComponent(result.id)}`);q('#videoQuality').textContent=result.quality||'Source quality';
      q('#videoStatus').textContent='Starting audio in Discord…';
      const source={...result.track||item,kind:'video',metadataOnly:false};
      const state=await post('/api/action',{action:'playTrack',track:source},{timeout:mediaPrepareTimeout,signal:abort.signal});
      if(seq!==current.videoSeq||!q('#videoDialog').open)return;
      player.renderState(state);current.videoSource=state.track||source;current.videoPaused=null;videoSync.start(current.videoSource);
      await videoSync.sync();if(seq===current.videoSeq){q('#videoStatus').textContent='';q('#videoPlayPause').disabled=false;q('#videoSeek').disabled=false;}
    }catch(err){if(seq===current.videoSeq&&!abort.signal.aborted){q('#videoStatus').textContent=err.message;q('#videoRetry').hidden=false;}}
  }
  function updateVideoControls(){q('#videoPrevious').disabled=!(current.videoIndex>0);q('#videoNext').disabled=!current.videoQueue?.[current.videoIndex+1];}
  async function renderVideoInfo(tab){
    const seq=current.videoSeq,item=current.videoItem,info=q('#videoSidebar');current.videoTab=tab;if(!item)return;
    info.replaceChildren(create('h3','',tab==='credits'?'Credits':'Similar videos'));q('#videoDialog').querySelectorAll('[data-video-tab]').forEach(b=>b.classList.toggle('active',b.dataset.videoTab===tab));
    try{if(tab==='credits'){const value=await recordingCredits(item);if(seq!==current.videoSeq||current.videoTab!==tab||!q('#videoDialog').open)return;if(hasCredits(value))info.append(credits(value));else info.append(create('p','queue-empty','Credits have not been supplied for this recording.'));}
      else{const data=await request(`/api/platform/search?q=${encodeURIComponent(item.author||titleOf(item))}&type=videos`);if(seq!==current.videoSeq||current.videoTab!==tab||!q('#videoDialog').open)return;
        const videos=(data.items||data.sections?.flatMap(s=>s.items||[])||[]).filter(v=>kindOf(v)==='video'&&keyOf(v)!==keyOf(item));const seen=new Set((current.videoQueue||[]).map(keyOf));for(const v of videos)if(!seen.has(keyOf(v))){seen.add(keyOf(v));current.videoQueue.push(v);}
        for(const v of videos.slice(0,30))info.append(compactTrack(v));if(!videos.length)info.append(create('p','queue-empty','More videos by this artist will appear here.'));updateVideoControls();}
    }catch(_){if(seq===current.videoSeq&&current.videoTab===tab)info.append(button('Refresh',()=>renderVideoInfo(tab),'text-button'));}
  }
  function closeVideo(){current.videoSeq++;current.videoAbort?.abort();current.videoAbort=null;videoSync.stop();current.videoSource=null;const video=q('#musicVideo');video.removeAttribute('src');video.removeAttribute('poster');video.load();if(document.fullscreenElement===q('#videoFullscreenRoot'))void document.exitFullscreen().catch(()=>{});closeMenu();document.body.append(menu);if(q('#videoFullscreenRoot').contains(dialog)){dialog.close();document.body.append(dialog);}q('#videoDialog').close();document.body.classList.remove('video-player-open');}
  q('#musicVideo').addEventListener('error',()=>{if(q('#musicVideo').getAttribute('src')){q('#videoStatus').textContent='The video could not be loaded. Try again.';q('#videoRetry').hidden=false;}});
  q('#musicVideo').addEventListener('loadedmetadata',()=>void videoSync.sync());
  q('#musicVideo').addEventListener('volumechange',()=>videoSync.mute());
  q('#videoPlayPause').addEventListener('click',()=>void player.act('pause'));
  q('#videoSeek').addEventListener('input',()=>{current.videoSeeking=true;q('#videoElapsed').textContent=player.fmt(Number(q('#videoSeek').value));});
  q('#videoSeek').addEventListener('change',()=>{current.videoSeeking=false;void player.act('seekTo',Number(q('#videoSeek').value));});
  window.addEventListener('music:state',()=>void videoSync.sync());

  window.MusicPlatform = {
    watchArtwork:(...args)=>artworkManager.watch(...args),cachedArtwork:item=>artworkManager.cached(item),artworkFailed:img=>artworkManager.failed(img),
    navigate,
    downloadItem:()=>downloadItems(player.getState()?.track?[player.getState().track]:[]),
    getBrowserClock: () => null,
    getLyricsAudioId: () => '',
    adaptPlayerState: state => state,
    handlesPlayback: () => false,
    navigateLegacy(next) {
      if (next === 'lyrics') return openFullPlayer('lyrics');
      if (next === 'player') return openFullPlayer();
      if (next === 'queue') return toggleQueue(true);
      return navigate(next === 'search' ? { type: 'search', query: q('#searchInput').value.trim(), searchType: current.searchType } : next === 'history' ? { type: 'stats' } : next === 'playlists' ? { type: 'library', kind: 'playlists' } : next === 'library' ? { type: 'library', kind: 'tracks' } : { type: 'home', tab: 'for-you' });
    }
  };
  document.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => void navigate({ type: b.dataset.nav, ...(b.dataset.kind ? { kind: b.dataset.kind } : {}), ...(b.dataset.nav === 'home' ? { tab: 'for-you' } : {}) })));
  q('#mobileBottomNav').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>void navigate(b.dataset.mobileNav==='search'?{type:'search',query:''}:{type:b.dataset.mobileNav,...(b.dataset.mobileNav==='home'?{tab:'for-you'}:{})})));
  q('.brand').addEventListener('click', ev => { ev.preventDefault(); void navigate({ type: 'home', tab: 'for-you' }); });
  q('#collectionToggle').addEventListener('click', () => { const submenu = q('#collectionMenu'); submenu.hidden = !submenu.hidden; q('#collectionToggle').setAttribute('aria-expanded', String(!submenu.hidden)); });
  q('#sidebarCreatePlaylist').addEventListener('click', createPlaylist);
  q('#playlistSort').addEventListener('click', () => { current.sortAscending = !current.sortAscending; void refreshSidebar().catch(report); });
  q('#sidebarImport').addEventListener('click', openImport);
  q('#dismissImportCard').addEventListener('click', () => { q('#importCard').hidden = true; try { localStorage.setItem('musicImportDismissed', '1'); } catch (_) {} });
  try { q('#importCard').hidden = localStorage.getItem('musicImportDismissed') === '1'; } catch (_) {}
  q('#mobileNavToggle').addEventListener('click', () => { const open = !document.body.classList.contains('mobile-nav-open'); document.body.classList.toggle('mobile-nav-open', open); q('#navScrim').hidden = !open; q('#mobileNavToggle').setAttribute('aria-expanded', String(open)); });
  q('#navScrim').addEventListener('click', closeMobileNav);
  q('#navBack').addEventListener('click', () => history.back()); q('#navForward').addEventListener('click', () => history.forward());
  window.addEventListener('popstate', ev => void navigate(ev.state?.platform || parseRoute(), { history: true }));
  let searchTimer = null;
  q('#searchInput').addEventListener('input', () => { clearTimeout(searchTimer); const query = q('#searchInput').value.trim(); current.abort?.abort(); searchTimer = setTimeout(() => void navigate({ type: 'search', query, searchType: current.route?.searchType || 'all' }, { replace: current.route?.type === 'search' }), 190); });
  q('#searchForm').addEventListener('submit', ev => { ev.preventDefault(); clearTimeout(searchTimer); void navigate({ type: 'search', query: q('#searchInput').value.trim(), searchType: current.route?.searchType || 'all' }); });
  q('#mobileSearchInput').addEventListener('input',()=>{clearTimeout(searchTimer);const query=q('#mobileSearchInput').value.trim();current.abort?.abort();searchTimer=setTimeout(()=>void navigate({type:'search',query,searchType:current.route?.searchType||'all'},{replace:current.route?.type==='search'}),220);});
  q('#mobileSearchBar').addEventListener('submit',ev=>{ev.preventDefault();clearTimeout(searchTimer);void navigate({type:'search',query:q('#mobileSearchInput').value.trim(),searchType:current.route?.searchType||'all'});});
  q('#profileToggle').addEventListener('click', () => void openSettings().catch(report));
  q('#queueToggle').addEventListener('click', () => toggleQueue()); q('#queueClose').addEventListener('click', () => toggleQueue(false));
  q('#expandPlayer').addEventListener('click', () => void openFullPlayer());
  q('#miniCover').addEventListener('click', () => void openFullPlayer()); q('#miniTitle').addEventListener('click', () => void openFullPlayer());
  q('#miniCover').tabIndex=0;q('#miniCover').setAttribute('role','button');q('#miniCover').setAttribute('aria-label','Open full player');q('#miniCover').addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();void openFullPlayer();}});
  q('#closeFullPlayer').addEventListener('click', closeFullPlayer);
  q('#fullPlayerTabs').querySelectorAll('button').forEach(b => b.addEventListener('click', () => void openFullPlayer(phone.matches&&b.dataset.playerTab==='lyrics'&&current.fullTab==='lyrics'?'cover':b.dataset.playerTab)));
  q('#mobileQueue').addEventListener('click',()=>toggleQueue());q('#mobileTrackMenu').addEventListener('click',ev=>{const track=player.getState()?.track;if(track)showMenu(track,ev.currentTarget);});
  q('#mobileShare').addEventListener('click',()=>void shareItem(player.getState()?.track).catch(report));
  q('#mobileSaveTrack').addEventListener('click',()=>void player.act('favorite').catch(report));
  q('#fullPlayerArtist').addEventListener('click',()=>{const track=player.getState()?.track;if(track)void goToArtist(track).catch(report);});
  q('#playingContext').addEventListener('click',()=>current.playingContext?.route?void navigate(current.playingContext.route):toggleQueue(true));
  q('#playerFullscreen').addEventListener('click', () => { if (document.fullscreenElement) void document.exitFullscreen().catch(report); else void q('.app-shell').requestFullscreen().catch(report); });
  q('#videoFullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) return void document.exitFullscreen().catch(report);
    const video=q('#musicVideo');
    if(q('#videoFullscreenRoot').requestFullscreen) void q('#videoFullscreenRoot').requestFullscreen().catch(report);
    else if(video.webkitEnterFullscreen) { try { video.webkitEnterFullscreen(); } catch(error) { report(error); } }
    else player.showToast('Full screen is unavailable in this browser.');
  });
  q('#videoPrevious').addEventListener('click',()=>{if(current.videoIndex>0)void playVideo(current.videoQueue[--current.videoIndex],true).catch(report);});
  q('#videoNext').addEventListener('click',()=>{if(current.videoQueue?.[current.videoIndex+1])void playVideo(current.videoQueue[++current.videoIndex],true).catch(report);});
  q('#videoRetry').addEventListener('click',()=>{if(current.videoItem)void playVideo(current.videoItem,true).catch(report);});
  q('#videoDialog').querySelectorAll('[data-video-tab]').forEach(b=>{b.setAttribute('aria-controls','videoSidebar');b.addEventListener('click',()=>{
    if(phone.matches){const root=q('#videoFullscreenRoot'),open=!(root.classList.contains('video-info-open')&&current.videoTab===b.dataset.videoTab);root.classList.toggle('video-info-open',open);q('#videoDialog').querySelectorAll('[data-video-tab]').forEach(tab=>tab.setAttribute('aria-expanded',String(open&&tab===b)));}
    void renderVideoInfo(b.dataset.videoTab);
  });});
  q('#videoClose').addEventListener('click', closeVideo); q('#videoDialog').addEventListener('cancel', ev => {ev.preventDefault();closeVideo();});
  q('#platformDialogClose').addEventListener('click', () => dialog.close());
  document.addEventListener('pointerdown', ev => { if (!menu.hidden && !menu.contains(ev.target)) closeMenu(); });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { closeMenu(); closeMobileNav(); if (!dialog.open && !q('#videoDialog').open && document.body.classList.contains('full-player-open')) closeFullPlayer(); }
    if (!menu.hidden && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) { ev.preventDefault(); const items = [...menu.querySelectorAll('button,a')]; const index = items.indexOf(document.activeElement); const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? items.length - 1 : (index + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[next]?.focus(); }
    if (ev.code === 'Space' && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(document.activeElement?.tagName) && !dialog.open && !q('#videoDialog').open) { ev.preventDefault(); void player.act('pause'); }
  });
  let previousTrack = '';
  window.addEventListener('music:state', ev => {
    const state = ev.detail; const key = songKey(state.track);
    q('#fullPlayerTitle').textContent = titleOf(state.track || { title: 'Nothing playing' }); q('#fullPlayerArtist').textContent = state.track?.author || 'Your music';
    q('#sourceQuality').textContent=state.track?.quality||state.audioQuality||state.quality||'Source audio';
    q('#mobileSaveTrack').classList.toggle('is-saved',Boolean(state.favorited));q('#mobileSaveTrack').setAttribute('aria-pressed',String(Boolean(state.favorited)));q('#mobileSaveTrack').setAttribute('aria-label',state.favorited?'Remove current track from favorites':'Save current track');
    const color=state.palette?.[2];if(/^#[a-f\d]{6}$/i.test(color||'')){const values=[1,3,5].map(n=>parseInt(color.slice(n,n+2),16));const grey=Math.round(values[0]*.213+values[1]*.715+values[2]*.072);const light=Math.max(40,Math.min(115,grey));document.documentElement.style.setProperty('--phone-player',`rgb(${values.map(v=>Math.round(light*.85+v*.15)).join(',')})`);}
    const source = q('#fullPlayerSource'), item = state.track;
    const provider = { youtube: 'YouTube', soundcloud: 'SoundCloud', direct: 'direct source', upload: 'your upload' }[item?.source || item?.provider] || item?.source || item?.provider;
    source.hidden = !provider || !item?.url;
    source.replaceChildren();
    if (!source.hidden) { const label = `Audio from ${provider}${item.mediaTitle ? ` · ${item.mediaTitle}` : ''}`; source.append(item.source === 'upload' ? create('span', '', label) : externalLink(label, item.url)); }
    const reason = q('#fullPlayerReason'); reason.hidden = !item?.autoplayReason; reason.textContent = item?.autoplayReason ? `Autoplay · ${item.autoplayReason}` : '';
    if (previousTrack && key !== previousTrack) {
      if (document.body.classList.contains('full-player-open') && current.fullTab !== 'lyrics') void openFullPlayer(current.fullTab);
    }
    previousTrack = key;
    void refreshQueue().catch(report);
  });

  // Saved state loads independently: a temporary collection failure must never
  // prevent available provider music from being displayed.
  void refreshSidebar().catch(err => { q('#playlistSidebar').replaceChildren(create('span', 'sidebar-empty', 'Playlists could not be loaded.')); report(err); });
  for (const kind of ['tracks', 'albums', 'artists', 'videos', 'mixes']) request(`/api/platform/library?kind=${kind}`).then(data => { current.saved.set(kind, new Set((data.items || []).map(keyOf))); if (data.preferences) applyPreferences(data.preferences); }).catch(() => {});
  const initial = parseRoute(); void navigate(initial, { replace: true });
})();
