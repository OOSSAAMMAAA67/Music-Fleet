const { AttachmentBuilder } = require('discord.js');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { resolveFfmpegPath } = require('./ffmpegResolver');
const performanceProfile = require('./performanceProfile');
const { openPublicMedia } = require('./publicMedia');

let sharpLib = null;
function getSharp() {
    if (sharpLib !== null) return sharpLib;
    try { sharpLib = require('sharp'); performanceProfile.configureSharp(sharpLib); } catch (_) { sharpLib = false; }
    return sharpLib;
}

const imageCache = new Map();
const animationCache = new Map();
const animationJobs = new Map();
const IMAGE_TTL = 30 * 60 * 1000;
const MAX_IMAGE_CACHE_BYTES = Math.max(32, Number(config.NOW_PLAYING_IMAGE_CACHE_MB || 256)) * 1024 * 1024;
const ANIMATION_TTL = 6 * 60 * 60 * 1000;
const MAX_ANIMATION_CACHE = 96;
const MAX_ANIMATION_CACHE_BYTES = Math.max(64, Number(config.NOW_PLAYING_ANIMATION_CACHE_MB || 512)) * 1024 * 1024;

function escapeXml(input = '') {
    return String(input).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function truncate(text, max = 64) {
    const s = String(text || '').trim() || 'Unknown';
    return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}
function formatDuration(seconds = 0) {
    const n = Math.max(0, Math.floor(Number(seconds || 0)));
    const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function rgba(hex, alpha = 1) {
    const clean = String(hex || '#8FA8FF').replace('#', '');
    const full = clean.length === 3 ? clean.split('').map(x => x + x).join('') : clean.padEnd(6, '0').slice(0, 6);
    const [r,g,b] = [0,2,4].map(i => parseInt(full.slice(i, i + 2), 16));
    return `rgba(${r},${g},${b},${alpha})`;
}
function hexFromRgb(obj = {}) {
    const vals = ['r','g','b'].map(k => Math.max(0, Math.min(255, Number(obj[k] || 0))));
    return `#${vals.map(v => Math.round(v * .72 + 55).toString(16).padStart(2, '0')).join('')}`;
}

function clampByte(value) {
    return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}
function rgbHex(r, g, b) {
    return `#${[r,g,b].map(v => clampByte(v).toString(16).padStart(2, '0')).join('')}`;
}
function colorFieldSvg(width, height, dominant = {}, accent = '#8FA8FF') {
    const r = clampByte(dominant.r || 72), g = clampByte(dominant.g || 82), b = clampByte(dominant.b || 105);
    const c1 = accent;
    const c2 = rgbHex(b * .95 + 42, r * .78 + 22, g * 1.03 + 18);
    const c3 = rgbHex(r * .72 + 24, b * .82 + 28, g * .70 + 12);
    const c4 = rgbHex(r * .18 + 7, g * .20 + 8, b * .24 + 10);
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <radialGradient id="a" cx="26%" cy="21%" r="70%"><stop offset="0" stop-color="${c1}" stop-opacity=".80"/><stop offset=".55" stop-color="${c1}" stop-opacity=".24"/><stop offset="1" stop-color="${c1}" stop-opacity="0"/></radialGradient>
        <radialGradient id="b" cx="80%" cy="26%" r="76%"><stop offset="0" stop-color="${c2}" stop-opacity=".72"/><stop offset=".58" stop-color="${c2}" stop-opacity=".20"/><stop offset="1" stop-color="${c2}" stop-opacity="0"/></radialGradient>
        <radialGradient id="c" cx="54%" cy="91%" r="74%"><stop offset="0" stop-color="${c3}" stop-opacity=".70"/><stop offset=".62" stop-color="${c3}" stop-opacity=".18"/><stop offset="1" stop-color="${c3}" stop-opacity="0"/></radialGradient>
        <linearGradient id="v" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c4}"/><stop offset=".55" stop-color="#080b11"/><stop offset="1" stop-color="#030508"/></linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#v)"/>
      <rect x="-${Math.round(width*.08)}" y="-${Math.round(height*.12)}" width="${Math.round(width*1.16)}" height="${Math.round(height*1.2)}" fill="url(#a)"/>
      <rect x="-${Math.round(width*.03)}" y="-${Math.round(height*.08)}" width="${Math.round(width*1.12)}" height="${Math.round(height*1.18)}" fill="url(#b)"/>
      <rect x="-${Math.round(width*.06)}" y="-${Math.round(height*.04)}" width="${Math.round(width*1.14)}" height="${Math.round(height*1.15)}" fill="url(#c)"/>
    </svg>`);
}
function trackKey(track = {}) {
    return crypto.createHash('sha1').update(`${track.url || ''}|${track.thumbnail || ''}|${track.title || ''}`).digest('hex');
}

function trimImageCache() {
    const now = Date.now();
    let totalBytes = 0;
    for (const [key, item] of imageCache) {
        if (!item || item.expiresAt <= now) { imageCache.delete(key); continue; }
        totalBytes += Number(item.buffer?.length || 0);
    }
    while (imageCache.size > 256 || totalBytes > MAX_IMAGE_CACHE_BYTES) {
        const oldestKey = imageCache.keys().next().value;
        if (!oldestKey) break;
        const oldest = imageCache.get(oldestKey);
        totalBytes -= Number(oldest?.buffer?.length || 0);
        imageCache.delete(oldestKey);
    }
}

function trimAnimationCache() {
    const now = Date.now();
    for (const [key, item] of animationCache) if (item.expiresAt <= now) animationCache.delete(key);
    let totalBytes = 0;
    for (const item of animationCache.values()) totalBytes += Number(item?.buffer?.length || 0);
    while (animationCache.size > MAX_ANIMATION_CACHE || totalBytes > MAX_ANIMATION_CACHE_BYTES) {
        const oldestKey = animationCache.keys().next().value;
        if (!oldestKey) break;
        const oldest = animationCache.get(oldestKey);
        totalBytes -= Number(oldest?.buffer?.length || 0);
        animationCache.delete(oldestKey);
    }
}

async function fetchImageBuffer(url, track) {
    if (!url) return null;
    if (String(url).startsWith('/')) {
        try {
            const uploads = require('./uploadsStore');
            const parsed = uploads.parseUploadUrl(track?.url);
            const art = /^\/api\/platform\/upload\/art\?id=([a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12})$/i.exec(url);
            if (!art || !parsed || art[1] !== parsed.id || (track.requesterId && String(track.requesterId) !== parsed.userId)) return null;
            const key = `upload:${parsed.userId}:${parsed.id}`;
            const cached = imageCache.get(key);
            if (cached?.expiresAt > Date.now()) return cached.buffer;
            const file = await uploads.cover(parsed.userId, parsed.id);
            const stat = await fsp.stat(file);
            if (!stat.size || stat.size > 10 * 1024 * 1024) return null;
            const buffer = await fsp.readFile(file);
            if (buffer.length > 10 * 1024 * 1024) return null;
            imageCache.set(key, { buffer, expiresAt: Date.now() + IMAGE_TTL });
            trimImageCache();
            return buffer;
        } catch (_) { return null; }
    }
    const old = imageCache.get(url);
    if (old?.expiresAt > Date.now()) return old.buffer;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000); timer.unref?.();
    let opened;
    try {
        opened = await openPublicMedia(url, { signal: controller.signal, headers: { 'user-agent': String(config.YTDLP_USER_AGENT || 'Mozilla/5.0') } });
        const maxBytes = 10 * 1024 * 1024;
        if (Number(opened.response.headers['content-length'] || 0) > maxBytes) {
            controller.abort(); throw new Error('Artwork too large');
        }
        const chunks = []; let size = 0;
        for await (const chunk of opened.response) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > maxBytes) { controller.abort(); throw new Error('Artwork too large'); }
            chunks.push(bytes);
        }
        if (!size) throw new Error('Artwork is empty');
        const buffer = await require('./youtubeArtwork').cropYoutubeArtwork(Buffer.concat(chunks, size),url);
        imageCache.set(url, { buffer, expiresAt: Date.now() + IMAGE_TTL });
        trimImageCache();
        return buffer;
    } catch (_) { return null; }
    finally { clearTimeout(timer); opened?.cleanup(); }
}

async function getArtwork(track, width, height, coverSize) {
    const sharp = getSharp();
    if (!sharp) return { accent: config.COLORS.MUSIC || '#8FA8FF' };
    const source = await fetchImageBuffer(track?.thumbnail, track);
    if (!source) return { accent: config.COLORS.MUSIC || '#8FA8FF' };
    const img = sharp(source, { failOn: 'none' }).rotate();
    const stats = await img.stats().catch(() => null);
    const accent = stats?.dominant ? hexFromRgb(stats.dominant) : (config.COLORS.MUSIC || '#8FA8FF');
    // Cover and color-field rendering are independent once stats are known. Run
    // them together so libvips can use the tuned 5-thread i5-9400F pool.
    const [cover, background] = await Promise.all([
        img.clone().resize(coverSize, coverSize, { fit: 'cover' }).png().toBuffer().catch(() => null),
        sharp(colorFieldSvg(width, height, stats?.dominant, accent))
            .resize(width, height, { fit: 'fill' }).png().toBuffer().catch(() => null),
    ]);
    return { accent, cover, background, source };
}

async function rounded(buffer, size, radius = 30) {
    const sharp = getSharp();
    if (!sharp || !buffer) return buffer;
    const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`);
    return sharp(buffer).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

function playerOverlaySvg(track, queue, accent, width, height, coverSize) {
    const coverX = 44, coverY = Math.round((height - coverSize) / 2);
    const x = coverX + coverSize + 50;
    const title = escapeXml(truncate(track?.title, Math.max(22, Math.floor((width-x-45)/19))));
    const artist = escapeXml(truncate(track?.author || 'Unknown Artist', 44));
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs>
        <linearGradient id="veil" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="rgba(4,6,13,.20)"/><stop offset=".52" stop-color="rgba(7,9,16,.48)"/><stop offset="1" stop-color="rgba(2,4,9,.80)"/></linearGradient>
        <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(255,255,255,.135)"/><stop offset=".4" stop-color="rgba(255,255,255,.06)"/><stop offset="1" stop-color="rgba(255,255,255,.035)"/></linearGradient>
        <filter id="shadow"><feDropShadow dx="0" dy="15" stdDeviation="18" flood-color="rgba(0,0,0,.58)"/></filter>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#veil)"/>
      <rect x="18" y="18" width="${width-36}" height="${height-36}" rx="34" fill="url(#glass)" stroke="rgba(255,255,255,.18)"/>
      <rect x="${coverX-3}" y="${coverY-3}" width="${coverSize+6}" height="${coverSize+6}" rx="28" fill="rgba(255,255,255,.12)" stroke="rgba(255,255,255,.17)" filter="url(#shadow)"/>
      <rect x="${x}" y="55" width="36" height="3" rx="2" fill="${rgba(accent,.85)}"/>
      <text x="${x+48}" y="60" font-family="Segoe UI,Arial" font-size="12" font-weight="700" letter-spacing="2.4" fill="rgba(255,255,255,.68)">MUSIC  /  BY ! A</text>
      <text x="${x}" y="${Math.round(height*.45)}" font-family="Segoe UI,Arial" font-size="34" font-weight="700" fill="#fff">${title}</text>
      <text x="${x}" y="${Math.round(height*.45)+39}" font-family="Segoe UI,Arial" font-size="20" fill="rgba(255,255,255,.79)">${artist}</text>
      <rect x="${x}" y="${height-86}" width="${Math.min(455,width-x-50)}" height="1" fill="rgba(255,255,255,.18)"/>
      <text x="${x}" y="${height-55}" font-family="Segoe UI,Arial" font-size="15" letter-spacing="1.2" fill="rgba(255,255,255,.72)">LISTENING NOW</text>
      <circle cx="${width-55}" cy="${height-61}" r="5" fill="${rgba(accent,.9)}"/>
    </svg>`);
}

async function composePlayerForeground(track, queue, accent, cover, width, height, coverSize) {
    const sharp = getSharp();
    if (!sharp) return null;
    const overlay = playerOverlaySvg(track, queue, accent, width, height, coverSize);
    let canvas = sharp({ create: { width, height, channels: 4, background: { r:0,g:0,b:0,alpha:0 } } });
    const comps = [{ input: overlay }];
    if (cover) comps.splice(0, 0, { input: await rounded(cover, coverSize, 25), left: 44, top: Math.round((height-coverSize)/2) });
    return canvas.composite(comps).png().toBuffer();
}

async function generateNowPlayingCard(track, queue) {
    if (config.NOW_PLAYING_DYNAMIC_CARD === false) return null;
    const sharp = getSharp(); if (!sharp) return null;
    const width = Number(config.NOW_PLAYING_CARD_WIDTH || 1040);
    const height = Number(config.NOW_PLAYING_CARD_HEIGHT || 420);
    const coverSize = Math.min(306, height - 96);
    const art = await getArtwork(track, width, height, coverSize);
    const [fg, blurredBackground] = await Promise.all([
        composePlayerForeground(track, queue, art.accent, art.cover, width, height, coverSize),
        art.background ? sharp(art.background).blur(24).toBuffer().catch(() => null) : Promise.resolve(null),
    ]);
    let base = sharp({ create:{ width,height,channels:4,background:'#0d1017'} });
    const shade = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="rgba(0,0,0,.24)"/></svg>`);
    const buffer = await base.composite([...(blurredBackground ? [{ input: blurredBackground }] : []), { input: shade }, ...(fg ? [{ input: fg }] : [])]).png().toBuffer();
    return { file: new AttachmentBuilder(buffer,{name:'player.png'}), fileName:'player.png', accent:art.accent, animated:false };
}

