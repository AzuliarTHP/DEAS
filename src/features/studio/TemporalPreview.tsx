import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import type { TemporalPreviewData } from '../../lib/jobs';
import { NativeVideo, nativeVideo, type NativeVideoControl } from './NativeVideo';

type Props={preview:TemporalPreviewData;active:boolean;label:string;fallback?:string;maxDuration?:number};
type PlaybackEnd='ended'|'failed';
type Seek={seconds:number};
type Timeline={position:number;duration:number};
type SurfaceProps={
 paused:boolean;
 seek:Seek|null;
 maxDuration?:number;
 onTimeline:(position:number,duration:number)=>void;
 onEnded:()=>void;
 onError:()=>void;
 onToggle:()=>void;
};
const replayDelayMs=1000;
const clock=(time:number)=>{const whole=Math.floor(time);return Math.floor(whole/60)+':'+String(whole%60).padStart(2,'0');};
const inClip=(seconds:number,duration:number)=>Math.max(0,Math.min(seconds,duration));
// Some samplers encode every decoded frame at the preview FPS, stretching its
// clock. Keep shorter (partial) previews at their own speed.
function previewTiming(encodedDuration:number,maxDuration?:number){
 if(!Number.isFinite(encodedDuration)||encodedDuration<=0)return {duration:0,rate:1};
 if(!maxDuration||!Number.isFinite(maxDuration)||maxDuration<=0||maxDuration>=encodedDuration){
  return {duration:encodedDuration,rate:1};
 }
 const duration=Math.max(maxDuration,encodedDuration/16);
 return {duration,rate:encodedDuration/duration};
}

export function TemporalPreview(props:Props) {
 if(!props.active)return props.fallback?<img src={props.fallback} alt={props.label}/>:null;
 return <TemporalPreviewPlayback {...props}/>;
}

function TemporalPreviewPlayback({preview,label,fallback,maxDuration}:Props) {
 const {t}=useI18n();
 const [playing,setPlaying]=useState(preview);
 const [finished,setFinished]=useState<PlaybackEnd|null>(null);
 const [paused,setPaused]=useState(false);
 const [seek,setSeek]=useState<Seek|null>(null);
 const [nativeReplay,setNativeReplay]=useState(0);
 const [timeline,setTimeline]=useState<Timeline>({position:0,duration:0});
 const hasNewer=playing.revision!==preview.revision;
 if(hasNewer&&(finished==='failed'||finished==='ended'&&!paused)){
  setPlaying(preview);
  setFinished(null);
  setSeek(null);
  setTimeline({position:0,duration:0});
 }
 useEffect(()=>{
  if(paused||finished!=='ended'||hasNewer)return;
  // Post-processing can run without sending a new preview.
  const timer=window.setTimeout(()=>{
   setFinished(null);
   setSeek({seconds:0});
   setNativeReplay(count=>count+1);
  },replayDelayMs);
  return()=>window.clearTimeout(timer);
 },[paused,finished,hasNewer]);

 const moveTo=(seconds:number)=>{
  setFinished(null);
  setSeek({seconds});
  setTimeline(current=>({...current,position:seconds}));
  if(hasNewer)setPlaying(preview);
 };
 const toggle=()=>{
  if(paused&&finished==='ended')moveTo(0);
  setPaused(!paused);
 };
 const updateTimeline=(position:number,duration:number)=>{
  if(!Number.isFinite(duration)||duration<=0)return;
  const elapsed=inClip(position,duration);
  setTimeline(current=>current.position===elapsed&&current.duration===duration?current:{position:elapsed,duration});
 };
 const time=clock(timeline.position)+' / '+clock(timeline.duration);
 const action=t(paused?'studio.video.play':'studio.video.pause');
 const still=fallback?<img src={fallback} alt={label}/>:null;
 if(finished==='failed')return still;
 return <div className="wb-temporal-preview" data-temporal-preview>
  <div className="wb-temporal-picture">
   <TemporalPreviewRevision key={playing.revision} preview={playing} label={label} fallback={fallback}
    paused={paused} seek={seek} maxDuration={maxDuration} nativeReplay={nativeReplay} onTimeline={updateTimeline}
    onToggle={toggle} onEnded={()=>setFinished('ended')} onFailed={()=>setFinished('failed')} onBlocked={()=>setPaused(true)}/>
  </div>
  <div className="native-video-controls wb-temporal-controls">
   <button type="button" title={action} aria-label={action} onClick={toggle}>
    <svg viewBox="0 0 24 24" aria-hidden="true">{paused
     ?<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>
     :<path d="M8 5v14M16 5v14" strokeWidth="4"/>}</svg>
   </button>
   <span className="native-video-time">{time}</span>
   <input className="native-video-seek" type="range" aria-label={t('studio.video.seek')} aria-valuetext={time}
    min={0} max={timeline.duration} step="any" value={timeline.position} disabled={!timeline.duration}
    style={{'--progress':(timeline.duration?timeline.position/timeline.duration*100:0)+'%'} as CSSProperties}
    onChange={event=>moveTo(event.currentTarget.valueAsNumber)}
    onPointerUp={event=>{if(hasNewer&&event.currentTarget.valueAsNumber===timeline.position)moveTo(timeline.position);}}/>
  </div>
 </div>;
}

