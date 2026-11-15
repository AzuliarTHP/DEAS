import { beforeEach, expect, it } from 'vitest';
import { modelUsageKey, recordModelUse, sortModels } from './modelBrowsing';
import type { LocalModel } from './models';
const a:LocalModel={category:'loras',name:'A.pt',path:'/A.pt',size:100,info:null,addedAt:10};
const b:LocalModel={...a,name:'B.pt',path:'/B.pt',size:200,addedAt:20};
beforeEach(()=>localStorage.clear());
it('sorts alphabetically, by added time, size and observed Studio usage in both directions',()=>{
 const first=(sort:Parameters<typeof sortModels>[1])=>sortModels([b,a],sort,{[modelUsageKey(a)]:4},1)[0].name;
 expect(first('name')).toBe('A.pt');expect(first('nameDesc')).toBe('B.pt');expect(first('newest')).toBe('B.pt');expect(first('oldest')).toBe('A.pt');
 expect(first('size')).toBe('B.pt');expect(first('smallest')).toBe('A.pt');expect(first('mostUsed')).toBe('A.pt');expect(first('leastUsed')).toBe('B.pt');
 recordModelUse(a);recordModelUse(a);expect(JSON.parse(localStorage.getItem('deas.pref.library.modelUsage')!)[a.path]).toBe(2);
});
it('counts distinct local CivitAI version IDs and keeps shuffled order stable until its seed changes',()=>{
 const info={sha256:'a',size:1,fetchedAt:1,civitai:{modelId:4,versionId:1,name:'Group',version:'1',modelType:'LORA',category:'loras',base:'SDXL',nsfw:false,trainedWords:[]}};
 const x={...a,info};const y={...b,info:{...info,civitai:{...info.civitai,versionId:2}}};const z={...a,name:'Other.pt',path:'/other.pt'};
 expect(sortModels([z,x,y],'mostVersions',{},1)[0]).toBe(x);expect(sortModels([z,x,y],'fewestVersions',{},1)[0]).toBe(z);
 const many=Array.from({length:30},(_,i)=>({...a,path:`/${i}.pt`,name:`${i}.pt`}));
 expect(sortModels(many,'random',{},1)).toEqual(sortModels(many,'random',{},1));expect(sortModels(many,'random',{},1)).not.toEqual(sortModels(many,'random',{},9));
});
