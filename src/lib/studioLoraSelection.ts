import { readPref, writePref } from './preferences';
import type { LocalModel } from './models';
export const STUDIO_LORA_ADD='deas:studio-lora-add';
type Request={root:string;model:LocalModel};
const queuePreferenceKeys=['studio.loraAddQueue'];
const key=queuePreferenceKeys[0];
const valid=(v:unknown):v is Request[]=>Array.isArray(v)&&v.length<=128&&v.every(r=>r&&typeof r.root==='string'&&r.root.length<=32768&&r.model?.category==='loras'&&typeof r.model.name==='string'&&r.model.name.length<=32768&&typeof r.model.path==='string'&&r.model.path.length<=32768&&Number.isSafeInteger(r.model.size)&&r.model.size>=0&&(r.model.family===undefined||typeof r.model.family==='string')&&(r.model.metadataError===undefined||typeof r.model.metadataError==='string'));
export function requestStudioLora(root:string,model:LocalModel) {
 const queue=readPref<Request[]>(key,[],valid);
 if(queue.some(r=>r.root===root&&r.model.path===model.path))return true;
 if(queue.length>=128)return false;
 // Store only browsing facts required to retain an explicit selection until Studio mounts.
 const file:LocalModel={...model,info:null};
 writePref(key,[...queue,{root,model:file}]);window.dispatchEvent(new Event(STUDIO_LORA_ADD));return true;
}
export function takeStudioLoras(root:string):LocalModel[] {
 const queue=readPref<Request[]>(key,[],valid);const selected=queue.filter(r=>r.root===root);
 if(selected.length)writePref(key,queue.filter(r=>r.root!==root));return selected.map(r=>r.model);
}