function TemporalPreviewRevision({preview,label,fallback,nativeReplay,onFailed,onBlocked,...surface}:Omit<Props,'active'>&Omit<SurfaceProps,'onError'>&{
 nativeReplay:number;
 onFailed:()=>void;
 onBlocked:()=>void;
}) {
 const [owner]=useState(()=>crypto.randomUUID());
 const onError=()=>{
  onFailed();
  if(isTauri())void invoke('native_video_update',{id:owner,action:{kind:'previewError'}}).catch(()=>{});
 };
 const props={...surface,onError,label};
 if(preview.video){
  return nativeVideo()
   ?<NativePreviewClip key={nativeReplay} {...props} source={preview.video}/>
   :<WebPreviewClip {...props} source={preview.video} owner={owner} fallback={fallback} onBlocked={onBlocked}/>;
 }
 return <FramePreviewClip {...props} frames={preview.frames} width={preview.width} height={preview.height}/>;
}

type ClipSource=NonNullable<TemporalPreviewData['video']>;
function WebPreviewClip({source,owner,label,fallback,paused,seek,maxDuration,onTimeline,onEnded,onError,onBlocked,onToggle}:SurfaceProps&{
 source:ClipSource;owner:string;label:string;fallback?:string;onBlocked:()=>void;
}) {
 const player=useRef<HTMLVideoElement>(null);
 const [video,setVideo]=useState<string>();
 const [loaded,setLoaded]=useState(false);
 const [encodedDuration,setEncodedDuration]=useState(0);
 const {rate}=previewTiming(encodedDuration,maxDuration);
 const latest=useRef({onError,onBlocked});latest.current={onError,onBlocked};
 useEffect(()=>{
  let disposed=false;
  void invoke<string>('native_video_open',{id:owner,source,autoPlay:true,repeat:false,muted:true}).then(src=>{
   if(!disposed)setVideo(src);
  },()=>{if(!disposed)latest.current.onError();});
  return()=>{disposed=true;};
 },[owner,source]);

 useEffect(()=>{
  const element=player.current;
  if(!loaded||!element)return;
  element.playbackRate=rate;
  if(seek)element.currentTime=encodedDuration?inClip(seek.seconds*rate,encodedDuration):seek.seconds;
 },[loaded,seek,encodedDuration,rate]);

 useEffect(()=>{
  const element=player.current;
  if(!loaded||!element)return;
  if(paused){element.pause();return;}
  let disposed=false;
  void element.play().catch(error=>{
   if(disposed||error?.name==='AbortError')return;
   if(error?.name==='NotAllowedError')latest.current.onBlocked();
   else latest.current.onError();
  });
  return()=>{disposed=true;};
 },[loaded,paused,seek]);

 const report=(element:HTMLVideoElement)=>{
  if(!Number.isFinite(element.duration)||element.duration<=0)return;
  setEncodedDuration(element.duration);
  const timing=previewTiming(element.duration,maxDuration);
  onTimeline(element.currentTime/timing.rate,timing.duration);
 };
 return video?<video ref={player} src={video} aria-label={label} muted playsInline preload="auto"
  onLoadedMetadata={event=>{setLoaded(true);report(event.currentTarget);}}
  onDurationChange={event=>report(event.currentTarget)} onTimeUpdate={event=>report(event.currentTarget)}
  onClick={onToggle} onEnded={onEnded} onError={onError}/>:fallback?<img src={fallback} alt={label}/>:null;
}

