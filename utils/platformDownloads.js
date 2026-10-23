'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {parseRange}=require('./platformMedia');
const {ZipStream}=require('./zipStream');
function filename(title,extension) {
    let name=String(title||'Audio').normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g,' ').trim().replace(/[. ]+$/,'').slice(0,150);
    if(!name || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name=`Audio ${name}`;
    return name+( /^\.[a-z\d]{1,8}$/i.test(extension)?extension:'.audio');
}
class PlatformDownloads {
    constructor({dataDir=path.join(__dirname,'..','data','web-downloads'),media,store=require('./platformStore'),resolveTrack=(...args)=>require('./platformSources').resolve(...args),recoverTrack=(...args)=>require('./platformSources').recover(...args),ttlMs=4*3600000}={}) {
        this.dataDir=path.resolve(dataDir);this.media=media;this.store=store;this.resolveTrack=resolveTrack;this.recoverTrack=recoverTrack;this.ttlMs=ttlMs;this.tickets=new Map();this.pending=new Set();this.transfers=new Set();this.preparing=new Set();this.streams=new Set();this.controllers=new Set();this.closed=false;
        this.ready=fsp.rm(this.dataDir,{recursive:true,force:true}).then(()=>fsp.mkdir(this.dataDir,{recursive:true}));this.ready.catch(()=>{});
        this.timer=setInterval(()=>void this.sweep().catch(()=>{}),60000);this.timer.unref?.();
    }
    owner(session){const u=String(session?.u||''),g=String(session?.g||'');if(!/^\d{5,32}$/.test(u)||!/^\d{5,32}$/.test(g))throw new Error('Invalid download session.');return `${u}:${g}`;}
    prepare(body,session,options={}) {const work=this._prepare(body,session,options);this.preparing.add(work);work.finally(()=>this.preparing.delete(work)).catch(()=>{});return work;}
    async _prepare(body,session,{signal}={}) {
        signal?.throwIfAborted();if(this.closed)throw new Error('Download service stopped.');
        const owner=this.owner(session),tracks=Array.isArray(body.tracks)?body.tracks:[body.track];
        if(!tracks.length||tracks.length>1000||tracks.some(t=>!t||typeof t!=='object'||Array.isArray(t)))throw Object.assign(new Error('Choose between 1 and 1000 tracks to download.'),{status:400});
        if(this.tickets.size+this.controllers.size>=512)throw Object.assign(new Error('The download queue is busy. Retry shortly.'),{status:429});
        const controller=new AbortController(),cancel=()=>controller.abort(signal.reason);signal?.addEventListener('abort',cancel,{once:true});this.controllers.add(controller);if(signal?.aborted)cancel();
        const id=crypto.randomUUID(),dir=path.join(this.dataDir,id),entries=[];let archive;
        try {
            await this.ready;controller.signal.throwIfAborted();await fsp.mkdir(dir,{recursive:true});
            const output=path.join(dir,tracks.length>1?'collection.zip':'audio.source');
            if(tracks.length>1)archive=await fsp.open(output,'wx',0o600);
            const zip=archive?new ZipStream(archive,{signal:controller.signal}):null;
            for(let index=0;index<tracks.length;index++) {
                let track=await this.resolveTrack(tracks[index],session.u,{kind:'audio',signal:controller.signal});controller.signal.throwIfAborted();
                let result;try{result=await this.media.prepare('audio',track,session,{signal:controller.signal});}
                catch(error){
                    controller.signal.throwIfAborted();
                    const catalog=/^(deezer|itunes|musicbrainz|spotify|tidal):(track|album):/.test(String(tracks[index].id||track.id||''))||Boolean(track.metadataProvider||track.linkedProvider);
                    if(!catalog||!require('./audioDownload').isRetryableDownloadError(error))throw error;
                    const recovered=await this.recoverTrack(track,session.u,{kind:'audio',failedUrl:track.url,error,signal:controller.signal});controller.signal.throwIfAborted();
                    if(!recovered||recovered.url===track.url)throw error;
                    track=recovered;result=await this.media.prepare('audio',track,session,{signal:controller.signal});
                }
                controller.signal.throwIfAborted();const job=this.media.get(result.id,session);
                const name=filename(track.title,path.extname(job.path)),entry={track:job.track||track,filename:name,mime:job.mime,quality:job.quality,bytes:job.size};
                if(zip) await zip.add(`${String(index+1).padStart(3,'0')} ${name}`,job.path);
                else await pipeline(fs.createReadStream(job.path),fs.createWriteStream(output,{flags:'wx',mode:0o600}),{signal:controller.signal});
                entries.push(entry);
            }
            if(zip)await zip.finish();await archive?.close();archive=null;controller.signal.throwIfAborted();
            const stat=await fsp.stat(output),ticket={id,owner,dir,path:output,bytes:stat.size,filename:tracks.length>1?filename(body.title||'My music collection','.zip'):entries[0].filename,mime:tracks.length>1?'application/zip':entries[0].mime,quality:tracks.length>1?'Original source files':entries[0].quality,expiresAt:Date.now()+this.ttlMs,entries,readers:0};
            this.tickets.set(id,ticket);return {id,url:`/api/platform/download/file?id=${id}`,filename:ticket.filename,bytes:ticket.bytes,mime:ticket.mime,quality:ticket.quality,expiresAt:ticket.expiresAt,track:entries[0].track,count:entries.length};
        }catch(e){await archive?.close().catch(()=>{});await fsp.rm(dir,{recursive:true,force:true});throw e;}
        finally{signal?.removeEventListener('abort',cancel);this.controllers.delete(controller);}
    }
    get(id,session){const ticket=this.tickets.get(String(id));if(!ticket||ticket.owner!==this.owner(session)||ticket.expiresAt<=Date.now())throw Object.assign(new Error('Download is unavailable or expired.'),{status:404});return ticket;}
    complete(ticket,session) {
        if(ticket.completed||ticket.recording)return ticket.recording;
        const work=(async()=>{
            for(let i=0;i<ticket.entries.length;i++) {
                const entry=ticket.entries[i];let failure;
                for(let retry=0;retry<3;retry++) {
                    try{await this.store.recordDownload(session.u,entry.track,{...entry,id:ticket.entries.length>1?`${ticket.id}:${i}`:ticket.id,guildId:session.g});failure=null;break;}
                    catch(e){failure=e;if(retry<2)await new Promise(r=>setTimeout(r,100*(retry+1)));}
                }
                if(failure)throw failure;
            }
            ticket.completed=true;
        })();
        ticket.recording=work;this.pending.add(work);work.catch(e=>{ticket.recordError=String(e.message||'Could not record download.');}).finally(()=>{ticket.recording=null;this.pending.delete(work);});return work;
    }
    serve(req,res,id,session) {
        const ticket=this.get(id,session);let range;try{range=parseRange(req.headers.range,ticket.bytes);}catch(_){res.writeHead(416,{'Content-Range':`bytes */${ticket.bytes}`});res.end();return;}
        const fallback=ticket.filename.replace(/[^\x20-\x7e]|["\\]/g,'_'),headers={'Content-Type':ticket.mime,'Content-Length':range?.length||ticket.bytes,'Accept-Ranges':'bytes','Content-Disposition':`attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(ticket.filename).replace(/'/g,'%27')}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
        if(range)headers['Content-Range']=`bytes ${range.start}-${range.end}/${ticket.bytes}`;res.writeHead(range?206:200,headers);
        if(req.method==='HEAD'){res.end();return;}
        ticket.readers++;const stream=fs.createReadStream(ticket.path,range?{start:range.start,end:range.end}:{});this.streams.add(stream);let complete=false,done;
        const transfer=new Promise(resolve=>{done=resolve;});this.transfers.add(transfer);transfer.finally(()=>this.transfers.delete(transfer));
        res.once('finish',()=>{if(!range&&!req.aborted&&stream.bytesRead===ticket.bytes){complete=true;Promise.resolve(this.complete(ticket,session)).then(done,done);}else done();});
        res.once('close',()=>{ticket.readers--;this.streams.delete(stream);stream.destroy();if(!complete){ticket.lastAbortedAt=Date.now();done();}});stream.once('error',e=>res.destroy(e));stream.pipe(res);
    }
    async flush(){await Promise.all([...this.transfers]);await Promise.all([...this.pending]);}
    async sweep(){await this.ready;for(const [id,t]of this.tickets)if(t.expiresAt<=Date.now()&&!t.readers&&!t.recording){this.tickets.delete(id);await fsp.rm(t.dir,{recursive:true,force:true});}}
    async close(){this.closed=true;clearInterval(this.timer);for(const c of this.controllers)c.abort();for(const stream of this.streams)stream.destroy(new Error('Download service stopped.'));await Promise.allSettled([...this.preparing]);await this.flush().catch(()=>{});await this.ready;await fsp.rm(this.dataDir,{recursive:true,force:true});this.tickets.clear();}
}
module.exports={PlatformDownloads,filename};
