import { reportLibraryError } from '../features/downloads/libraryDiagnostics';
import { readPref } from './preferences';
import type { LocalModel } from './models';
export const STUDIO_LORA_ADD='deas:studio-lora-add';
type Request={root:string;model:LocalModel};
const queuePreferenceKeys=['studio.loraAddQueue'];
const key=queuePreferenceKeys[0];
const valid=(v:unknown):v is Request[]=>Array.isArray(v)&&v.length<=128&&v.every(r=>r&&typeof r.root==='string'&&r.root.length<=32768&&r.model?.category==='loras'&&typeof r.model.name==='string'&&r.model.name.length<=32768&&typeof r.model.path==='string'&&r.model.path.length<=32768&&Number.isSafeInteger(r.model.size)&&r.model.size>=0&&(r.model.family===undefined||typeof r.model.family==='string')&&(r.model.metadataError===undefined||typeof r.model.metadataError==='string'));
/** Lexical request identity only; native Run still authorizes real files. */
function identity(path:string){
 const windows=/^[a-z]:[\\/]|^\\\\|^\/\//i.test(path);
 let value=(windows?path.replace(/\\/g,'/'):path).replace(/\/+$/,'');
 if(windows){value=value.replace(/^\/\/\?\/UNC\//i,'//').replace(/^\/\/\?\//,'').toLowerCase();}
 return value;
}
function persist(queue:Request[]){try{localStorage.setItem('deas.pref.'+key,JSON.stringify(queue));return true;}catch{reportLibraryError('selection');return false;}}
export function requestStudioLora(root:string,model:LocalModel) {
 if(!valid([{root,model}])||!root||!model.path)return false;
 const queue=readPref<Request[]>(key,[],valid);
 const existing=queue.some(r=>identity(r.root)===identity(root)&&identity(r.model.path)===identity(model.path));
 if(!existing&&queue.length>=128){reportLibraryError('selection');return false;}
 // Store browsing facts only; do not silently report success on unavailable storage.
 if(!existing&&!persist([...queue,{root,model:{...model,info:null}}]))return false;
 // Re-notify for an existing request too: Studio may have become ready since it was queued.
 window.dispatchEvent(new Event(STUDIO_LORA_ADD));return true;
}
export function takeStudioLoras(root:string):LocalModel[] {
 const queue=readPref<Request[]>(key,[],valid);const selected=queue.filter(r=>identity(r.root)===identity(root));
 if(selected.length&&!persist(queue.filter(r=>identity(r.root)!==identity(root))))return [];
 return selected.map(r=>r.model);
}