function NativePreviewClip({source,label,paused,seek,maxDuration,onTimeline,onEnded,onError,onToggle}:SurfaceProps&{source:ClipSource;label:string}) {
 const control=useRef<NativeVideoControl>(null);
 const [encodedDuration,setEncodedDuration]=useState(0);
 const {rate}=previewTiming(encodedDuration,maxDuration);
 useEffect(()=>{
  if(encodedDuration>0)control.current?.setRate(rate);
 },[encodedDuration,rate]);
 useEffect(()=>{
  if(encodedDuration&&seek)control.current?.seek(inClip(seek.seconds*rate,encodedDuration));
 },[encodedDuration,seek,rate]);
 useEffect(()=>{
  if(!encodedDuration)return;
  if(paused)control.current?.pause();
  else control.current?.play();
 },[encodedDuration,paused]);
 return <NativeVideo source={source} label={label} muted controls={false} controlRef={control} onTogglePlayback={onToggle} onStatus={status=>{
  if(status.error){onError();return;}
  setEncodedDuration(status.duration);
  const timing=previewTiming(status.duration,maxDuration);
  onTimeline(status.position/timing.rate,timing.duration);
  if(status.ended)onEnded();
 }}/>;
}

function FramePreviewClip({frames,width,height,label,paused,seek,maxDuration,onTimeline,onEnded,onError,onToggle}:SurfaceProps&{
 frames:NonNullable<TemporalPreviewData['frames']>;width:number;height:number;label:string;
}) {
 const canvas=useRef<HTMLCanvasElement>(null);
 const [images,setImages]=useState<HTMLImageElement[]>();
 const position=useRef(0);
 const lastSeek=useRef<Seek|null>(null);
 const lastFrame=useRef(-1);
 const latest=useRef({onTimeline,onEnded,onError});latest.current={onTimeline,onEnded,onError};
 useEffect(()=>{
  let disposed=false;
  const images=frames.map(frame=>{const image=new Image();image.src=frame.src;return image;});
  const loads=images.map(image=>new Promise<void>((resolve,reject)=>{
   if(image.complete&&image.naturalWidth)resolve();
   else{image.onload=()=>resolve();image.onerror=reject;}
  }));
  void Promise.all(loads).then(()=>{if(!disposed)setImages(images);},()=>{if(!disposed)latest.current.onError();});
  return()=>{disposed=true;images.forEach(image=>{image.onload=null;image.onerror=null;image.src='';});};
 },[frames]);

 useEffect(()=>{
  if(!images)return;
  const context=canvas.current?.getContext('2d');
  if(!context){latest.current.onError();return;}
  const total=frames.reduce((sum,frame)=>sum+frame.durationMs,0);
  const seeking=seek!==lastSeek.current;
  lastSeek.current=seek;
  const {duration,rate}=previewTiming(total/1000,maxDuration);
  if(seeking&&seek)position.current=inClip(seek.seconds,duration)*rate*1000;
  if(paused&&!seeking&&lastFrame.current>=0)return;
  let frame=0,start:number|undefined,drawSeek=seeking;
  const paint=(now:number)=>{
   start??=now-position.current/rate;
   position.current=Math.min(total,(now-start)*rate);
   let elapsed=position.current,index=0;
   while(index<frames.length-1&&elapsed>=frames[index].durationMs){elapsed-=frames[index].durationMs;index++;}
   if(index!==lastFrame.current||drawSeek){
    drawSeek=false;
    context.drawImage(images[index],0,0,width,height);
    lastFrame.current=index;
    latest.current.onTimeline(position.current/(rate*1000),duration);
   }
   if(paused)return;
   if(position.current===total){
    latest.current.onTimeline(duration,duration);
    latest.current.onEnded();
   }else frame=requestAnimationFrame(paint);
  };
  frame=requestAnimationFrame(paint);
  return()=>cancelAnimationFrame(frame);
 },[images,frames,width,height,seek,paused,maxDuration]);

 return <canvas ref={canvas} width={width} height={height} role="img" aria-label={label} onClick={onToggle}/>;
}
