'use strict';
const crypto=require('node:crypto');
const {canonicalTrackKey}=require('./trackIdentity');
class PlaybackLedger{
 constructor({service,intervalMs=10_000,retryDelayMs=250,maxRetryDelayMs=5000,maxRetries=4}={}){
  this.service=service;this.sessions=new Map();this.pending=new Set();this.dirty=new Set();
  this.retryDelayMs=Math.max(1,Math.min(60_000,Number(retryDelayMs)||250));
  this.maxRetryDelayMs=Math.max(this.retryDelayMs,Math.min(60_000,Number(maxRetryDelayMs)||5000));
  this.maxRetries=Math.max(0,Math.min(8,Math.floor(Number(maxRetries)||0)));
  this.flushing=false;this.closing=false;this.flushPromise=null;
  if(intervalMs>0){this.timer=setInterval(()=>{for(const queue of this.sessions.keys())this.sample(queue);},Math.max(1000,intervalMs));this.timer.unref?.();}
 }
 _service(){return this.service||require('./platformService');}
 _retryDelay(attempt){return Math.min(this.maxRetryDelayMs,this.retryDelayMs*2**attempt);}
 _scheduleRetry(item){
  if(this.closing||this.flushing||item.retryTimer||!this.dirty.has(item))return;
  item.retryTimer=setTimeout(()=>{item.retryTimer=null;this._write(item);},this.maxRetryDelayMs);
  item.retryTimer.unref?.();
 }
 async _persist(item){
  for(let attempt=0;attempt<=this.maxRetries;attempt++){
   try{
    // A write can commit before its acknowledgement fails. Retry establishment
    // with the same UUID/start time before sending any absolute checkpoints.
    if(!item.established){
     await this._service().recordPlay(item.user,item.track,{eventId:item.eventId,guildId:item.guildId,playedAt:item.startedAt,listenedSeconds:0});
     item.established=true;
    }
    while(item.savedRevision<item.revision){
     const revision=item.revision,state={...item.latest};
     await this._service().updatePlay(item.user,item.eventId,state);
     item.savedRevision=revision;item.lastSaved=state.listenedSeconds;
    }
    if(item.endReason==='skip'&&!item.skipPersisted){
     await this._service().recordSignal(item.user,{type:'skip',eventId:item.eventId,item:item.track,
      listenedSeconds:item.seconds,duration:Number(item.track.duration)||0,at:item.endedAt});
     item.skipPersisted=true;
    }
    item.lastError=null;this.dirty.delete(item);return;
   }catch(error){
    item.lastError=error;
    if(error.code==='PLAY_EVENT_NOT_FOUND')item.established=false;
    if(attempt===this.maxRetries)throw error;
    await new Promise(resolve=>setTimeout(resolve,this._retryDelay(attempt)));
   }
  }
 }
 _write(item){
  if(item.chain)return item.chain;
  if(item.retryTimer)return;
  const promise=Promise.resolve().then(()=>this._persist(item));
  item.chain=promise;this.pending.add(promise);
  promise.catch(error=>console.warn('[Listening history] could not save:',error.message));
  promise.finally(()=>{
   item.chain=null;this.pending.delete(promise);
   if(!this.dirty.has(item))return;
   if(item.lastError)this._scheduleRetry(item);else this._write(item);
  }).catch(()=>{});
  return promise;
 }
 _checkpoint(item,state){item.latest=state;item.revision++;this.dirty.add(item);this._write(item);}
 begin(queue,track,resource,{seek=0,continuation=false}={}){
  if(this.closing)return;
  if(!/^\d{5,32}$/.test(String(track?.requesterId||'')))return;
  const old=this.sessions.get(queue),identity=canonicalTrackKey(track);
  if(old&&old.identity===identity&&old.user===String(track.requesterId)&&old.index===Number(queue.currentIndex||0)&&(continuation||seek>0)){
   if(old.resource&&old.resource!==resource)this.detach(queue,old.resource);
   old.resource=resource;old.lastResourceMs=0;this.sample(queue);return;
  }
  if(old)this.finish(queue,{reason:'replaced'});
  const item={eventId:crypto.randomUUID(),user:String(track.requesterId),track:{...track},identity,index:Number(queue.currentIndex||0),guildId:String(queue.guildId||''),startedAt:new Date().toISOString(),resource,lastResourceMs:0,seconds:0,lastSaved:0,chain:null,retryTimer:null,established:false,latest:{listenedSeconds:0},revision:0,savedRevision:0,lastError:null};
  this.sessions.set(queue,item);
  this.dirty.add(item);this._write(item);
  this.sample(queue);
 }
 _consume(item){if(!item.resource)return;const ms=Math.max(0,Number(item.resource.playbackDuration)||0);if(ms>=item.lastResourceMs)item.seconds+=(ms-item.lastResourceMs)/1000;item.lastResourceMs=ms;}
 sample(queue){const item=this.sessions.get(queue);if(!item)return;this._consume(item);if(item.seconds>item.latest.listenedSeconds)this._checkpoint(item,{listenedSeconds:item.seconds});else if(this.dirty.has(item))this._write(item);}
 detach(queue,resource){const item=this.sessions.get(queue);if(!item||item.resource!==resource)return;this.sample(queue);item.resource=null;item.lastResourceMs=0;}
 finish(queue,{completed=false,reason}={}){
  const item=this.sessions.get(queue);if(!item)return;this._consume(item);this.sessions.delete(queue);const seconds=item.seconds;
  const endReason=completed?'completed':['skip','manual-stop','replaced','disconnect','error','shutdown'].includes(reason)?reason:'manual-stop';
  item.endReason=endReason;item.endedAt=new Date().toISOString();
  this._checkpoint(item,{listenedSeconds:seconds,endedAt:item.endedAt,completed,endReason});
 }
 async flush(){
  if(this.flushPromise)return this.flushPromise;
  this.flushing=true;
  const work=(async()=>{
   for(const item of this.dirty){clearTimeout(item.retryTimer);item.retryTimer=null;this._write(item);}
   while(this.pending.size)await Promise.allSettled([...this.pending]);
   if(this.dirty.size)throw new AggregateError([...this.dirty].map(item=>item.lastError||new Error('Listening event is still pending.')),`Could not save ${this.dirty.size} listening event(s).`);
  })();
  this.flushPromise=work;
  try{await work;}finally{
   this.flushPromise=null;this.flushing=false;
   for(const item of this.dirty)this._scheduleRetry(item);
  }
 }
 async close(){
  this.closing=true;clearInterval(this.timer);
  for(const item of this.dirty){clearTimeout(item.retryTimer);item.retryTimer=null;}
  for(const queue of [...this.sessions.keys()])this.finish(queue,{reason:'shutdown'});
  await this.flush();
 }
}
module.exports={PlaybackLedger};
