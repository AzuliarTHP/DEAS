import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LocalModel } from './models';
import { requestStudioLora, STUDIO_LORA_ADD, takeStudioLoras } from './studioLoraSelection';
import { invoke } from '@tauri-apps/api/core';
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true,invoke:vi.fn().mockResolvedValue(undefined)}));
const model:LocalModel={category:'loras',name:'style.safetensors',path:'L:\\Models\\loras\\style.safetensors',size:1,info:null};
beforeEach(()=>{localStorage.clear();vi.mocked(invoke).mockClear();});
afterEach(()=>vi.restoreAllMocks());
it('matches Windows slash, case, trailing separator and extended-path spellings',()=>{
 expect(requestStudioLora('L:\\Models\\',model)).toBe(true);
 expect(requestStudioLora('l:/models',{...model,path:'l:/models/loras/STYLE.safetensors'})).toBe(true);
 expect(takeStudioLoras('\\\\?\\L:\\Models')).toEqual([model]);
 expect(takeStudioLoras('L:/Models')).toEqual([]);
 expect(requestStudioLora('\\\\server\\share\\models',model)).toBe(true);
 expect(takeStudioLoras('\\\\?\\UNC\\SERVER\\share\\models\\')).toEqual([model]);
});
it('retains other folders and POSIX case distinctions and re-notifies duplicate requests',()=>{
 const listener=vi.fn();window.addEventListener(STUDIO_LORA_ADD,listener);
 try{
  requestStudioLora('/Models',model);requestStudioLora('/Models',model);requestStudioLora('/models',model);
  expect(listener).toHaveBeenCalledTimes(3);
  expect(takeStudioLoras('/Models')).toEqual([model]);expect(takeStudioLoras('/models')).toEqual([model]);
 }finally{window.removeEventListener(STUDIO_LORA_ADD,listener);}
});
it('reports failed persistence without claiming an addition or losing pending requests',()=>{
 requestStudioLora('L:/Models',model);
 vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('full','QuotaExceededError');});
 expect(requestStudioLora('L:/Models',{...model,name:'other.pt',path:'L:/Models/loras/other.pt'})).toBe(false);
 expect(takeStudioLoras('L:/Models')).toEqual([]);
 expect(invoke).toHaveBeenCalledWith('native_logs_library_error',{operation:'selection'});
 vi.restoreAllMocks();expect(takeStudioLoras('L:/Models')).toEqual([model]);
});
it('bounds pending additions without evicting previous selections',()=>{
 for(let i=0;i<128;i++)expect(requestStudioLora('/models',{...model,path:`/models/loras/${i}.pt`,name:`${i}.pt`})).toBe(true);
 expect(requestStudioLora('/models',model)).toBe(false);expect(takeStudioLoras('/models')).toHaveLength(128);
});
