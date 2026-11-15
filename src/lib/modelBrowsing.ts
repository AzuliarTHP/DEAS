import { useEffect, useState } from 'react';
import { readPref, writePref } from './preferences';
import type { LocalModel } from './models';

export const modelSorts=['name','nameDesc','newest','oldest','size','smallest','mostUsed','leastUsed','mostVersions','fewestVersions','random','family'] as const;
export type ModelSort=typeof modelSorts[number];
export const isModelSort=(v:unknown):v is ModelSort=>modelSorts.includes(v as ModelSort);
const usageKey='library.modelUsage';
const usageEvent='deas:model-usage';
const validUsage=(v:unknown):v is Record<string,number>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.entries(v).length<=25000&&Object.values(v).every(n=>Number.isSafeInteger(n)&&Number(n)>=0);
export const modelUsageKey=(model:LocalModel)=>model.path||`${model.category}:${model.name}`;
/** Counts explicit Studio applications, not claimed generations or historical usage. */
export function recordModelUse(model:LocalModel) {
 const counts=readPref<Record<string,number>>(usageKey,{},validUsage);const key=modelUsageKey(model);
 counts[key]=Math.min(Number.MAX_SAFE_INTEGER,(counts[key]??0)+1);writePref(usageKey,counts);window.dispatchEvent(new Event(usageEvent));
}
export function useModelUsage() {
 const [counts,setCounts]=useState(()=>readPref<Record<string,number>>(usageKey,{},validUsage));
 useEffect(()=>{const update=()=>setCounts(readPref<Record<string,number>>(usageKey,{},validUsage));window.addEventListener(usageEvent,update);return()=>window.removeEventListener(usageEvent,update);},[]);
 return counts;
}
function randomRank(key:string,seed:number) {let hash=seed|0;for(let i=0;i<key.length;i++)hash=Math.imul(hash^key.charCodeAt(i),16777619);return hash>>>0;}
export function sortModels(models:LocalModel[],sort:ModelSort,usage:Record<string,number>,seed:number) {
 const versions=new Map<string,Set<string>>();
 const group=(m:LocalModel)=>m.info?.civitai?`civitai:${m.info.civitai.modelId}`:modelUsageKey(m);
 for(const m of models){const key=group(m);const ids=versions.get(key)??new Set();ids.add(m.info?.civitai?String(m.info.civitai.versionId):m.path||m.name);versions.set(key,ids);}
 const title=(m:LocalModel)=>m.info?.civitai?.name??m.name;
 return [...models].sort((a,b)=>{
  const name=title(a).localeCompare(title(b))||a.name.localeCompare(b.name);
  switch(sort){
   case 'nameDesc':return -name;
   case 'newest':return (b.addedAt??0)-(a.addedAt??0)||name;
   case 'oldest':return (a.addedAt??0)-(b.addedAt??0)||name;
   case 'size':return b.size-a.size||name;
   case 'smallest':return a.size-b.size||name;
   case 'mostUsed':return (usage[modelUsageKey(b)]??0)-(usage[modelUsageKey(a)]??0)||name;
   case 'leastUsed':return (usage[modelUsageKey(a)]??0)-(usage[modelUsageKey(b)]??0)||name;
   case 'mostVersions':return (versions.get(group(b))?.size??1)-(versions.get(group(a))?.size??1)||name;
   case 'fewestVersions':return (versions.get(group(a))?.size??1)-(versions.get(group(b))?.size??1)||name;
   case 'random':return randomRank(modelUsageKey(a),seed)-randomRank(modelUsageKey(b),seed)||name;
   case 'family':return (a.family??'').localeCompare(b.family??'')||name;
   default:return name;
  }
 });
}
