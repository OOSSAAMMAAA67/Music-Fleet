'use strict';
const fs=require('node:fs');
const fsp=fs.promises;
const path=require('node:path');
const crypto=require('node:crypto');
const dns=require('node:dns/promises');
const net=require('node:net');
const {Readable,Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const uploadsStore=require('./uploadsStore');
const {probeMedia,mimeForExtension}=uploadsStore;
const {resolveFfmpegPath}=require('./ffmpegResolver');
const config=require('../config');

function privateAddress(input) {
  let a=String(input).toLowerCase().replace(/^\[|\]$/g,'');
  if(a.includes(':')){
    if(!net.isIP(a))return true;
    try{a=new URL(`http://[${a}]/`).hostname.slice(1,-1);}catch(_){return true;}
    if(a.startsWith('::ffff:')){
      const mapped=a.slice(7);
      if(mapped.includes('.'))return privateAddress(mapped);
      const words=mapped.split(':');if(words.length!==2)return true;
      const high=parseInt(words[0],16),low=parseInt(words[1],16);
      return privateAddress(`${high>>>8}.${high&255}.${low>>>8}.${low&255}`);
    }
    return a==='::'||a==='::1'||/^(?:fc|fd|fe[89ab]|ff)/.test(a)||/^::[0-9a-f:.]*$/.test(a);
  }
  const p=a.split('.').map(Number);
  return p.length!==4||p.some(n=>!Number.isInteger(n)||n<0||n>255)||p[0]===0||p[0]===10||p[0]===127||p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&p[1]===168||p[0]===100&&p[1]>=64&&p[1]<=127||p[0]>=224;
}
function waitForMedia(work,signal){
  if(signal?.aborted)return Promise.reject(signal.reason);if(!signal)return Promise.resolve().then(work);
  return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(work).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
async function validatePublicUrl(input,{lookup=dns.lookup,allowedHosts,signal}={}) {
  signal?.throwIfAborted();
  let u;try{u=new URL(String(input));}catch(_){throw new Error('A valid public media URL is required.');}
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw new Error('Media URL must use HTTP(S) without credentials.');
  if(u.port&&u.port!=='443'&&u.port!=='80')throw new Error('Media URL uses a blocked port.');
  const h=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(!h||h==='localhost'||/\.(?:localhost|local|internal|invalid)$/.test(h)||net.isIP(h)&&privateAddress(h))throw new Error('Private media hosts are blocked.');
  if(allowedHosts&&!allowedHosts.some(allowed=>h===allowed||h.endsWith('.'+allowed)))throw new Error('This motion media host is not trusted.');
  const values=net.isIP(h)?[{address:h}]:await waitForMedia(()=>lookup(h,{all:true,verbatim:true}),signal);
  const addresses=Array.isArray(values)?values:[values];
  if(!addresses.length||addresses.some(x=>privateAddress(x.address)))throw new Error('Private or unavailable media host.');
  return u.href;
}
function parseRange(input,size) {
  if(!input)return null;
  const m=String(input).match(/^bytes=(\d*)-(\d*)$/);
  if(!m||(!m[1]&&!m[2])||!Number.isSafeInteger(size)||size<=0)throw Object.assign(new Error('Invalid byte range.'),{status:416});
  let start,end;
  if(!m[1]){const suffix=Number(m[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)throw Object.assign(new Error('Invalid byte range.'),{status:416});start=Math.max(0,size-suffix);end=size-1;}
  else{start=Number(m[1]);end=m[2]?Number(m[2]):size-1;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)throw Object.assign(new Error('Unsatisfiable byte range.'),{status:416});
  end=Math.min(size-1,end);return {start,end,length:end-start+1};
}
function buildVideoArgs(options={}) {
  return require('./audioDownload').buildSourceArgs({...options,kind:'video',original:true});
}
function codecName(value){return String(value||'').trim().split(/[\s,(]/)[0].toLowerCase();}
function originalQuality(kind,meta){return kind==='video'?`Original ${meta.height?meta.height+'p · ':''}${meta.videoCodec||'video'}`:`Original ${meta.audioCodec||'audio'}${meta.sampleRate?' · '+meta.sampleRate+' Hz':''}`;}
function mediaMime(kind,file){const ext=path.extname(file).toLowerCase();if(ext==='.webm')return `${kind}/webm`;if(ext==='.mp4')return `${kind}/mp4`;if(ext==='.mov')return 'video/quicktime';if(ext==='.mkv')return 'video/x-matroska';return mimeForExtension(ext);}
async function mediaContainer(file){
  const handle=await fsp.open(file,'r');let head;
  try{const buffer=Buffer.alloc(4096),read=await handle.read(buffer,0,buffer.length,0);head=buffer.subarray(0,read.bytesRead);}finally{await handle.close();}
  if(head.toString('ascii',4,8)==='ftyp')return head.toString('ascii',8,12)==='qt  '?'mov':'mp4';
  if(head.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))){
    const at=head.indexOf(Buffer.from([0x42,0x82]));
    if(at>=0&&at+3<head.length){const first=head[at+2];let width=1;while(width<=8&&!(first&(0x80>>(width-1))))width++;if(width<=2&&at+2+width<head.length){let length=first&(0xff>>width);for(let n=1;n<width;n++)length=length*256+head[at+2+n];if(length>0&&length<32){const type=head.toString('ascii',at+2+width,at+2+width+length);if(type==='webm')return 'webm';if(type==='matroska')return 'mkv';}}}
  }
  return path.extname(file).toLowerCase().slice(1);
}
async function prepareVideoFile(file,{metadata,signal,ffmpegPath=resolveFfmpegPath(),runner=require('./audioDownload').run}={}){
  signal?.throwIfAborted();const meta=metadata||await probeMedia(file,{requireAudio:false,signal}),ext=path.extname(file).toLowerCase(),container=await mediaContainer(file);signal?.throwIfAborted();
  if(!meta.videoCodec)throw new Error('This source contains no decodable music video.');
  const video=codecName(meta.videoCodec),audio=codecName(meta.audioCodec),mp4Video=['h264','av1'].includes(video)&&!/(?:10|4:4:4|4:2:2)/.test(meta.videoCodec),mp4Audio=!audio||['aac','mp3'].includes(audio);
  const webmVideo=['vp8','vp9','av1'].includes(video),webmAudio=!audio||['opus','vorbis'].includes(audio);
  const origin={originalContainer:container,originalVideoCodec:meta.videoCodec,originalAudioCodec:meta.audioCodec,compatibilityEncoded:false,containerRemuxed:false,audioReencoded:false,videoReencoded:false};
  if(container==='webm'&&webmVideo&&webmAudio||container==='mp4'&&mp4Video&&mp4Audio)return {path:file,mime:container==='webm'?'video/webm':'video/mp4',metadata:{...meta,...origin},quality:originalQuality('video',meta)};
  const remuxMp4=mp4Video&&mp4Audio,remuxWebm=!remuxMp4&&webmVideo&&webmAudio,encode=!remuxMp4&&!remuxWebm;
  const output=path.join(path.dirname(file),path.basename(file,ext)+'.browser.'+(remuxWebm?'webm':'mp4'));
  const copyVideo=!encode||mp4Video,copyAudio=!encode||mp4Audio;
  const args=['-nostdin','-hide_banner','-loglevel','error','-y',...uploadsStore.LOCAL_INPUT_ARGS,'-i',file,'-map','0:v:0','-map','0:a:0?','-sn','-dn','-c:v',copyVideo?'copy':'libx264'];
  if(!copyVideo)args.push('-preset','medium','-crf','18','-pix_fmt','yuv420p','-threads',String(require('./performanceProfile').ffmpegThreads('heavy')));
  args.push('-c:a',copyAudio?'copy':'aac');if(!copyAudio)args.push('-b:a','256k');if(!remuxWebm)args.push('-movflags','+faststart');args.push(output);
  const work=()=>runner(ffmpegPath,args,{cwd:path.dirname(file),signal,timeoutMs:10*60_000,firstByteTimeoutMs:0,idleTimeoutMs:0,cpuKind:encode?'heavy':'background'});
  if(encode)await require('./performanceProfile').runHeavy('video-compatibility',work);else await work();
  signal?.throwIfAborted();const result=await probeMedia(output,{requireAudio:false,signal});
  return {path:output,mime:mediaMime('video',output),metadata:{...result,...origin,compatibilityEncoded:encode,containerRemuxed:!encode,audioReencoded:encode&&!copyAudio,videoReencoded:encode&&!copyVideo},quality:encode?`Compatibility encoded · ${result.height?result.height+'p · ':''}${result.videoCodec}${result.audioCodec?' / '+result.audioCodec:''}`:`${originalQuality('video',meta)} · stream copy ${remuxWebm?'WebM':'MP4'}`};
}

function rewriteHls(text,base,issue) {
  return String(text).split(/\r?\n/).map(line=>{
    if(!line.trim())return line;
    if(line.startsWith('#'))return line.replace(/URI="([^"\r\n]+)"/g,(_m,uri)=>`URI="${issue(new URL(uri,base).href)}"`);
    return issue(new URL(line.trim(),base).href);
  }).join('\n');
}
const MOTION_HOSTS=['mzstatic.com','music.apple.com','resources.tidal.com','video.tidal.com'];
const JOB_DIRECTORY=/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
function mediaLimit(value,name,{positive=false}={}) {
  const number=Number(value);if(!Number.isSafeInteger(number)||number<(positive?1:0))throw new Error(`Invalid ${name} limit.`);return number;
}
class PlatformMedia {
  constructor({dataDir=path.join(__dirname,'..','data','web-media'),uploads=uploadsStore,prepareFile,fetch,lookup=dns.lookup,request,ttlMs=4*60*60_000,maxConcurrent=3,maxJobs=4096,maxPending=128,maxDownloadBytes=Number(process.env.WEB_MAX_MEDIA_BYTES)||0,maxStorageBytes=Number(process.env.WEB_MAX_MEDIA_STORAGE_BYTES)||0}={}) {
    this.dataDir=path.resolve(dataDir);this.uploads=uploads;this.prepareFile=prepareFile||this._download.bind(this);this.fetch=fetch;this.lookup=lookup;this.request=request;this.ttlMs=ttlMs;
    this.maxConcurrent=mediaLimit(maxConcurrent,'concurrency',{positive:true});this.maxJobs=mediaLimit(maxJobs,'job',{positive:true});this.maxPending=mediaLimit(maxPending,'queue');this.maxDownloadBytes=mediaLimit(maxDownloadBytes,'download byte');this.maxStorageBytes=mediaLimit(maxStorageBytes,'storage byte');
    this.jobs=new Map();this.inflight=new Map();this.cache=new Map();this.motion=new Map();this.controllers=new Set();this.pendingWork=new Set();this.active=0;this.waiting=[];this.closing=false;
    this.activeDirs=new Set();this.mutations=Promise.resolve();this.ready=this._reclaimOrphans(true);this.ready.catch(()=>{});
    this.timer=setInterval(()=>void this.sweep().catch(()=>{}),60_000);this.timer.unref?.();
  }
  _owner(s){const u=String(s?.u||''),g=String(s?.g||'');if(!/^\d{5,32}$/.test(u)||!/^\d{5,32}$/.test(g))throw new Error('Invalid media session.');return `${u}:${g}`;}
  async _slot(work,signal){
    if(this.closing)throw new Error('Media service stopped.');signal?.throwIfAborted();
    if(this.active>=this.maxConcurrent)await new Promise((resolve,reject)=>{
      const release=()=>signal?.removeEventListener('abort',abort);
      const waiter={resolve:()=>{release();resolve();},reject:error=>{release();reject(error);}};
      const abort=()=>{const index=this.waiting.indexOf(waiter);if(index<0)return;this.waiting.splice(index,1);waiter.reject(signal.reason);};
      this.waiting.push(waiter);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });else this.active++;
    try{signal?.throwIfAborted();if(this.closing)throw new Error('Media service stopped.');return await work();}
    finally{const next=this.waiting.shift();if(next&&!this.closing)next.resolve();else{this.active--;next?.reject(new Error('Media service stopped.'));}}
  }
  _consumer(record,signal){
    return new Promise((resolve,reject)=>{
      const consumer={};let done=false;record.consumers.add(consumer);
      const finish=(error,result)=>{if(done)return;done=true;signal?.removeEventListener('abort',abort);record.consumers.delete(consumer);error?reject(error):resolve(result);};
      const abort=()=>{
        const error=signal.reason||Object.assign(new Error('Media preparation cancelled.'),{name:'AbortError',code:'ABORT_ERR'});finish(error);
        if(!record.settled&&!record.consumers.size){if(this.inflight.get(record.key)===record)this.inflight.delete(record.key);record.controller.abort(Object.assign(new Error('Media preparation cancelled.'),{name:'AbortError',code:'ABORT_ERR'}));}
      };
      record.promise.then(result=>finish(null,result),error=>finish(error));
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });
  }
  _mutate(work){const pending=this.mutations.then(work);this.mutations=pending.catch(()=>{});return pending;}
  async _directoryBytes(dir){
    const entries=await fsp.readdir(dir,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});let bytes=0;
    for(const entry of entries){const file=path.join(dir,entry.name);if(entry.isDirectory())bytes+=await this._directoryBytes(file);else if(entry.isFile())bytes+=(await fsp.stat(file).catch(e=>{if(e.code==='ENOENT')return {size:0};throw e;})).size;}
    return bytes;
  }
  async _discard(job){this.jobs.delete(job.id);if(this.cache.get(job.key)===job.id)this.cache.delete(job.key);await fsp.rm(job.dir,{recursive:true,force:true});}
  async _reclaimOrphans(startup=false){
    const entries=await fsp.readdir(this.dataDir,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    const known=new Set([...this.jobs.values()].map(job=>job.dir));
    for(const entry of entries){if(!entry.isDirectory()||!JOB_DIRECTORY.test(entry.name))continue;const dir=path.join(this.dataDir,entry.name);if(known.has(dir)||this.activeDirs.has(dir))continue;const stat=await fsp.stat(dir).catch(()=>null);if(stat&&(startup||stat.mtimeMs<=Date.now()-this.ttlMs))await fsp.rm(dir,{recursive:true,force:true});}
  }
  async _checkQuota(dir,controller){
    if(controller.signal.aborted||!this.activeDirs.has(dir))return;
    const bytes=await this._directoryBytes(dir);
    if(this.maxDownloadBytes&&bytes>this.maxDownloadBytes)throw new Error('Prepared media is too large.');
    if(this.maxStorageBytes)await this._mutate(async()=>{
      if(controller.signal.aborted||!this.activeDirs.has(dir))return;
      let total=[...this.jobs.values()].reduce((sum,job)=>sum+job.storageBytes,0);for(const active of this.activeDirs)total+=await this._directoryBytes(active);
      while(total>this.maxStorageBytes&&this.jobs.size){const oldest=this.jobs.values().next().value;total-=oldest.storageBytes;await this._discard(oldest);}
      if(total>this.maxStorageBytes)throw new Error('Prepared media exceeds the storage limit.');
    });
  }
  async _publish(job,signal){return this._mutate(async()=>{
    signal.throwIfAborted();if(this.closing)throw new Error('Media service stopped.');
    if(this.maxStorageBytes&&job.storageBytes>this.maxStorageBytes)throw new Error('Prepared media exceeds the storage limit.');
    let stored=[...this.jobs.values()].reduce((sum,item)=>sum+item.storageBytes,0);
    while(this.jobs.size>=this.maxJobs||this.maxStorageBytes&&stored+job.storageBytes>this.maxStorageBytes){const oldest=this.jobs.values().next().value;stored-=oldest.storageBytes;await this._discard(oldest);}
    signal.throwIfAborted();if(this.closing)throw new Error('Media service stopped.');
    this.activeDirs.delete(job.dir);this.jobs.set(job.id,job);this.cache.set(job.key,job.id);return this._public(job);
  });}
  async prepare(kind,track,session,{signal:consumerSignal}={}) {
    if(this.closing)throw new Error('Media service stopped.');consumerSignal?.throwIfAborted();
    if(!['audio','video'].includes(kind))throw new Error('Unknown media type.');
    const safeTrack=require('./platformSources').sanitize(track),owner=this._owner(session),url=String(safeTrack.url||''),key=crypto.createHash('sha256').update(`${owner}|${kind}|${url}`).digest('hex');
    if(!url)throw new Error('No playable media source is available.');
    const cached=this.cache.get(key);if(cached&&this.jobs.get(cached)?.expires>Date.now())return this._public(this.jobs.get(cached));
    const prior=this.inflight.get(key);if(prior&&!prior.controller.signal.aborted)return this._consumer(prior,consumerSignal);if(prior)this.inflight.delete(key);
    if(this.inflight.size>=this.maxConcurrent+this.maxPending)throw Object.assign(new Error('Media preparation queue is busy.'),{status:429});
    const controller=new AbortController(),record={key,controller,consumers:new Set(),settled:false};this.controllers.add(controller);const {signal}=controller;
    const work=this._slot(async()=>{
      const id=crypto.randomUUID(),dir=path.join(this.dataDir,id);let monitor,checking=false;
      try {
        await this.ready;signal.throwIfAborted();this.activeDirs.add(dir);await fsp.mkdir(dir,{recursive:true});
        if(this.maxDownloadBytes||this.maxStorageBytes){monitor=setInterval(()=>{if(checking||signal.aborted)return;checking=true;this._checkQuota(dir,controller).catch(e=>controller.abort(e)).finally(()=>{checking=false;});},500);monitor.unref?.();}
        let file;
        if(safeTrack.provider==='local-upload'||uploadsStore.parseUploadUrl(url)){const local=await waitForMedia(()=>this.uploads.resolve(session.u,url),signal);file={path:local.path,mime:local.mime,quality:`Original ${local.audioCodec}${local.sampleRate?' · '+local.sampleRate+' Hz':''}`,metadata:local,owned:false};if(kind==='video')throw new Error('This upload contains audio, not a music video.');}
        else{await validatePublicUrl(url,{lookup:this.lookup,signal});signal.throwIfAborted();file=await this.prepareFile(kind,safeTrack,{dir,session,signal});}
        signal.throwIfAborted();const stat=await fsp.lstat(file.path);if(!stat.isFile()||!stat.size)throw new Error('Media preparation returned an empty file.');
        const storageBytes=await this._directoryBytes(dir);if(this.maxDownloadBytes&&file.owned!==false&&storageBytes>this.maxDownloadBytes)throw new Error('Prepared media is too large.');
        const job={...file,id,dir,owner,kind,key,track:safeTrack,size:stat.size,storageBytes,expires:Date.now()+this.ttlMs,mime:file.mime||mimeForExtension(path.extname(file.path)),owned:file.owned!==false};
        return await this._publish(job,signal);
      }catch(e){await fsp.rm(dir,{recursive:true,force:true});throw signal.aborted?signal.reason:e;}
      finally{clearInterval(monitor);this.activeDirs.delete(dir);}
    },signal).finally(()=>{record.settled=true;this.pendingWork.delete(work);this.controllers.delete(controller);if(this.inflight.get(key)===record)this.inflight.delete(key);});
    record.promise=work;this.pendingWork.add(work);this.inflight.set(key,record);return this._consumer(record,consumerSignal);
  }
  _public(job){const {path:_path,...metadata}=job.metadata||{};return {id:job.id,url:`/api/${job.kind}/file?id=${job.id}`,mime:job.mime,quality:job.quality||'Original source',metadata,expiresAt:job.expires,track:job.track};}
  get(id,session){const job=this.jobs.get(String(id));if(!job||job.owner!==this._owner(session)||job.expires<=Date.now())throw Object.assign(new Error('Media is unavailable or expired.'),{status:404});return job;}
  serveFile(req,res,id,session){
    const job=this.get(id,session);let range;
    try{range=parseRange(req.headers.range,job.size);}catch(e){res.writeHead(416,{'Content-Range':`bytes */${job.size}`});res.end();return;}
    const headers={'Content-Type':job.mime,'Content-Length':range?.length||job.size,'Accept-Ranges':'bytes','Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff'};
    if(range)headers['Content-Range']=`bytes ${range.start}-${range.end}/${job.size}`;
    res.writeHead(range?206:200,headers);if(req.method==='HEAD'){res.end();return;}
    const stream=fs.createReadStream(job.path,range?{start:range.start,end:range.end}:{});
    stream.once('error',e=>res.destroy(e));res.once('close',()=>stream.destroy());stream.pipe(res);
  }
  issueMotion(url,session,{ttlMs=20*60_000}={}) {
    const owner=this._owner(session);let u;try{u=new URL(String(url));}catch(_){return '';}
    const h=u.hostname.toLowerCase();if(u.protocol!=='https:'||u.username||u.password||u.port||!MOTION_HOSTS.some(host=>h===host||h.endsWith('.'+host)))return '';
    const expiry=Math.min(Date.now()+Math.max(30_000,ttlMs),Number(session.e)||Infinity);
    const key=`${owner}:${u.href}`,prior=[...this.motion.values()].find(x=>x.key===key&&x.expires>Date.now()+5000);
    let id=prior?.id;if(!id){id=crypto.randomBytes(24).toString('base64url');this.motion.set(id,{id,key,url:u.href,owner,expires:expiry});}
    while(this.motion.size>3000)this.motion.delete(this.motion.keys().next().value);
    return `/api/artwork/motion?id=${id}${session.token?'&token='+encodeURIComponent(session.token):''}`;
  }
  async proxyMotion(req,res,id,session) {
    if(this.closing)throw new Error('Media service stopped.');
    const record=this.motion.get(String(id));if(!record||record.owner!==this._owner(session)||record.expires<=Date.now())throw Object.assign(new Error('Motion artwork is unavailable or expired.'),{status:404});
    const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),30_000);deadline.unref?.();
    const close=()=>controller.abort();res.once('close',close);this.controllers.add(controller);let body;
    try{
      let target=record.url,response;
      const requestHeaders={'User-Agent':'Mozilla/5.0 MusicByA/7.0','Accept':'*/*',...(req.headers.range?{Range:req.headers.range}:{})};
      if(this.fetch){
        for(let redirects=0;redirects<=5;redirects++){
          await validatePublicUrl(target,{lookup:this.lookup,allowedHosts:MOTION_HOSTS,signal:controller.signal});
          response=await this.fetch(target,{redirect:'manual',signal:controller.signal,headers:requestHeaders});
          if([301,302,303,307,308].includes(response.status)){const loc=response.headers.get('location');await response.body?.cancel?.();if(!loc||redirects===5)throw new Error('Motion artwork redirect failed.');target=new URL(loc,target).href;continue;}break;
        }
        body=response?.body?Readable.fromWeb(response.body):Readable.from([]);
      }else{
        const opened=await require('./publicMedia').openPublicMedia(target,{lookup:this.lookup,request:this.request,allowedHosts:MOTION_HOSTS,signal:controller.signal,headers:requestHeaders});
        response=opened.response;body=response;target=opened.url;
      }
      controller.signal.throwIfAborted();
      const status=response?.status??response?.statusCode,header=name=>this.fetch?response.headers.get(name):response.headers[name];
      if(!(status>=200&&status<300))throw new Error(`Motion artwork provider HTTP ${status||'error'}.`);
      const ct=header('content-type')||'application/octet-stream';
      const hls=/mpegurl/i.test(ct)||/\.m3u8(?:$|\?)/i.test(target);
      res.setHeader('Cache-Control','private, max-age=180');res.setHeader('X-Content-Type-Options','nosniff');
      if(hls){
        const parts=[];let total=0;
        for await(const chunk of body){total+=chunk.length;if(total>2*1024**2)throw new Error('Motion playlist is too large.');parts.push(chunk);}
        const rewritten=rewriteHls(Buffer.concat(parts).toString('utf8'),target,u=>{const issued=this.issueMotion(u,session,{ttlMs:Math.max(30_000,record.expires-Date.now())});if(!issued)throw new Error('Motion playlist references an untrusted media host.');return issued;});
        res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl','Content-Length':Buffer.byteLength(rewritten)});res.end(req.method==='HEAD'?'':rewritten);
      }else{
        const headers={'Content-Type':ct,'Accept-Ranges':header('accept-ranges')||'bytes'};
        for(const name of ['content-length','content-range'])if(header(name))headers[name]=header(name);
        res.writeHead(status,headers);if(req.method==='HEAD'){body.destroy();res.end();}else if(this.maxDownloadBytes){let bytes=0;const limit=new Transform({transform:(chunk,_encoding,done)=>{bytes+=chunk.length;done(this.maxDownloadBytes&&bytes>this.maxDownloadBytes?new Error('Motion media is too large.'):null,chunk);}});await pipeline(body,limit,res,{signal:controller.signal});}else await pipeline(body,res,{signal:controller.signal});
      }
    }finally{clearTimeout(deadline);res.removeListener('close',close);body?.destroy();this.controllers.delete(controller);}
  }
  async _download(kind,track,{dir,signal}) {
    const {downloadPublicMedia}=require('./publicMedia'),sources=require('./platformSources'),download=require('./audioDownload');
    const source=sources.canonicalSourceUrl(track);let file,mime;
    if(!sources.isSourceUrl(source)){
      const ext=path.extname(new URL(source).pathname).toLowerCase(),output=path.join(dir,kind+(/^\.(?:mp3|m4a|mp4|aac|flac|ogg|opus|wav|webm|aif|aiff|mov|mkv)$/.test(ext)?ext:'.source'));
      const downloaded=await downloadPublicMedia(source,{path:output,lookup:this.lookup,request:this.request,maxBytes:this.maxDownloadBytes,signal});file=downloaded.path;
      mime=/^(?:audio|video)\//i.test(downloaded.mime)?downloaded.mime:mediaMime(kind,file);
    }else{
      const output=path.join(dir,kind+'.%(ext)s');
      const result=await download.downloadWithStrategies({url:source,output,kind,original:true,maxBytes:this.maxDownloadBytes,cwd:dir,signal});
      const names=await fsp.readdir(dir),announced=result.finalPath||names.find(name=>name.startsWith(kind+'.')&&!/\.(?:part|ytdl|json|tmp|temp)$/.test(name));
      if(!announced)throw new Error('The source did not return playable media.');
      file=path.resolve(dir,announced);if(path.dirname(file)!==path.resolve(dir))throw new Error('The source returned an unexpected media output path.');mime=mediaMime(kind,file);
    }
    const stat=await fsp.lstat(file);if(!stat.isFile())throw new Error('The source did not return a regular media file.');
    const meta=await probeMedia(file,{requireAudio:kind==='audio',signal});
    if(kind==='video'){
      const prepared=await prepareVideoFile(file,{metadata:meta,signal});
      if(prepared.path!==file)await fsp.rm(file,{force:true});return prepared;
    }
    return {path:file,mime,metadata:{...meta,sourceOriginal:true,compatibilityEncoded:false},quality:originalQuality('audio',meta)};
  }

  async sweep(){
    await this.ready;const now=Date.now();await this._mutate(async()=>{for(const job of this.jobs.values())if(job.expires<=now)await this._discard(job);});
    for(const [id,item]of this.motion)if(item.expires<=now)this.motion.delete(id);
    await this._reclaimOrphans();
  }
  close(){
    if(this.closePromise)return this.closePromise;this.closing=true;clearInterval(this.timer);
    const stopped=Object.assign(new Error('Media service stopped.'),{name:'AbortError',code:'ABORT_ERR'});
    for(const controller of this.controllers)controller.abort(stopped);for(const waiter of this.waiting.splice(0))waiter.reject(stopped);
    this.closePromise=(async()=>{await Promise.allSettled([...this.pendingWork,this.ready,this.mutations]);for(const job of this.jobs.values())await fsp.rm(job.dir,{recursive:true,force:true}).catch(()=>{});this.jobs.clear();this.cache.clear();this.motion.clear();this.controllers.clear();})();
    return this.closePromise;
  }
}
module.exports={PlatformMedia,prepareVideoFile,parseRange,buildVideoArgs,validatePublicUrl,privateAddress,rewriteHls};
