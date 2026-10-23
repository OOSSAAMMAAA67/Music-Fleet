'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {canonicalTrackKey}=require('./trackIdentity');
function respond(res,status,value){const body=JSON.stringify(value);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.end(body);}
async function readJson(req){let size=0;const parts=[];for await(const chunk of req){size+=chunk.length;if(size>2*1024**2)throw new Error('Request is too large.');parts.push(chunk);}try{const body=parts.length?JSON.parse(Buffer.concat(parts).toString('utf8')):{};if(!body||typeof body!=='object'||Array.isArray(body))throw new Error();return body;}catch(_){throw new Error('Invalid JSON request.');}}
function createPlatformHttp({platform=require('./platformService'),playlists=require('./playlistsStore'),favorites=require('./favoritesStore'),uploads=require('./uploadsStore'),media,artwork,openArtworkMedia,resolveTrack=(...a)=>require('./platformSources').resolve(...a),recoverTrack=(...a)=>require('./platformSources').recover(...a),searchSources=(...a)=>require('./ytDlpProvider').search(...a),enrich=value=>value}={}){
 const artworkHttp=require('./platformArtworkHttp').createArtworkHttp({platform,uploads,artwork,openMedia:openArtworkMedia});
 const browserPlayback=new (require('./browserPlayback').BrowserPlayback)({service:platform});
 const downloads=new (require('./platformDownloads').PlatformDownloads)({dataDir:media?.dataDir?`${media.dataDir}-downloads`:undefined,media,resolveTrack,recoverTrack,store:{recordDownload:(...args)=>platform.recordDownload(...args)}});
 async function handle(req,res,url,session){
  const p=url.pathname,q=url.searchParams,u=session.u;
  if(p.startsWith('/api/platform/')){
   if(p==='/api/platform/artwork/image'&&['GET','HEAD'].includes(req.method)){await artworkHttp.serve(req,res,q.get('id'),session);return true;}
   if(p==='/api/platform/download/file'&&['GET','HEAD'].includes(req.method)){downloads.serve(req,res,q.get('id'),session);return true;}
   if(req.method==='GET'){
    let value;
    if(p==='/api/platform/home')value=await platform.home(u,{tab:q.get('tab')||'for-you',stage:q.get('stage')||'full'});
    else if(p==='/api/platform/explore')value=await platform.explore(u,Object.fromEntries(['genre','mood','decade','mode'].map(k=>[k,q.get(k)||''])));
    else if(p==='/api/platform/search')value=await platform.search(String(q.get('q')||'').slice(0,220),q.get('type')||'all',u);
    else if(p==='/api/platform/detail')value=await platform.detail(q.get('kind'),q.get('id'),{name:String(q.get('name')||'').slice(0,160),artist:String(q.get('artist')||'').slice(0,160),user:u});
    else if(p==='/api/platform/mix')value=await platform.mix(u,q.get('id')||'daily-discovery',q.get('seed')||'');
    else if(p==='/api/platform/stats')value=await platform.stats(u,q.get('month')||undefined);
    else if(p==='/api/platform/feed')value=await platform.feed(u);
    else if(p==='/api/platform/settings')value=await platform.settings(u);
    else if(p==='/api/platform/library'){
     const kind=q.get('kind')||'tracks';
     if(kind==='uploads')value={kind,items:await uploads.list(u)};
     else value=await platform.library(u,kind);
    }else if(p==='/api/platform/upload/art'){
     const file=await uploads.cover(u,q.get('id'));res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'private, max-age=3600'});const stream=fs.createReadStream(file);stream.once('error',e=>res.destroy(e));res.once('close',()=>stream.destroy());stream.pipe(res);return true;
    }else return false;
    respond(res,200,await enrich(value,session));return true;
   }
   if(req.method==='POST'){
    if(p==='/api/platform/artist'){
     const body=await readJson(req),track=require('./platformSources').sanitize(body.track||{});
     const identity=require('./artworkResolver').identifyTrack(track);
     const name=String(identity.artist||track.author||'').split(/\s+(?:feat(?:uring)?\.?|ft\.?)\s+/i)[0].trim().slice(0,160);
     const value=name?await platform.search(name,'artists',u):{items:[]};
     respond(res,200,await enrich({...value,query:name},session));return true;
    }
    if(p==='/api/platform/credits'){
     const body=await readJson(req),track=require('./platformSources').sanitize(body.track||{});
     respond(res,200,{credits:await platform.recordingCredits(track)});return true;
    }
    if(p==='/api/platform/artwork/resolve'){
     const controller=new AbortController(),cancel=()=>{if(!res.writableEnded)controller.abort(new Error('Artwork request cancelled.'));};res.once('close',cancel);req.once('aborted',cancel);
     try{const body=await readJson(req),value=await artworkHttp.resolve(body,session,{signal:controller.signal});controller.signal.throwIfAborted();respond(res,200,value);return true;}finally{res.removeListener('close',cancel);req.removeListener('aborted',cancel);}
    }
    if(p==='/api/platform/download'){
     const controller=new AbortController(),cancel=()=>{if(!res.writableEnded)controller.abort(new Error('Download preparation cancelled.'));};res.once('close',cancel);req.once('aborted',cancel);
     try{const body=await readJson(req),value=await downloads.prepare(body,session,{signal:controller.signal});controller.signal.throwIfAborted();respond(res,200,value);return true;}finally{res.removeListener('close',cancel);req.removeListener('aborted',cancel);}
    }
    if(p==='/api/platform/settings'){
     const body=await readJson(req);respond(res,200,await platform.editLibrary(u,{operation:'settings',value:body.settings||body}));return true;
    }
    if(p==='/api/platform/autoplay'){
     const body=await readJson(req);respond(res,200,await platform.autoplayNext(u,body.seed||{}, {exclude:Array.isArray(body.exclude)?body.exclude.slice(0,2000):[]}));return true;
    }
    if(p==='/api/platform/library'){
     const body=await readJson(req);let value;
     if(['track','tracks'].includes(String(body.kind))&&['save','unsave'].includes(body.operation)){
      if(body.operation==='save'){const track=await resolveTrack(body.item||{},u);favorites.add({id:u,username:'Web Player'},track);if(favorites.saveNow(u)===false)throw new Error('Could not save your favorite.');}
      else{const key=canonicalTrackKey(body.item||{}),list=favorites.list(u),index=list.findIndex(t=>canonicalTrackKey(t)===key);if(index>=0){favorites.remove(u,index);if(favorites.saveNow(u)===false)throw new Error('Could not update your favorite.');}}
      value={ok:true};
     }else if(body.operation==='removeUpload'){
      await uploads.remove(u,body.id||body.item?.id);try{await platform.editLibrary(u,{operation:'unsave',kind:'uploads',item:body.item||{id:body.id}});}catch(_){}value={ok:true};
     }else value=await platform.editLibrary(u,body);
     respond(res,200,value);return true;
    }
    if(p==='/api/platform/import'){
     const body=await readJson(req);let candidates=Array.isArray(body.tracks)?body.tracks.slice(0,2000):[];
     if(body.url){const raw=String(body.url).trim();if(!require('./publicMedia').isExtractorUrl(raw))throw new Error('Import supports YouTube and SoundCloud playlist URLs, or a track list file.');await require('./platformMedia').validatePublicUrl(raw);candidates=await searchSources(raw,{limit:2000,playlistLimit:2000});}
     if(body.text){
      const text=String(body.text).slice(0,512_000);try{const parsed=JSON.parse(text);const items=Array.isArray(parsed)?parsed:parsed.tracks||parsed.items;if(Array.isArray(items))candidates=items.slice(0,2000);}catch(_){candidates=text.split(/\r?\n/).filter(Boolean).map(line=>{if(/^https?:\/\//i.test(line.trim()))return {url:line.trim(),title:line.trim(),author:'Imported'};const [artist,title]=line.split(/\s+[-–]\s+/,2);return {title:title||artist,author:title?artist:'Unknown artist',metadataOnly:true};}).slice(0,2000);}
     }
     if(!candidates.length)throw new Error('No tracks were found to import.');
     const list=await playlists.create(u,body.playlistName||'Imported playlist');let added=0,duplicates=0;const failed=[],seen=new Set();
     for(let i=0;i<candidates.length;i+=4){const batch=await Promise.allSettled(candidates.slice(i,i+4).map(t=>resolveTrack(t,u)));for(let j=0;j<batch.length;j++){const item=batch[j];try{if(item.status==='rejected')throw item.reason;const key=canonicalTrackKey(item.value);if(seen.has(key)){duplicates++;continue;}await playlists.add(u,list.id,item.value);seen.add(key);added++;}catch(e){failed.push({index:i+j,title:String(candidates[i+j]?.title||'').slice(0,220),error:String(e?.message||'No source found').slice(0,220)});}}}
     respond(res,200,{ok:true,playlist:{...await playlists.get(u,list.id),name:list.name},added,duplicates,failed,...(candidates.importReport?{sourceReport:candidates.importReport}:{})});return true;
    }
    if(p==='/api/platform/upload'){
     let name=String(req.headers['x-upload-name']||'audio.mp3'),title=String(req.headers['x-upload-title']||''),author=String(req.headers['x-upload-author']||'Your uploads');
     try{name=decodeURIComponent(name);title=decodeURIComponent(title);author=decodeURIComponent(author);}catch(_){}
     const size=Number(req.headers['content-length']||0);if(uploads.maxBytes&&size>uploads.maxBytes)throw Object.assign(new Error('Audio upload is too large.'),{status:413});
     const item=await uploads.import(u,req,{filename:name,title,author});
     try{await platform.editLibrary(u,{operation:'save',kind:'uploads',item});}catch(e){await uploads.remove(u,item.id).catch(()=>{});throw e;}
     respond(res,200,{ok:true,item});return true;
    }
   }
   return false;
  }
  if(/^\/api\/(?:video|audio)\/prepare$/.test(p)&&req.method==='POST'){
   const controller=new AbortController(),cancel=()=>{if(!res.writableEnded)controller.abort(new Error('Media request was cancelled.'));};
   res.once('close',cancel);req.once('aborted',cancel);
   try{
    const kind=p.includes('/video/')?'video':'audio',body=await readJson(req);controller.signal.throwIfAborted();
    const original=body.track||{},track=await resolveTrack(original,u,{kind,signal:controller.signal});controller.signal.throwIfAborted();
    let value;
    try{value=await media.prepare(kind,track,session,{signal:controller.signal});}
    catch(error){
     controller.signal.throwIfAborted();
     const catalog=/^(deezer|itunes|musicbrainz|spotify|tidal):(track|album):/.test(String(original.id||track.id||''))||Boolean(track.metadataProvider||track.linkedProvider);
     if(!catalog||!require('./audioDownload').isRetryableDownloadError(error))throw error;
     const recovered=await recoverTrack(track,u,{kind,failedUrl:track.url,error,signal:controller.signal});controller.signal.throwIfAborted();
     if(!recovered||recovered.url===track.url)throw error;
     value=await media.prepare(kind,recovered,session,{signal:controller.signal});
    }
    controller.signal.throwIfAborted();
    respond(res,200,value);return true;
   }finally{res.removeListener('close',cancel);req.removeListener('aborted',cancel);}
  }
  if(p==='/api/audio/event'&&req.method==='POST'){const body=await readJson(req);respond(res,200,await browserPlayback.event(session,media.get(body.id,session),body));return true;}
  if(/^\/api\/(?:video|audio)\/file$/.test(p)&&['GET','HEAD'].includes(req.method)){media.serveFile(req,res,q.get('id'),session);return true;}
  if(p==='/api/artwork/motion'&&['GET','HEAD'].includes(req.method)){await media.proxyMotion(req,res,q.get('id'),session);return true;}
  return false;
 }
 return {handle,readJson,close:()=>Promise.allSettled([browserPlayback.close(),downloads.close(),artworkHttp.close()])};
}
module.exports={createPlatformHttp,readJson};
