import { convertFileSrc } from '@tauri-apps/api/core';
import { useEffect, useState, type ReactNode } from 'react';
import type { LocalModel } from '../../lib/models';
import { reportLibraryError } from '../../features/downloads/libraryDiagnostics';

/** Reuse indexed local images first, then cached CivitAI URLs; never starts a model scan/fetch. */
export function ModelPreview({model,className,fallback}:{model?:LocalModel;className?:string;fallback:ReactNode}) {
 const asset=model?.localPreview?convertFileSrc(model.localPreview):undefined,local=asset&&model?.previewRevision?`${asset}${asset.includes('?')?'&':'?'}deas_preview=${model.previewRevision}`:asset,remote=model?.info?.civitai?.preview;
 const [failed,setFailed]=useState<string[]>([]);
 useEffect(()=>setFailed([]),[local,remote,model?.previewRevision]);
 const src=[local,remote].find((url):url is string=>!!url&&!failed.includes(url));
 return src?<img className={className} src={src} alt="" loading="lazy" decoding="async" onError={()=>{setFailed(old=>[...old,src]);reportLibraryError('preview');}}/>:<>{fallback}</>;
}
