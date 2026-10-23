'use strict';
const {parseUploadUrl}=require('./uploadsStore');
const {validatePublicUrl}=require('./platformMedia');
function normalized(value){return String(value||'').normalize('NFKD').replace(/[\u0300-\u036f\u064B-\u065F\u0670\u06D6-\u06ED]/g,'').replace(/\u0640/g,'').normalize('NFC').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').toLowerCase().replace(/\b(official|audio|music video|lyric(?:s| video)?|visualizer|hd|hq|4k|8k)\b/gi,' ').replace(/[^\p{L}\p{M}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');}
function tokens(value){return new Set(normalized(value).split(' ').filter(Boolean));}
function overlap(a,b){const x=tokens(a),y=tokens(b);if(!x.size)return 0;return [...x].filter(w=>y.has(w)).length/x.size;}
function variant(value){
 const raw=String(value||'').normalize('NFKD').replace(/[\u0300-\u036f\u064B-\u065F\u0670\u06D6-\u06ED]/g,'').toLowerCase(),kinds=[];
 for(const [name,pattern]of [['remix',/\bremix\b/],['cover',/\bcover\b/],['slowed',/\bslowed\b/],['sped',/\bsped(?: up)?\b/],['live',/\blive\b/],['acoustic',/\bacoustic\b/],['instrumental',/\binstrumental\b/],['nightcore',/\bnightcore\b/],['karaoke',/\bkaraoke\b/],['rework',/\brework\b/],['radio',/\bradio\s+(?:edit|mix|version)\b/],['extended',/\bextended(?:\s+(?:mix|edit|version))?\b/],['remaster',/\bremaster(?:ed)?\b/],['edit',/\bedit\b/]])if(pattern.test(raw))kinds.push(name);
 const named=raw.match(/[([]([^\])]{1,100}?\b(?:remix|mix|edit|version|remaster(?:ed)?))\s*[)\]]/i)?.[1]||raw.match(/[-–]\s*([^\n|]{1,100}?\b(?:remix|edit))/i)?.[1]||'';
 for(const [name,pattern]of [['remix',/ريمكس|ريميكس/],['cover',/(?:^|[\s()\-])(?:بصوت|كوفر)(?:[\s()\-]|$)/],['live',/حفلة|(?:^|\s)حفل(?:\s|$)|لايف/],['sped',/مسرع|مسرعة|تسريع/],['slowed',/بطيء|بطيئ|مبطأ|مبطئ|تبطيء/],['karaoke',/كاريوكي|كاراوكي/],['instrumental',/موسيقى فقط|بدون غناء/]])if(pattern.test(raw))kinds.push(name);
 return {kind:[...new Set(kinds)].sort().join('|'),name:normalized(named.replace(/\b(?:remix|mix|edit|version|original|radio|extended|remaster(?:ed)?|(?:19|20)\d{2})\b/gi,'')),year:kinds.includes('remaster')?raw.match(/\b(?:19|20)\d{2}\b/)?.[0]||'':''};
}
function urlHost(value){try{return new URL(value).hostname.toLowerCase();}catch(_){return '';}}
function isSoundCloudApiTrack(input){
 try{
  const u=new URL(String(input));
  return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.hostname==='api-v2.soundcloud.com'&&/^\/tracks\/\d+\/?$/.test(u.pathname)&&[...u.searchParams].every(([key,value])=>key==='secret_token'&&/^s-[\w-]{1,200}$/.test(value));
 }catch(_){return false;}
}
function isSourceUrl(input){return require('./publicMedia').isExtractorUrl(input)||isSoundCloudApiTrack(input);}
function safeWebpageUrl(input){const value=String(input||'').slice(0,2000);return isSourceUrl(value)?value:'';}
function deliveryProvider(input){const host=urlHost(input);return /(^|\.)googlevideo\.com$/.test(host)?'youtube':/(^|\.)sndcdn\.com$/.test(host)?'soundcloud':'';}
function canonicalSourceUrl(item){
 const raw=String(item?.url||'').slice(0,2000),page=safeWebpageUrl(item?.webpageUrl||item?.webpage_url),delivery=deliveryProvider(raw);
 if(delivery&&page&&((delivery==='youtube'&&/(^|\.)(?:youtube\.com|youtu\.be)$/.test(urlHost(page)))||(delivery==='soundcloud'&&/(^|\.)soundcloud\.com$/.test(urlHost(page)))))return page;
 return raw;
}
function sourceIdentity(input){
 try{const u=new URL(String(input));if(/(^|\.)(?:youtube\.com|youtu\.be)$/.test(u.hostname)){const id=u.hostname==='youtu.be'?u.pathname.slice(1).split('/')[0]:u.searchParams.get('v')||u.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1];if(id)return `youtube:${id}`;}u.hash='';if(isSoundCloudApiTrack(u.href))return `soundcloud:${u.pathname}:${u.searchParams.get('secret_token')||''}`;return u.href;}catch(_){return String(input||'');}
}
function metadataSource(item){return item.metadataOnly===true||/(^|\.)(deezer\.com|itunes\.apple\.com|music\.apple\.com)$/.test(urlHost(item.url||item.providerUrl))||['deezer','itunes','musicbrainz'].includes(item.provider)&&!/^youtube|soundcloud/.test(item.source||'');}
function safeImage(input){const value=String(input||'').slice(0,4096);return /^https:\/\//i.test(value)||/^\/api\/platform\/upload\/art\?id=[a-f\d-]+$/i.test(value)?value:'';}
function sanitize(item={}){
 const out={kind:['track','video'].includes(item.kind)?item.kind:'track',title:String(item.title||'').trim().slice(0,220),author:String(item.author||item.artist||'').trim().slice(0,160),url:canonicalSourceUrl(item),thumbnail:safeImage(item.thumbnail),duration:Math.max(0,Number(item.duration)||0),provider:String(item.provider||'').slice(0,40),source:String(item.source||'').slice(0,40),metadataOnly:Boolean(item.metadataOnly),previewOnly:Boolean(item.previewOnly)};
 for(const key of ['id','album','albumId','releaseId','releaseGroupId','artistId','albumArtist','providerUrl','linkedProvider','linkedOriginalUrl','linkedResolvedUrl','linkedThumbnail','linkedTitle','mediaTitle','mediaArtist','releaseDate','metadataProvider','description'])if(item[key]!=null)out[key]=String(item[key]).slice(0,/Url|Thumbnail|url|thumbnail/.test(key)?2000:320);
 const page=safeWebpageUrl(item.webpageUrl||item.webpage_url);if(page)out.webpageUrl=page;
 if(item.releaseYear!=null)out.releaseYear=Math.max(0,Number(item.releaseYear)||0);
 if(item.sourceRecoveryAttempts!=null)out.sourceRecoveryAttempts=Math.min(1,Math.max(0,Number(item.sourceRecoveryAttempts)||0));
 if(Array.isArray(item.genres))out.genres=item.genres.slice(0,16).map(x=>String(x).slice(0,80));
 if(typeof item.explicit==='boolean')out.explicit=item.explicit;
 return out;
}
function phonetic(value){
 const arabic={ا:'a',أ:'a',إ:'i',آ:'a',ب:'b',ت:'t',ث:'th',ج:'j',ح:'h',خ:'kh',د:'d',ذ:'dh',ر:'r',ز:'z',س:'s',ش:'sh',ص:'s',ض:'d',ط:'t',ظ:'z',ع:'a',غ:'gh',ف:'f',ق:'q',ك:'k',ل:'l',م:'m',ن:'n',ه:'h',ة:'h',و:'w',ي:'y',ى:'y',ء:'a',ؤ:'w',ئ:'y'};
 return normalized(value).replace(/[\u0600-\u06ff]/g,c=>arabic[c]||'').replace(/q/g,'k').replace(/g/g,'j').replace(/[aeiouwy]/g,'').replace(/[^a-z0-9]/g,'');
}
function sourceOverlap(expected,text){
 const direct=overlap(expected,text);if(direct>=.65)return direct;
 const key=phonetic(expected);
 const cross=/[\u0600-\u06ff]/.test(expected)&&/[a-z]/i.test(text)||/[a-z]/i.test(expected)&&/[\u0600-\u06ff]/.test(text);
 // Strong full-phrase phonetic identity handles Arabic catalog transliterations.
 // Artist/version/duration checks remain independent; short Latin homophones
 // are not admitted by a consonant-only comparison.
 if(key.length>=(cross?3:5)){
  const words=normalized(text).split(/\s+/).map(phonetic).filter(Boolean);
  for(let begin=0;begin<words.length;begin++){let phrase='';for(let end=begin;end<Math.min(words.length,begin+8);end++){phrase+=words[end];if(phrase===key)return .92;if(phrase.length>=key.length)break;}}
 }
 return direct;
}
function sourceFailure(message,code,{retryable=false,retryLimit=0,cause}={}){return Object.assign(new Error(message,{cause}),{code,retryable,retryLimit});}
function topicArtist(candidate){
 const description=String(candidate.description||'').slice(0,2000),title=normalized(candidate.mediaTitle||candidate.title);
 if(!/\s-\sTopic$/i.test(candidate.author||'')||!/^Provided to YouTube by\s/i.test(description))return '';
 const dot=description.indexOf('·');if(dot<0||!title||!normalized(description.slice(0,dot)).endsWith(title))return '';
 // Parse the recording credit emitted for an auto-generated music release.
 // Ordinary descriptions and unrelated artist mentions are never evidence.
 return description.slice(dot+1).split(/\r?\n|[℗©]|Released on:|Auto-generated by YouTube|\s(?:مسلسل|فيلم)\s/i)[0].trim().slice(0,200);
}
function recordingTitle(expected,candidate){
 const title=String(candidate.mediaTitle||candidate.title||'');
 if(/مسلسل|فيلم|\b(?:film|movie|series|soundtrack|ost)\b/i.test(expected.title||''))return title;
 // A TV/film credit identifies the production, not the song inside it.
 return title.replace(/(?:[-–|:]\s*)?(?:(?:من|اغنية|أغنية)\s+)?(?:مسلسل|فيلم)(?:\s|$).*$/i,'').replace(/(?:[-–|:]\s*)?\b(?:from\s+)?(?:series|soundtrack|ost)\b.*$/i,'').trim();
}
function sourceScore(expected,candidate,{kind='audio'}={}){
 const title=recordingTitle(expected,candidate),text=`${title} ${candidate.author||''}`,ev=variant(expected.title),cv=variant(candidate.title);
 if(/\b(?:reaction|tutorial|review|commentary|how to play)\b/i.test(candidate.title||'')&&!/\b(?:reaction|tutorial|review|commentary|how to play)\b/i.test(expected.title||''))return -Infinity;
 if(ev.kind!==cv.kind&&(ev.kind||cv.kind))return -Infinity;
 if(ev.year&&ev.year!==cv.year)return -Infinity;
 if(ev.name&&overlap(ev.name,cv.name||candidate.title)<.8)return -Infinity;
 const titleScore=sourceOverlap(expected.title,title);if(titleScore<.65)return -Infinity;
 const artist=sourceOverlap(expected.author,candidate.mediaArtist||topicArtist(candidate)||text);
 if(expected.author&&normalized(expected.author)!=='unknown artist'&&artist<.5)return -Infinity;
 const delta=Math.abs(Number(expected.duration||0)-Number(candidate.duration||0));
 if(expected.duration>0&&candidate.duration>0&&delta>Math.max(kind==='video'?30:12,expected.duration*(kind==='video'?.2:.12)))return -Infinity;
 return titleScore*12+artist*6+(expected.duration&&candidate.duration?4/(1+delta):0)+(/official|vevo|topic/i.test(text)?1:0)-(/reaction|tutorial|review/i.test(text)?12:0);
}
function awaitSource(work,signal){
 if(signal?.aborted)return Promise.reject(signal.reason);if(!signal)return Promise.resolve().then(work);
 return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>{signal.throwIfAborted();return work();}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
function catalogOrigin(item){
 const storefront=/(^|\.)(?:deezer\.com|itunes\.apple\.com|music\.apple\.com|spotify\.com|tidal\.com)$/.test(urlHost(item.url));
 const url=item.providerUrl||item.linkedOriginalUrl||(storefront?item.url:''),provider=String(item.metadataProvider||item.linkedProvider||((storefront||item.metadataOnly&&!isSourceUrl(item.url))?item.provider:'')).toLowerCase();
 const catalog=['deezer','itunes','apple','musicbrainz','spotify','tidal'].includes(provider)||/(^|\.)(?:deezer\.com|itunes\.apple\.com|music\.apple\.com|spotify\.com|tidal\.com)$/.test(urlHost(url));
 return catalog?{url,provider}:null;
}
function createPlatformSources({search=(...a)=>require('./ytDlpProvider').search(...a),validate=validatePublicUrl,uploads=require('./uploadsStore')}={}){
 async function resolve(input,user,{kind='audio',signal:consumerSignal,excludeUrls=[],forceRefresh=false,resolutionTimeoutMs=Number(require('../config').SOURCE_RESOLUTION_TIMEOUT_MS)||45_000}={}){
  const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(sourceFailure('Source resolution timed out.','SOURCE_RESOLUTION_TIMEOUT',{retryable:true,retryLimit:1})),Math.max(1,resolutionTimeoutMs));timer.unref?.();
  const signal=consumerSignal?AbortSignal.any([consumerSignal,deadline.signal]):deadline.signal;
  try{
   const item=sanitize(input),upload=parseUploadUrl(item.url),excluded=new Set(excludeUrls.map(sourceIdentity));signal.throwIfAborted();
   const accepted=t=>isSourceUrl(canonicalSourceUrl(t))&&!excluded.has(sourceIdentity(canonicalSourceUrl(t)));
   const check=url=>awaitSource(()=>validate(url,{signal}),signal);
   const find=(query,limit)=>awaitSource(()=>search(query,{limit,signal,forceRefresh}),signal);
   if(upload){if(upload.userId!==String(user))throw new Error('Uploaded audio belongs to a different owner.');const local=await awaitSource(()=>uploads.resolve(user,item.url),signal);return {...item,...local,requesterId:String(user),metadataOnly:false};}
   if(item.url&&/(^|\.)(spotify\.com|spotify\.link|tidal\.com|tidal\.link)$/.test(urlHost(item.url))){
    await check(item.url);const matches=await find(item.url,8);
    const expected=item.title&&item.author&&!/^https?:\/\//.test(item.title)&&!/^(?:Imported|Unknown artist)$/i.test(item.author)?item:null;
    const found=(matches||[]).filter(accepted);if(expected)found.sort((a,b)=>sourceScore(expected,b,{kind})-sourceScore(expected,a,{kind}));
    const selected=found.find(t=>!expected||Number.isFinite(sourceScore(expected,t,{kind})));
    if(!selected)throw sourceFailure('The linked music provider did not return a matching playable source.','SOURCE_NO_MATCH');
    await check(canonicalSourceUrl(selected));return {...sanitize(selected),title:expected?.title||selected.title,author:expected?.author||selected.author,id:item.id||selected.id,album:item.album||selected.album,albumId:item.albumId||selected.albumId,artistId:item.artistId||selected.artistId,
     linkedProvider:/spotify/.test(urlHost(item.url))?'spotify':'tidal',linkedOriginalUrl:item.url,providerUrl:item.url,linkedThumbnail:item.thumbnail||selected.linkedThumbnail||selected.thumbnail||'',source:selected.source||'youtube',mediaTitle:selected.mediaTitle||selected.title,mediaArtist:selected.mediaArtist||topicArtist(selected)||selected.author,metadataOnly:false};
   }
   if(item.url&&!metadataSource(item)&&!item.previewOnly){await check(item.url);return {...item,source:isSourceUrl(item.url)?item.source||(/soundcloud/i.test(item.url)?'soundcloud':'youtube'):'direct'};}
   if(!item.title||!item.author)throw sourceFailure('Track title and artist are required to resolve a source.','SOURCE_INVALID_METADATA');
   const base=`${item.author} ${item.title}`,plain=base.replace(/[()[\]]/g,' ').replace(/\s+/g,' ').trim();
   // Uploaders often publish remixes as a video release without "official
   // audio". Broaden only the search wording; every candidate still passes
   // the same artist, named-version and duration checks.
   const queries=[...new Set([`${base} ${kind==='video'?'official music video':'official audio'}`,base,plain,
    `${base} ${kind==='video'?'music video':variant(item.title).kind.includes('remix')?'video release':'audio'}`])];
   let selected,successfulSearches=0;const providerErrors=[];
   for(const query of queries){
    signal.throwIfAborted();let candidates;
    try{candidates=await find(query,12);successfulSearches++;}catch(error){signal.throwIfAborted();providerErrors.push(error);if(error?.retryable===false&&String(error.code||'').startsWith('SOURCE_PROVIDER_'))break;continue;}
    const ranked=(candidates||[]).filter(accepted).map(t=>({track:t,score:sourceScore(item,t,{kind})})).filter(t=>Number.isFinite(t.score)).sort((a,b)=>b.score-a.score);
    selected=ranked[0]?.track;if(selected)break;
   }
   if(!selected){
    const permanent=providerErrors.find(error=>error?.retryable===false&&String(error.code||'').startsWith('SOURCE_PROVIDER_'));
    if(permanent)throw sourceFailure(permanent.message,permanent.code,{cause:permanent});
    if(successfulSearches===0&&providerErrors.length)throw sourceFailure('Playback source search is temporarily unavailable.','SOURCE_PROVIDER_UNAVAILABLE',{retryable:true,retryLimit:1,cause:providerErrors[0]});
    throw sourceFailure('No matching playable source was found for '+item.title+'.','SOURCE_NO_MATCH');
   }
   await check(canonicalSourceUrl(selected));
   return {...item,...sanitize(selected),kind:kind==='video'?'video':'track',title:item.title,author:item.author,duration:Number(item.duration||selected.duration||0),thumbnail:item.thumbnail||selected.thumbnail||'',id:item.id,album:item.album,albumId:item.albumId,artistId:item.artistId,albumArtist:item.albumArtist,genres:item.genres,metadataProvider:item.provider,providerUrl:item.providerUrl||item.url,
    linkedProvider:item.provider,linkedOriginalUrl:item.providerUrl||item.url||'',linkedThumbnail:item.thumbnail,linkedTitle:`${item.author} - ${item.title}`,mediaTitle:selected.mediaTitle||selected.title,mediaArtist:selected.mediaArtist||topicArtist(selected)||item.author,metadataOnly:false,previewOnly:false};
  }finally{clearTimeout(timer);}
 }
 async function recover(input,user,{kind='audio',failedUrl=input?.url,error,signal}={}){
  const item=sanitize(input),origin=catalogOrigin(item),download=require('./audioDownload');
  if(signal?.aborted)throw signal.reason;
  if(download.isPermanentDownloadError(error)||!download.isRetryableDownloadError(error))throw error||new Error('This source cannot be recovered.');
  if(item.sourceRecoveryAttempts)throw new Error('Catalog source recovery has already been attempted once.');
  if(!origin)throw new Error('An explicit or native media source cannot be replaced by a catalog search.');
  const result=await resolve({...item,url:'',providerUrl:origin.url,provider:origin.provider,metadataOnly:true,previewOnly:false},user,{kind,signal,excludeUrls:[failedUrl],forceRefresh:true});
  return {...result,id:item.id,title:item.title,author:item.author,providerUrl:origin.url,linkedOriginalUrl:item.linkedOriginalUrl||origin.url,linkedProvider:item.linkedProvider||origin.provider,sourceRecoveryAttempts:1};
 }
 return {resolve,recover,sanitize,needsResolution:metadataSource,sourceScore,isSourceUrl,canonicalSourceUrl,isSoundCloudApiTrack,awaitSource};
}
module.exports=createPlatformSources();Object.assign(module.exports,{createPlatformSources,sourceScore,sanitize,isSourceUrl,canonicalSourceUrl,isSoundCloudApiTrack,sourceIdentity,awaitSource});