function runFfmpeg(args, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
        const filterThreads = String(performanceProfile.ffmpegFilterThreads('heavy'));
        const tunedArgs = ['-filter_threads', filterThreads, '-filter_complex_threads', filterThreads, ...args];
        const cp = spawn(resolveFfmpegPath(), tunedArgs, { windowsHide:true, stdio:['ignore','ignore','pipe'] });
        performanceProfile.registerChildProcess(cp, 'heavy');
        let err=''; cp.stderr.on('data',d => { if (err.length < 10000) err += d.toString(); });
        const timer=setTimeout(()=>{ try{cp.kill('SIGKILL');}catch(_){} reject(new Error('animated UI ffmpeg timeout')); },timeoutMs); timer.unref?.();
        cp.once('error',e=>{ clearTimeout(timer); reject(e); });
        cp.once('close',code=>{ clearTimeout(timer); code===0?resolve():reject(new Error(err || `ffmpeg exited ${code}`)); });
    });
}

async function generateAnimatedNowPlayingCard(track, queue) {
    if (config.NOW_PLAYING_ANIMATED_BACKGROUND === false) return null;
    trimAnimationCache();
    const key = trackKey(track);
    const cached = animationCache.get(key);
    if (cached?.expiresAt > Date.now()) return { file:new AttachmentBuilder(cached.buffer,{name:cached.fileName}), fileName:cached.fileName, accent:cached.accent, animated:true };
    if (animationJobs.has(key)) return animationJobs.get(key);

    const job = performanceProfile.runHeavy('animated-now-playing', async()=>{
        const sharp=getSharp(); if(!sharp) return null;
        const width=Number(config.NOW_PLAYING_CARD_WIDTH || 1040), height=Number(config.NOW_PLAYING_CARD_HEIGHT || 420);
        const coverSize=Math.min(306,height-96);
        const art=await getArtwork(track,width,height,coverSize);
        if(!art.background) return null;
        const fg=await composePlayerForeground(track,queue,art.accent,art.cover,width,height,coverSize);
        if(!fg) return null;
        const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'music-a-ui-'));
        const bg=path.join(dir,'bg.png'), front=path.join(dir,'front.png');
        try {
            await Promise.all([fsp.writeFile(bg,art.background),fsp.writeFile(front,fg)]);
            const fps=Math.max(24,Math.min(60,Number(config.NOW_PLAYING_ANIMATION_FPS || 60)));
            const seconds=Math.max(2,Math.min(4,Number(config.NOW_PLAYING_ANIMATION_SECONDS || 2)));
            const frames=fps*seconds;
            const animWidth=Math.min(width,Math.max(620,Number(config.NOW_PLAYING_ANIMATION_WIDTH || 960)));
            const animHeight=Math.max(240,Math.round(height*(animWidth/width)));
            const sourceW=Math.ceil(width*1.12), sourceH=Math.ceil(height*1.12);
            const filter=`[0:v]scale=${sourceW}:${sourceH}:force_original_aspect_ratio=increase,crop=${sourceW}:${sourceH},zoompan=z='1.06+0.012*sin(2*PI*on/${frames})':x='iw/2-(iw/zoom/2)+42*sin(2*PI*on/${frames})':y='ih/2-(ih/zoom/2)+25*cos(2*PI*on/${frames})':d=1:s=${animWidth}x${animHeight}:fps=${fps},boxblur=8:2,hue=h='22*sin(2*PI*t/${seconds})':s=1.32,eq=brightness=-0.01[bg];[1:v]scale=${animWidth}:${animHeight}[fg];[bg][fg]overlay=0:0:shortest=1,format=yuva420p[v]`;
            let fileName='player-live.webp', out=path.join(dir,fileName);
            try {
                await runFfmpeg(['-hide_banner','-loglevel','error','-loop','1','-framerate',String(fps),'-i',bg,'-loop','1','-framerate',String(fps),'-i',front,'-filter_complex',filter,'-map','[v]','-frames:v',String(frames),'-threads',String(performanceProfile.ffmpegThreads('heavy')),'-c:v','libwebp_anim','-lossless','1','-compression_level','6','-loop','0','-y',out],90000);
            } catch (err) {
                fileName='player-live.gif'; out=path.join(dir,fileName);
                const gifFilter=filter.replace('format=yuva420p[v]','format=rgb24[v]');
                await runFfmpeg(['-hide_banner','-loglevel','error','-loop','1','-framerate',String(fps),'-i',bg,'-loop','1','-framerate',String(fps),'-i',front,'-filter_complex',gifFilter,'-map','[v]','-frames:v',String(frames),'-threads',String(performanceProfile.ffmpegThreads('heavy')),'-loop','0','-y',out],90000);
            }
            let buffer=await fsp.readFile(out);
            const max=Number(config.NOW_PLAYING_ANIMATION_MAX_BYTES || 18_500_000);
            if (buffer.length > max && fileName === 'player-live.webp' && animWidth > 720) {
                const smallWidth=720, smallHeight=Math.max(240,Math.round(height*(smallWidth/width)));
                const smallFilter=filter.replace(`s=${animWidth}x${animHeight}`,`s=${smallWidth}x${smallHeight}`)
                    .replace(`scale=${animWidth}:${animHeight}`,`scale=${smallWidth}:${smallHeight}`);
                const compact=path.join(dir,'compact.webp');
                await runFfmpeg(['-hide_banner','-loglevel','error','-loop','1','-framerate',String(fps),'-i',bg,'-loop','1','-framerate',String(fps),'-i',front,'-filter_complex',smallFilter,'-map','[v]','-frames:v',String(frames),'-threads',String(performanceProfile.ffmpegThreads('heavy')),'-c:v','libwebp_anim','-lossless','1','-compression_level','6','-loop','0','-y',compact],90000);
                buffer=await fsp.readFile(compact);
            }
            if(buffer.length>max) return null;
            animationCache.set(key,{buffer,fileName,accent:art.accent,expiresAt:Date.now()+ANIMATION_TTL}); trimAnimationCache();
            return { file:new AttachmentBuilder(buffer,{name:fileName}), fileName, accent:art.accent, animated:true };
        } finally { fsp.rm(dir,{recursive:true,force:true}).catch(()=>{}); }
    }).finally(()=>animationJobs.delete(key));
    animationJobs.set(key,job); return job;
}

