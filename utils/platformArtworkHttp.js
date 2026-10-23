'use strict';
const {randomBytes}=require('node:crypto');
const {isAllowedArtworkUrl,ARTWORK_IMAGE_HOSTS}=require('./platformArtwork');
const {openPublicMedia}=require('./publicMedia');

const failure=(message,code='ARTWORK_UNAVAILABLE')=>Object.assign(new Error(message),{code});
function aborted(signal){return signal?.reason||failure('Artwork request cancelled.','ABORT_ERR');}
function bounded(work,signal,timeoutMs){
    if(signal?.aborted)return Promise.reject(aborted(signal));
    return new Promise((resolve,reject)=>{
        const cancel=()=>reject(aborted(signal));
        const timer=setTimeout(()=>reject(failure('Artwork identity lookup timed out.','ETIMEDOUT')),timeoutMs);
        signal?.addEventListener('abort',cancel,{once:true});
        Promise.resolve().then(work).then(resolve,reject).finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);});
    });
}
function raster(bytes,mime){
    if(mime==='image/png')return bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));
    if(mime==='image/jpeg'||mime==='image/jpg')return bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
    if(mime==='image/gif')return ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii'));
    if(mime==='image/webp')return bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP';
    if(mime==='image/avif')return bytes.subarray(4,8).toString('ascii')==='ftyp'&&/avif|avis/.test(bytes.subarray(8,36).toString('ascii'));
    return false;
}
function createArtworkHttp({artwork=require('./platformArtwork'),platform,uploads,openMedia=openPublicMedia,now=Date.now,
    ticketTtlMs=3600_000,maxImageBytes=128*1024**2,maxCacheBytes=256*1024**2,timeoutMs=30_000,maxConcurrent=4}={}){
    const tickets=new Map(),ownerUrls=new Map(),cache=new Map(),pending=new Map(),jobs=new Set(),queue=[];
    let closed=false,active=0,cacheBytes=0;
    const owner=session=>JSON.stringify([String(session?.u||''),String(session?.g||'')]);
    function prune(){for(const [id,ticket]of tickets)if(ticket.expires<=now()){tickets.delete(id);if(ownerUrls.get(ticket.key)===id)ownerUrls.delete(ticket.key);}}
    function ticket(url,session){
        if(!isAllowedArtworkUrl(url))return '';
        prune();const key=JSON.stringify([owner(session),url]),existing=ownerUrls.get(key);
        if(existing&&tickets.has(existing))return `/api/platform/artwork/image?id=${existing}`;
        while(tickets.size>=4000){const [id,item]=tickets.entries().next().value;tickets.delete(id);ownerUrls.delete(item.key);}
        const id=randomBytes(24).toString('hex');let exp=Number(session?.exp);if(exp>0&&exp<1e12)exp*=1000;
        tickets.set(id,{key,url,owner:owner(session),expires:Math.min(now()+ticketTtlMs,exp>0?exp:Infinity)});ownerUrls.set(key,id);
        return `/api/platform/artwork/image?id=${id}`;
    }
    function excluded(values,session){
        const result=[];for(const value of Array.isArray(values)?values.slice(0,20):[]){
            if(isAllowedArtworkUrl(value)){result.push(value);continue;}
            const match=/^\/api\/platform\/artwork\/image\?id=([a-f\d]{48})$/.exec(String(value));
            const record=match&&tickets.get(match[1]);if(record&&record.expires>now()&&record.owner===owner(session))result.push(record.url);
        }return [...new Set(result)];
    }
    async function resolve(body,session,{signal}={}){
        if(closed)throw failure('Artwork service is closed.','ARTWORK_CLOSED');
        if(signal?.aborted)throw aborted(signal);
        const input=body?.item&&typeof body.item==='object'?body.item:{};
        const identity=/^(deezer|itunes|musicbrainz|youtube):(track|album|artist|video|release|playlist):([^:]+)$/.exec(String(input.id||''));
        const privateUpload=input.source==='upload'||input.provider==='local-upload'||/^upload:/.test(String(input.id||''));
        if(privateUpload){
            const list=await bounded(()=>uploads?.list(session.u)||[],signal,8000);
            let own=list.find(item=>String(item.id).replace(/^upload:/,'')===String(input.id).replace(/^upload:/,'')||input.url&&item.url===input.url);
            const uploadId=own?String(own.id).replace(/^upload:/,''):'';
            if(own&&typeof uploads.cover==='function')try{await bounded(()=>uploads.cover(session.u,uploadId),signal,8000);}catch(e){if(signal?.aborted)throw aborted(signal);own=null;}
            return {url:own?`/api/platform/upload/art?id=${encodeURIComponent(uploadId)}`:'',fallbacks:[],official:Boolean(own),source:'owned-upload',validation:own?'verified':'unavailable',status:own?'ready':'unavailable',provenance:{artworkRole:'cover'}};
        }
        if(!identity)return {url:'',fallbacks:[],official:false,validation:'unavailable',status:'unavailable'};
        if(identity[2]==='playlist'&&identity[1]!=='deezer')return {url:'',fallbacks:[],official:false,validation:'unavailable',status:'unavailable'};
        const kind=identity[2]==='release'?'album':identity[2];
        if(input.kind&&input.kind!==kind)return {url:'',fallbacks:[],official:false,validation:'unavailable',status:'unavailable'};
        let item={kind,id:String(input.id),title:String(input.title||'').slice(0,240),author:String(input.author||'').slice(0,240),album:String(input.album||'').slice(0,240),duration:Math.max(0,Number(input.duration)||0)};
        // Shelf metadata originates in the catalog. The browser may send the ID,
        // but cannot replace a provider's identity or inject image fetch URLs.
        try{
            const detail=await bounded(()=>platform?.detail(kind,item.id),signal,8000);
            if(detail?.id===item.id&&(!detail.kind||detail.kind===kind))item={...detail,kind};
        }catch(e){if(signal?.aborted)throw aborted(signal);}
        if(identity[1]==='musicbrainz'&&kind==='track'){
            // This is a requested release constraint, verified against the
            // recording's linked releases by the resolver, never an image URL.
            const release=[input.releaseId,input.albumId].map(x=>String(x||'').replace(/^musicbrainz:release:/,''))
                .find(x=>/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(x));
            if(release)item={...item,releaseId:`musicbrainz:release:${release.toLowerCase()}`,albumId:`musicbrainz:release:${release.toLowerCase()}`};
        }
        const value=await bounded(()=>artwork.resolve(item,{failedUrls:excluded(body.failedUrls,session),timeoutMs:18_000}),signal,20_000);
        if(closed)throw failure('Artwork service is closed.','ARTWORK_CLOSED');
        const url=ticket(value?.url,session),fallbacks=(Array.isArray(value?.fallbacks)?value.fallbacks:[]).map(x=>ticket(x,session)).filter(Boolean);
        return {...value,url,fallbacks,official:Boolean(url&&value?.official),validation:url?value?.validation||'pending':'unavailable',status:url?'ready':'unavailable'};
    }
    function putCache(url,value){
        if(value.bytes.length>maxCacheBytes)return;
        if(cache.has(url)){cacheBytes-=cache.get(url).bytes.length;cache.delete(url);}
        cache.set(url,{...value,expires:now()+30*60_000});cacheBytes+=value.bytes.length;
        while(cacheBytes>maxCacheBytes&&cache.size){const key=cache.keys().next().value;cacheBytes-=cache.get(key).bytes.length;cache.delete(key);}
    }
    async function fetchImage(job){
        const {url,controller}=job;let opened;
        try{
            opened=await openMedia(url,{allowedHosts:ARTWORK_IMAGE_HOSTS,httpsOnly:true,signal:controller.signal,headerTimeoutMs:15_000,bodyIdleTimeoutMs:15_000,headers:{Accept:'image/avif,image/webp,image/png,image/jpeg,image/gif'}});
            controller.signal.throwIfAborted();const mime=String(opened.mime||opened.response.headers?.['content-type']||'').split(';')[0].toLowerCase();
            const chunks=[];let length=0;
            for await(const chunk of opened.response){controller.signal.throwIfAborted();length+=chunk.length;if(length>maxImageBytes)throw failure('Artwork image is too large.');chunks.push(Buffer.from(chunk));}
            const bytes=Buffer.concat(chunks);if(!raster(bytes,mime))throw failure('The artwork source did not return a supported image.');
            const cropped=await require('./youtubeArtwork').cropYoutubeArtwork(bytes,url);
            return {bytes:cropped,mime:cropped===bytes?mime:'image/jpeg'};
        }finally{opened?.cleanup?.();}
    }
    function pump(){
        while(!closed&&active<maxConcurrent&&queue.length){
            const job=queue.shift();active++;jobs.add(job);
            const timer=setTimeout(()=>job.controller.abort(failure('Artwork download timed out.','ETIMEDOUT')),timeoutMs);timer.unref?.();
            const abort=()=>job.reject(aborted(job.controller.signal));job.controller.signal.addEventListener('abort',abort,{once:true});
            // A physical worker remains occupied until the transport settles,
            // even if an injected transport ignores its AbortSignal.
            fetchImage(job).then(value=>{if(!closed&&!job.controller.signal.aborted){putCache(job.url,value);job.resolve(value);}},job.reject).finally(()=>{
                clearTimeout(timer);job.controller.signal.removeEventListener('abort',abort);active--;jobs.delete(job);pump();
            });
        }
    }
    function acquire(url){
        if(closed)return Promise.reject(failure('Artwork service is closed.','ARTWORK_CLOSED'));
        const hit=cache.get(url);if(hit&&hit.expires>now()){cache.delete(url);cache.set(url,hit);return Promise.resolve(hit);}
        if(hit){cacheBytes-=hit.bytes.length;cache.delete(url);}
        if(pending.has(url))return pending.get(url);
        if(queue.length>=64)return Promise.reject(failure('Artwork queue is busy.'));
        const controller=new AbortController();let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
        pending.set(url,promise);promise.finally(()=>{if(pending.get(url)===promise)pending.delete(url);}).catch(()=>{});
        queue.push({url,controller,resolve,reject});pump();return promise;
    }
    async function serve(req,res,id,session){
        prune();const value=tickets.get(String(id||''));if(closed||!value||value.owner!==owner(session)){res.writeHead(404,{'Cache-Control':'private, no-store'});res.end();return;}
        const image=await acquire(value.url);if(res.destroyed)return;
        res.writeHead(200,{'Content-Type':image.mime,'Content-Length':image.bytes.length,'Cache-Control':'private, max-age=1800','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:image.bytes);
    }
    async function close(){
        if(closed)return;closed=true;const reason=failure('Artwork service is closed.','ARTWORK_CLOSED');
        for(const job of queue.splice(0)){job.controller.abort(reason);job.reject(reason);}
        for(const job of jobs)job.controller.abort(reason);
        tickets.clear();ownerUrls.clear();cache.clear();cacheBytes=0;
    }
    return {resolve,serve,close};
}
module.exports={createArtworkHttp};
