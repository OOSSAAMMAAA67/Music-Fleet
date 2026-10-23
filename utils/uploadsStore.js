'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { spawn } = require('node:child_process');
const { resolveFfmpegPath } = require('./ffmpegResolver');
const performance = require('./performanceProfile');
const { dataDirectory } = require('./dataPaths');

const UPLOAD_HOST = 'local.music-by-a.invalid';
const ID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const AUDIO_EXT = new Set(['.mp3','.m4a','.mp4','.aac','.flac','.ogg','.opus','.wav','.webm','.aif','.aiff']);
const LOCAL_INPUT_ARGS = ['-protocol_whitelist','file,pipe','-format_whitelist','aac,aiff,amr,ape,asf,au,avi,flac,matroska,webm,mov,mp3,mpeg,mpegts,ogg,wav,tta,wv'];
function unavailable(message='Uploaded audio is unavailable.') { return Object.assign(new Error(message),{status:404}); }
function userId(user) {
  const value=String(typeof user==='string'?user:user?.id||'');
  if(!/^\d{5,32}$/.test(value)) throw new Error('Invalid upload owner.');
  return value;
}
function parseUploadUrl(input) {
  try {
    const u=new URL(String(input));
    if(u.protocol!=='https:'||u.hostname!==UPLOAD_HOST||u.username||u.password||u.port||u.search||u.hash) return null;
    const match=u.pathname.match(/^\/uploads\/(\d{5,32})\/([a-f\d-]{36})$/i);
    return match&&ID.test(match[2])?{userId:match[1],id:match[2]}:null;
  } catch (_) {return null;}
}
async function capture(command,args,timeoutMs=20_000,signal) {
  if(signal?.aborted)throw new Error('Media inspection was cancelled.');
  return new Promise((resolve,reject)=>{
    let output='',done=false;
    const child=spawn(command,args,{windowsHide:true,stdio:['ignore','ignore','pipe'],shell:false});
    performance.registerChildProcess(child,'background');
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('Media inspection timed out.'));},timeoutMs);
    timer.unref?.();
    const abort=()=>{try{child.kill('SIGKILL');}catch(_){}finish(new Error('Media inspection was cancelled.'));};
    const finish=(err,code)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);err?reject(err):resolve({output,code});};
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    child.stderr.on('data',chunk=>{output=(output+chunk.toString()).slice(-32768);});
    child.once('error',finish);child.once('close',code=>finish(null,code));
  });
}
async function probeMedia(file,{requireAudio=true,signal}={}) {
  const ffmpeg=resolveFfmpegPath();
  const metadata=await capture(ffmpeg,['-nostdin','-hide_banner',...LOCAL_INPUT_ARGS,'-i',file],20_000,signal);
  const raw=metadata.output;
  const audio=raw.match(/Audio:\s*([^,]+),\s*(\d+)\s*Hz/);
  const videoLine=raw.split('\n').find(s=>s.includes('Video:')&&!s.includes('attached pic'))||'';
  const video=videoLine.match(/Video:\s*([^,]+),.*?\b(\d{2,5})x(\d{2,5})\b/);
  if(requireAudio&&!audio) throw new Error('The uploaded file has no decodable audio.');
  const time=raw.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration=time?Number(time[1])*3600+Number(time[2])*60+Number(time[3]):0;
  const validation=await capture(ffmpeg,['-nostdin','-v','error',...LOCAL_INPUT_ARGS,'-i',file,'-map',requireAudio?'0:a:0':'0:v:0','-t','0.1','-f','null','-'],20_000,signal);
  if(validation.code!==0) throw new Error('The media could not be decoded.');
  return {duration,audioCodec:audio?.[1]||'',sampleRate:Number(audio?.[2]||0),width:Number(video?.[2]||0),height:Number(video?.[3]||0),videoCodec:video?.[1]||''};
}
class UploadsStore {
  constructor({dataDir=path.join(dataDirectory(),'uploads'),maxBytes=Number(process.env.WEB_MAX_UPLOAD_BYTES)||0,probe=probeMedia}={}) {
    this.dataDir=path.resolve(dataDir);this.maxBytes=Number.isFinite(Number(maxBytes))&&Number(maxBytes)>0?Math.max(1024,Number(maxBytes)):0;this.probe=probe;
  }
  _directory(user,id) {return path.join(this.dataDir,userId(user),String(id));}
  async import(user,readable,{filename='audio.mp3',title='',author='Your uploads'}={}) {
    const owner=userId(user),id=crypto.randomUUID();
    const ext=path.extname(path.basename(String(filename).replace(/\\/g,'/'))).toLowerCase();
    if(!AUDIO_EXT.has(ext)) throw new Error('Choose an MP3, M4A, FLAC, WAV, OGG, OPUS, AAC or WebM audio file.');
    const dir=this._directory(owner,id),target=path.join(dir,'original'+ext);
    await fsp.mkdir(dir,{recursive:true});
    let size=0;
    const counter=new Transform({transform:(chunk,_enc,cb)=>{size+=chunk.length;if(this.maxBytes&&size>this.maxBytes){const e=new Error('Audio upload exceeds the file size limit.');e.status=413;cb(e);}else cb(null,chunk);}});
    try {
      await pipeline(readable,counter,fs.createWriteStream(target,{flags:'wx',mode:0o600}));
      if(!size) throw new Error('The audio file is empty.');
      const meta=await this.probe(target);
      let cover=false;
      try {const r=await capture(resolveFfmpegPath(),['-nostdin','-v','error',...LOCAL_INPUT_ARGS,'-i',target,'-map','0:v:0','-frames:v','1','-vf','scale=1200:1200:force_original_aspect_ratio=decrease','-y',path.join(dir,'cover.jpg')],10_000);cover=r.code===0&&(await fsp.stat(path.join(dir,'cover.jpg'))).size>0;}catch(_){}
      const item={kind:'track',id,title:String(title||path.basename(filename,ext)||'Uploaded audio').trim().slice(0,220),author:String(author||'Your uploads').slice(0,160),
        url:`https://${UPLOAD_HOST}/uploads/${owner}/${id}`,source:'upload',provider:'local-upload',duration:meta.duration,
        thumbnail:cover?`/api/platform/upload/art?id=${id}`:'',filename:String(filename).replace(/^.*[\\/]/,'').slice(0,180),bytes:size,
        mime:mimeForExtension(ext),uploadedAt:new Date().toISOString(),audioCodec:meta.audioCodec,sampleRate:meta.sampleRate};
      await fsp.writeFile(path.join(dir,'metadata.json'),JSON.stringify({version:1,owner,file:'original'+ext,item}),{flag:'wx',mode:0o600});
      return item;
    } catch(e) {await fsp.rm(dir,{recursive:true,force:true});throw e;}
  }
  async resolve(user,urlOrId) {
    const owner=userId(user),parsed=ID.test(String(urlOrId))?{userId:owner,id:String(urlOrId)}:parseUploadUrl(urlOrId);
    if(!parsed) throw unavailable();
    if(parsed.userId!==owner) throw unavailable();
    const dir=this._directory(owner,parsed.id);
    let meta;
    try {meta=JSON.parse(await fsp.readFile(path.join(dir,'metadata.json'),'utf8'));}catch(_){throw unavailable();}
    if(meta.owner!==owner||!/^original\.[a-z0-9]+$/.test(meta.file)||!AUDIO_EXT.has(path.extname(meta.file))) throw unavailable();
    const file=path.join(dir,meta.file),stat=await fsp.lstat(file).catch(()=>{throw unavailable();});
    if(!stat.isFile()||stat.isSymbolicLink())throw unavailable();
    return {...meta.item,path:file,size:stat.size};
  }
  async resolveTrack(track) {
    const parsed=parseUploadUrl(track?.url);if(!parsed)return null;
    const item=await this.resolve(parsed.userId,track.url);
    if(track?.requesterId&&String(track.requesterId)!==parsed.userId) throw unavailable();
    return item;
  }
  async cover(user,id) {
    await this.resolve(user,id);
    const file=path.join(this._directory(user,id),'cover.jpg'),stat=await fsp.lstat(file).catch(()=>{throw unavailable('Upload artwork is unavailable.');});
    if(!stat.isFile()||stat.isSymbolicLink())throw unavailable('Upload artwork is unavailable.');
    return file;
  }
  async list(user) {
    const owner=userId(user),dir=path.join(this.dataDir,owner);
    const entries=await fsp.readdir(dir,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    const results=await Promise.allSettled(entries.filter(e=>e.isDirectory()&&ID.test(e.name)).map(async e=>{const t=await this.resolve(owner,e.name);delete t.path;delete t.size;return t;}));
    return results.filter(r=>r.status==='fulfilled').map(r=>r.value).sort((a,b)=>b.uploadedAt.localeCompare(a.uploadedAt));
  }
  async remove(user,id) {await this.resolve(user,id);await fsp.rm(this._directory(user,id),{recursive:true,force:true});return true;}
}
function mimeForExtension(ext) {return ({'.mp3':'audio/mpeg','.m4a':'audio/mp4','.mp4':'video/mp4','.wav':'audio/wav','.flac':'audio/flac','.ogg':'audio/ogg','.opus':'audio/ogg','.aac':'audio/aac','.webm':'audio/webm','.aif':'audio/aiff','.aiff':'audio/aiff'})[ext]||'application/octet-stream';}
module.exports=new UploadsStore();
module.exports.UploadsStore=UploadsStore;module.exports.parseUploadUrl=parseUploadUrl;module.exports.probeMedia=probeMedia;module.exports.mimeForExtension=mimeForExtension;
module.exports.LOCAL_INPUT_ARGS=LOCAL_INPUT_ARGS;
