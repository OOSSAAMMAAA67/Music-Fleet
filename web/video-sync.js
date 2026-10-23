'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MusicVideoSync=api;})(typeof globalThis==='object'?globalThis:this,function(){
  function sourceKey(track){
    const value=String(track?.url||track?.linkedResolvedUrl||'');
    try{const u=new URL(value);if(/(^|\.)(youtube\.com|youtu\.be)$/.test(u.hostname)){const id=u.hostname==='youtu.be'?u.pathname.slice(1).split('/')[0]:u.searchParams.get('v')||u.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1];if(id)return 'youtube:'+id;}u.hash='';for(const k of [...u.searchParams.keys()])if(/^utm_|^(si|feature)$/.test(k))u.searchParams.delete(k);return u.href;}catch(_){return value;}
  }
  function sameVideo(a,b){const one=sourceKey(a),two=sourceKey(b);return Boolean(one&&one===two);}
  function createDiscordVideoSync({video,getState,getElapsed,onMismatch=()=>{},onFrame=()=>{}}){
    let source=null,frame=0,playing=null,epoch=0,mismatched=false;
    function mute(){video.muted=true;video.defaultMuted=true;}
    async function sync(){
      if(!source)return;mute();const state=getState()||{},match=sameVideo(source,state.track);
      if(!match){video.pause();video.playbackRate=1;if(!mismatched){mismatched=true;onMismatch(state);}return;}
      mismatched=false;let target=Number(getElapsed?.()??state.elapsed??0);if(!Number.isFinite(target))target=0;
      target=Math.max(0,target);if(Number.isFinite(video.duration)&&video.duration>0)target=Math.min(target,video.duration);
      const paused=state.paused||!state.playing,delta=target-Number(video.currentTime||0);
      if(video.readyState>=1&&!video.seeking&&(Math.abs(delta)>.35||paused&&Math.abs(delta)>.04)){try{video.currentTime=target;}catch(_){} }
      video.playbackRate=paused?1:Math.abs(delta)>.06?Math.max(.96,Math.min(1.04,1+delta*.15)):1;
      if(paused){video.pause();}
      else if(video.paused&&!video.ended&&!playing){const requestEpoch=epoch;playing=Promise.resolve().then(()=>video.play()).catch(()=>{}).finally(()=>{playing=null;const latest=getState()||{};if(epoch!==requestEpoch||!source||latest.paused||!latest.playing||!sameVideo(source,latest.track))video.pause();});await playing;}
      onFrame({target,paused,match,state});
    }
    function tick(){frame=0;void sync();if(source&&typeof requestAnimationFrame==='function')frame=requestAnimationFrame(tick);}
    function stop(){source=null;epoch++;if(frame&&typeof cancelAnimationFrame==='function')cancelAnimationFrame(frame);frame=0;video.pause();video.playbackRate=1;}
    function start(track){stop();source={...track};mismatched=false;mute();if(typeof requestAnimationFrame==='function')frame=requestAnimationFrame(tick);}
    return {start,stop,sync,mute};
  }
  return {sameVideo,createDiscordVideoSync};
});
