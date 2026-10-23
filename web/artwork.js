'use strict';
(function(root){
    function createArtworkManager({request,setSources,imageFailed,now=Date.now,maxConcurrent=4,maxEntries=512,positiveTtlMs=30*60_000,negativeTtlMs=45_000,makeObserver}={}){
        const targets=new WeakMap(),listening=new WeakSet(),visible=new WeakSet(),entries=new Map(),queue=[],deferred=new Set(),controllers=new Set();let active=0,closed=false;
        const observer=makeObserver?makeObserver(reveal):typeof IntersectionObserver==='function'?new IntersectionObserver(reveal,{rootMargin:'240px'}):null;
        function normalized(item){
            if(!item||typeof item!=='object')return null;let id=String(item.id||'');
            if(id&&!id.startsWith('upload:')&&(item.source==='upload'||item.provider==='local-upload'))id=`upload:${id}`;
            if(!id||/^[\w-]{11}$/.test(id)){for(const source of [item.providerUrl,item.url])try{const u=new URL(source);if(u.protocol!=='https:'||u.username||u.password||u.port)continue;
                if(['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','youtu.be'].includes(u.hostname)){const v=u.hostname==='youtu.be'?/^\/([\w-]{11})\/?$/.exec(u.pathname)?.[1]:u.pathname==='/watch'?u.searchParams.get('v'):/^\/(?:shorts|live)\/([\w-]{11})\/?$/.exec(u.pathname)?.[1];if(/^[\w-]{11}$/.test(v||'')&&(!id||id===v)){id=`youtube:${item.kind==='video'?'video':'track'}:${v}`;break;}}
                else if(!id&&['deezer.com','www.deezer.com'].includes(u.hostname)){const m=/\/(track|album|artist|playlist)\/(\d+)/.exec(u.pathname);if(m){id=`deezer:${m[1]}:${m[2]}`;break;}}}catch(_){} }
            if(!/^(?:deezer|itunes|musicbrainz|youtube):(track|album|artist|video|release):[^:]+$|^deezer:playlist:\d+$|^upload:/.test(id))return null;
            return {...item,id,kind:item.kind||(/^\w+:(\w+):/.exec(id)?.[1]==='release'?'album':/^\w+:(\w+):/.exec(id)?.[1])||'track'};
        }
        function keyFor(value){return value.id.startsWith('musicbrainz:track:')?JSON.stringify([value.id,value.releaseId||value.albumId||'',value.releaseDate||'']):value.id;}
        function temporary(value){return value?.official===false||value?.provider==='youtube'||/^youtube-/.test(value?.source||'');}
        function videoSource(entry){return /ytimg\.com|img\.youtube\.com/.test(entry.item.thumbnail||'')||entry.item.artwork?.provider==='youtube'||/^youtube-/.test(entry.item.artwork?.source||'');}
        function hints(value){return JSON.stringify([value.mediaTitle||value.title||'',value.mediaArtist||value.author||'',value.album||'',value.releaseDate||'',Number(value.duration||0)]);}
        function sources(entry){const value=entry.result&&entry.until>now()?entry.result:null;return [...new Set([value?.url,...(value?.fallbacks||[]),entry.item.thumbnail||entry.item.image,...(entry.item.artworkFallbacks||[])].filter(x=>typeof x==='string'&&x&&!entry.failed.has(x)))];}
        function cleanup(entry){for(const img of entry.images)if(!img.isConnected||targets.get(img)!==entry)entry.images.delete(img);}
        function apply(img,entry){if(targets.get(img)!==entry)return;setSources(img,sources(entry));}
        function retry(entry){
            clearTimeout(entry.retryTimer);entry.misses=(entry.misses||0)+1;
            const delay=Math.min(5*60_000,negativeTtlMs*2**Math.min(3,entry.misses-1));entry.until=now()+delay;
            entry.retryTimer=setTimeout(()=>{entry.retryTimer=null;cleanup(entry);if(closed||!entry.images.size)return;entry.until=0;enqueue(entry);},delay);
        }
        function reveal(items){for(const value of items)if(value.isIntersecting){visible.add(value.target);observer?.unobserve(value.target);const entry=targets.get(value.target);if(entry)enqueue(entry);}}
        function enqueue(entry){
            if(closed||entry.pending||entry.queued||entry.until>now())return;
            if(observer&&![...entry.images].some(img=>visible.has(img)))return;
            cleanup(entry);if(!entry.images.size)return;
            if(queue.length>=64){deferred.add(entry);return;}
            entry.queued=true;queue.push(entry);pump();
        }
        function pump(){
            for(const entry of deferred){if(closed||queue.length>=64)break;deferred.delete(entry);cleanup(entry);
                if(!entry.pending&&!entry.queued&&entry.until<=now()&&entry.images.size&&(!observer||[...entry.images].some(img=>visible.has(img)))){entry.queued=true;queue.push(entry);}}
            while(!closed&&active<maxConcurrent&&queue.length){
            const entry=queue.shift();entry.queued=false;cleanup(entry);if(!entry.images.size)continue;
            entry.pending=true;active++;const controller=new AbortController();controllers.add(controller);
            const timer=setTimeout(()=>controller.abort(),30_000);
            const abortPromise=new Promise((_resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('Artwork request cancelled.')),{once:true}));
            const version=entry.version,item={...entry.item};
            const job=Promise.resolve().then(()=>request({item,failedUrls:[...entry.failed].slice(-20)},{signal:controller.signal}));
            Promise.race([job,abortPromise]).then(value=>{
                if(closed||controller.signal.aborted||version!==entry.version)return;
                const valid=value?.url&&!entry.failed.has(value.url);
                entry.result=valid?value:null;entry.until=now()+(valid&&!temporary(value)?positiveTtlMs:negativeTtlMs);
                if(valid&&!temporary(value)){clearTimeout(entry.retryTimer);entry.retryTimer=null;entry.misses=0;}else retry(entry);
                cleanup(entry);for(const img of entry.images)apply(img,entry);
            },()=>{if(version===entry.version&&!closed)retry(entry);}).finally(()=>{clearTimeout(timer);controllers.delete(controller);entry.pending=false;active--;if(version!==entry.version&&(!sources(entry).length||videoSource(entry)))enqueue(entry);pump();});
        }}
        function entryFor(item){
            const value=normalized(item);if(!value)return null;const key=keyFor(value);let entry=entries.get(key);
            if(!entry){while(entries.size>=maxEntries){const candidate=[...entries].find(([,e])=>!e.pending&&!e.queued);if(!candidate)return null;clearTimeout(candidate[1].retryTimer);deferred.delete(candidate[1]);entries.delete(candidate[0]);}entry={item:value,failed:new Set(),images:new Set(),until:0,result:null,pending:false,queued:false,version:0,misses:0,retryTimer:null};entries.set(key,entry);}
            else {const merged={...entry.item,...value},newSource=merged.thumbnail||merged.image||'',oldSource=entry.item.thumbnail||entry.item.image||'';
                if(hints(merged)!==hints(entry.item)||(newSource&&newSource!==oldSource&&!/ytimg\.com|img\.youtube\.com/.test(newSource)&&merged.artwork?.provider!=='youtube'&&!/^youtube-/.test(merged.artwork?.source||''))){entry.version++;clearTimeout(entry.retryTimer);entry.retryTimer=null;entry.misses=0;if(!entry.result||temporary(entry.result)){entry.result=null;entry.until=0;}}
                entry.item=merged;}
            return entry;
        }
        function watch(img,item,{listen=true,eager=false}={}){
            if(closed||!img)return;const entry=entryFor(item);
            if(listen&&!listening.has(img)){listening.add(img);img.addEventListener('error',()=>{if(!failed(img))imageFailed(img);});}
            if(!entry){const old=targets.get(img);old?.images.delete(img);targets.delete(img);setSources(img,[item?.thumbnail||item?.image,...(item?.artworkFallbacks||[])].filter(Boolean));return;}
            const old=targets.get(img);if(old&&old!==entry)old.images.delete(img);targets.set(img,entry);entry.images.add(img);
            apply(img,entry);const needsRecovery=!sources(entry).length||videoSource(entry);
            if(needsRecovery){if(eager||!observer)visible.add(img);else if(!visible.has(img))observer.observe(img);if(!img.isConnected&&(eager||!observer))queueMicrotask(()=>enqueue(entry));else enqueue(entry);}
        }
        function failed(img){
            const entry=targets.get(img);if(!entry)return false;
            const source=img.dataset.requestedArt,reported=source&&!img.classList.contains('no-art');if(reported){entry.failed.add(source);while(entry.failed.size>30)entry.failed.delete(entry.failed.values().next().value);}
            imageFailed(img);
            if(img.classList.contains('no-art')&&reported){clearTimeout(entry.retryTimer);entry.retryTimer=null;entry.result=null;entry.until=0;visible.add(img);enqueue(entry);}
            return true;
        }
        function cached(item){const value=normalized(item),entry=value&&entries.get(keyFor(value));if(!entry?.result||entry.until<=now())return null;const available=[entry.result.url,...(entry.result.fallbacks||[])].filter(x=>x&&!entry.failed.has(x));return available.length?{...entry.result,url:available[0],fallbacks:available.slice(1)}:null;}
        function close(){closed=true;observer?.disconnect();for(const controller of controllers)controller.abort();for(const entry of entries.values())clearTimeout(entry.retryTimer);queue.length=0;deferred.clear();entries.clear();}
        return {watch,failed,cached,close};
    }
    if(typeof module==='object'&&module.exports)module.exports={createArtworkManager};
    else root.MusicArtwork={createArtworkManager};
})(typeof window==='object'?window:globalThis);
