import { convertFileSrc } from '@tauri-apps/api/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LocalModel } from '../../lib/models';
import { reportLibraryError } from '../../features/downloads/libraryDiagnostics';

function remoteVideo(model?:LocalModel) {
 const info=model?.info?.civitai;
 return info?.previewKind==='video'||/\.mp4(?:[?#]|$)/i.test(info?.preview??'');
}

export function hasVideoCover(model:LocalModel) {
 return model.localPreview?/\.mp4$/i.test(model.localPreview):remoteVideo(model);
}

function VideoCover({src,className,controls,onError}:{src:string;className?:string;controls:boolean;onError:()=>void}) {
 const video=useRef<HTMLVideoElement>(null);
 const [visible,setVisible]=useState(()=>controls||typeof IntersectionObserver==='undefined');
 const [hovered,setHovered]=useState(false);
 const ready=controls||visible||hovered;
 useEffect(()=>{
  if(ready||!video.current||typeof IntersectionObserver==='undefined')return;
  const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))setVisible(true);});
  observer.observe(video.current);
  return ()=>observer.disconnect();
 },[ready]);
 useEffect(()=>{
  const element=video.current;
  if(!element||controls||!ready)return;
  if(hovered&&!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches){
   void element.play().catch(()=>{});
  }else if(!element.paused){
   element.pause();
  }
 },[controls,hovered,ready,src]);
 return <video ref={video} className={className} src={ready?src:undefined} preload="metadata"
  muted playsInline loop controls={controls} aria-hidden={controls?undefined:true}
  onPointerEnter={()=>{if(!controls){setVisible(true);setHovered(true);}}}
  onPointerLeave={()=>setHovered(false)} onError={onError}/>;
}

/** Reuse indexed local covers first, then cached CivitAI URLs. */
export function ModelPreview({model,className,fallback,videoControls=false}:{model?:LocalModel;className?:string;fallback:ReactNode;videoControls?:boolean}) {
 const asset=model?.localPreview?convertFileSrc(model.localPreview):undefined,local=asset&&model?.previewRevision?`${asset}${asset.includes('?')?'&':'?'}deas_preview=${model.previewRevision}`:asset,remote=model?.info?.civitai?.preview;
 const [failed,setFailed]=useState<string[]>([]);
 useEffect(()=>setFailed([]),[local,remote,model?.previewRevision]);
 const src=[local,remote].find((url):url is string=>!!url&&!failed.includes(url));
 if(!src)return <>{fallback}</>;
 const fail=()=>{setFailed(old=>[...old,src]);reportLibraryError('preview');};
 const video=src===local?/\.mp4$/i.test(model?.localPreview??''):remoteVideo(model);
 return video?<VideoCover key={src} className={className} src={src} controls={videoControls} onError={fail}/>:
  <img className={className} src={src} alt="" loading="lazy" decoding="async" onError={fail}/>;
}