async function generateLyricsCard(track, lyrics, options={}) {
    if (config.LYRICS_DYNAMIC_CARD === false) return null;
    const sharp=getSharp(); if(!sharp) return null;
    const width=1120,height=630,coverSize=340;
    const art=await getArtwork(track,width,height,coverSize);
    const lines=(Array.isArray(options.lines)?options.lines:[]).slice(0,7);
    const active=lines.findIndex(x=>x.active);
    const title=escapeXml(truncate(lyrics?.title||track?.title||'Lyrics',48));
    const artist=escapeXml(truncate(lyrics?.artist||track?.author||'Unknown Artist',38));
    const rows=lines.map((l,i)=>{ const dist=active<0?2:Math.abs(i-active); const op=l.active?1:Math.max(.25,.72-dist*.13); const size=l.active?31:25; const weight=l.active?700:500; return `<text x="510" y="${198+i*52}" font-family="Segoe UI,Arial" font-size="${size}" font-weight="${weight}" fill="rgba(255,255,255,${op})">${escapeXml(truncate(l.text||'♪',70))}</text>`; }).join('');
    const overlay=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="v" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="rgba(0,0,0,.20)"/><stop offset=".5" stop-color="${rgba(art.accent,.18)}"/><stop offset="1" stop-color="rgba(0,0,0,.68)"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#v)"/><rect x="24" y="24" width="${width-48}" height="${height-48}" rx="34" fill="rgba(255,255,255,.055)" stroke="rgba(255,255,255,.12)"/><text x="510" y="82" font-family="Segoe UI,Arial" font-size="15" font-weight="700" letter-spacing="2" fill="rgba(255,255,255,.55)">SYNCED LYRICS</text><text x="510" y="126" font-family="Segoe UI,Arial" font-size="33" font-weight="700" fill="#fff">${title}</text><text x="510" y="160" font-family="Segoe UI,Arial" font-size="20" fill="rgba(255,255,255,.68)">${artist}</text>${rows}<text x="${width-45}" y="${height-38}" text-anchor="end" font-family="Segoe UI,Arial" font-size="13" font-weight="600" letter-spacing="1.6" fill="rgba(255,255,255,.42)">BY ! A</text></svg>`);
    let canvas=sharp({create:{width,height,channels:4,background:'#0c1017'}});
    const comps=[];
    if(art.background) comps.push({input:await sharp(art.background).blur(28).toBuffer()});
    if(art.cover) comps.push({input:await rounded(art.cover,coverSize,28),left:92,top:145});
    comps.push({input:overlay});
    const buffer=await canvas.composite(comps).png().toBuffer();
    return {file:new AttachmentBuilder(buffer,{name:'lyrics.png'}),fileName:'lyrics.png',accent:art.accent};
}

