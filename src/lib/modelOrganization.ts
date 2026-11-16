import { useEffect, useState, useMemo } from 'react';
import { readPref } from './preferences';
import { modelPathKey } from './modelLibrary';
import { reportLibraryError } from '../features/downloads/libraryDiagnostics';
export type ModelAnnotation={favorite?:boolean;notes?:string;tags?:string[]};
export type ModelOrganization=Record<string,ModelAnnotation>;
const organizationPreferenceKeys=['library.local.organization'];
const key=organizationPreferenceKeys[0],changed='deas:model-organization';
export const validOrganization=(v:unknown):v is ModelOrganization=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.entries(v).length<=10000&&Object.entries(v).every(([path,a])=>path.length<=32768&&a&&typeof a==='object'&&(a.favorite===undefined||typeof a.favorite==='boolean')&&(a.notes===undefined||typeof a.notes==='string'&&a.notes.length<=4000)&&(a.tags===undefined||Array.isArray(a.tags)&&a.tags.length<=20&&a.tags.every((tag:unknown)=>typeof tag==='string'&&tag.length<=50)));
export function useModelOrganization(){
 const [organization,setOrganization]=useState(()=>readPref(key,{},validOrganization));const [error,setError]=useState(false);
 useEffect(()=>{const receive=(event:Event)=>{if(event instanceof StorageEvent&&event.key!=='deas.pref.'+key)return;setOrganization(readPref(key,{},validOrganization));};window.addEventListener(changed,receive);window.addEventListener('storage',receive);return()=>{window.removeEventListener(changed,receive);window.removeEventListener('storage',receive);};},[]);
 const save=(next:ModelOrganization)=>{try{if(!validOrganization(next))throw new Error('Invalid organization');localStorage.setItem('deas.pref.'+key,JSON.stringify(next));setOrganization(next);setError(false);window.dispatchEvent(new Event(changed));return true;}catch{setError(true);reportLibraryError('organization');return false;}};
 const annotate=(path:string,patch:ModelAnnotation)=>{if(!path)return false;const current=readPref(key,organization,validOrganization);const existing=Object.keys(current).find(p=>modelPathKey(p)===modelPathKey(path))??path;return save({...current,[existing]:{...current[existing],...patch}});};
 // Explicit set/unset makes mixed selections predictable and uses one preference write.
 const setFavorites=(paths:string[],favorite:boolean)=>{const current=readPref(key,organization,validOrganization),next={...current};const existing=new Map(Object.keys(current).map(path=>[modelPathKey(path),path]));for(const path of paths.filter(Boolean)){const normalized=modelPathKey(path),target=existing.get(normalized)??path;next[target]={...next[target],favorite};existing.set(normalized,target);}return paths.some(Boolean)?save(next):true;};
 const byPath=useMemo(()=>new Map(Object.entries(organization).map(([p,v])=>[modelPathKey(p),v])),[organization]);
 const annotation=(path:string)=>byPath.get(modelPathKey(path));
 const isFavorite=(path:string)=>!!path&&!!annotation(path)?.favorite;
 const toggleFavorite=(path:string)=>annotate(path,{favorite:!isFavorite(path)});
 return {organization,annotation,annotate,isFavorite,toggleFavorite,setFavorites,error};
}