async function generateCollectionCard(kind, tracks = [], page = 1) {
    const sharp = getSharp(); if (!sharp) return null;
    const pageSize = 10, start = (Math.max(1, Number(page) || 1) - 1) * pageSize;
    const slice = tracks.slice(start, start + pageSize);
    if (!slice.length) return null;
    const width = 960, height = 126 + slice.length * 66;
    const art = await getArtwork(slice[0], width, height, 56);
    const heading = { favorites: 'YOUR LIBRARY', history: 'RECENTLY PLAYED', discover: 'DISCOVER FOR YOU' }[kind] || 'MUSIC';
    const bg = sharp({create:{width,height,channels:4,background:'#10121b'}});
    const layers = [];
    if (art.background) layers.push({input:await sharp(art.background).resize(width,height,{fit:'cover'}).blur(30).modulate({brightness:.45}).toBuffer()});
    const rows = slice.map((track, i) => {
        const y=102+i*66, index=start+i+1;
        return `<rect x="32" y="${y}" width="896" height="60" rx="15" fill="rgba(255,255,255,.085)" stroke="rgba(255,255,255,.11)"/>
        <text x="51" y="${y+37}" fill="rgba(255,255,255,.52)" font-size="16" font-family="Segoe UI,Arial">${index}</text>
        <text x="155" y="${y+27}" fill="#fff" font-size="20" font-weight="600" font-family="Segoe UI,Arial">${escapeXml(truncate(track.title,51))}</text>
        <text x="155" y="${y+48}" fill="rgba(255,255,255,.62)" font-size="14" font-family="Segoe UI,Arial">${escapeXml(truncate(track.author,48))}</text>
        <text x="900" y="${y+38}" text-anchor="end" fill="rgba(255,255,255,.55)" font-size="14" font-family="Segoe UI,Arial">${formatDuration(track.duration)}</text>`;
    }).join('');
    const overlay=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect x="16" y="16" width="928" height="${height-32}" rx="28" fill="rgba(7,9,18,.41)" stroke="rgba(255,255,255,.17)"/>
      <rect x="36" y="48" width="31" height="3" rx="2" fill="${rgba(art.accent,.95)}"/>
      <text x="80" y="55" fill="#fff" font-size="22" font-weight="700" letter-spacing="1.1" font-family="Segoe UI,Arial">${heading}</text>
      <text x="906" y="54" text-anchor="end" fill="rgba(255,255,255,.48)" font-size="12" letter-spacing="1.6" font-family="Segoe UI,Arial">BY ! A</text>${rows}
    </svg>`);
    layers.push({input:overlay});
    const covers=await Promise.all(slice.map(async (track,i) => {
        try {
            const data=await fetchImageBuffer(track.thumbnail,track);
            if(!data) return null;
            const tile=await sharp(data,{failOn:'none'}).resize(52,52,{fit:'cover'}).png().toBuffer();
            return {input:await rounded(tile,52,9),left:92,top:106+i*66};
        } catch (_) {return null;}
    }));
    const buffer=await bg.composite([...layers,...covers.filter(Boolean)]).png().toBuffer();
    return {file:new AttachmentBuilder(buffer,{name:'collection.png'}),fileName:'collection.png',accent:art.accent};
}

async function generateMoreCard(track) {
    const sharp=getSharp(); if(!sharp) return null;
    const width=960,height=250,coverSize=150;
    const art=await getArtwork(track,width,height,coverSize);
    let base=sharp({create:{width,height,channels:4,background:'#121725'}});
    const overlay=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="250">
      <rect x="16" y="16" width="928" height="218" rx="30" fill="rgba(6,9,17,.40)" stroke="rgba(255,255,255,.19)"/>
      <rect x="${track?.thumbnail?218:42}" y="57" width="30" height="3" rx="2" fill="${rgba(art.accent,.93)}"/>
      <text x="${track?.thumbnail?218:42}" y="105" font-family="Segoe UI,Arial" font-weight="700" font-size="32" fill="#fff">YOUR MUSIC SPACE</text>
      <text x="${track?.thumbnail?218:42}" y="151" font-family="Segoe UI,Arial" font-size="18" fill="rgba(255,255,255,.72)">Your library. Your history. Your next track.</text>
      <text x="903" y="203" text-anchor="end" font-family="Segoe UI,Arial" font-size="12" letter-spacing="2" fill="rgba(255,255,255,.51)">BY ! A</text>
    </svg>`);
    const layers=[];
    if(art.background) layers.push({input:await sharp(art.background).blur(28).modulate({brightness:.56}).toBuffer()});
    layers.push({input:overlay});
    if(art.cover)layers.push({input:await rounded(art.cover,coverSize,20),left:41,top:50});
    const buffer=await base.composite(layers).png().toBuffer();
    return {file:new AttachmentBuilder(buffer,{name:'more.png'}),fileName:'more.png',accent:art.accent};
}

module.exports={ generateNowPlayingCard, generateAnimatedNowPlayingCard, generateLyricsCard, generateCollectionCard, generateMoreCard };
