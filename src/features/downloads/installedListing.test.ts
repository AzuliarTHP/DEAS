import { beforeEach,expect,it,vi } from 'vitest';
import { scanModels,type LocalModel } from '../../lib/models';
import { clearInstalledListing,loadInstalledListing } from './installedListing';
import { MODEL_LIBRARY_UPDATED,publishModelLibrary } from '../../lib/modelLibrary';
vi.mock('../../lib/models',()=>({scanModels:vi.fn()}));
const model:LocalModel={category:'loras',name:'style.pt',path:'/m/loras/style.pt',size:1,info:null};
beforeEach(()=>{clearInstalledListing();vi.mocked(scanModels).mockReset().mockResolvedValue([model]);});
it.each([false,true])('replays family updates received during a deferred scan (refresh=%s)',async refresh=>{
 if(refresh)await loadInstalledListing('/m');
 let finish!:(models:LocalModel[])=>void;
 vi.mocked(scanModels).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=loadInstalledListing('/m',refresh);
 const receive=vi.fn();window.addEventListener(MODEL_LIBRARY_UPDATED,receive);
 try{
  publishModelLibrary({root:'/other',updates:[{...model,family:'wrong-root'}]});
  publishModelLibrary({root:'/m',updates:[{...model,family:'anima'}]});
  publishModelLibrary({root:'/m',updates:[{...model,family:'sdxl'}]});
  receive.mockClear();finish([model]);
  const result=await pending;
  expect(result[0].family).toBe('sdxl');
  expect(await loadInstalledListing('/m')).toBe(result);
  if(refresh){expect(receive).toHaveBeenCalledTimes(1);expect((receive.mock.calls[0][0] as CustomEvent).detail.models).toBe(result);}
  else expect(receive).not.toHaveBeenCalled();
 }finally{window.removeEventListener(MODEL_LIBRARY_UPDATED,receive);}
});
it('replays a metadata-editor family update received during a deferred refresh',async()=>{
 await loadInstalledListing('/m');
 let finish!:(models:LocalModel[])=>void;
 vi.mocked(scanModels).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=loadInstalledListing('/m',true);
 window.dispatchEvent(new CustomEvent('deas:model-family-changed',{detail:{...model,family:'anima'}}));
 finish([model]);
 expect((await pending)[0].family).toBe('anima');
 expect((await loadInstalledListing('/m'))[0].family).toBe('anima');
});
it('does not broadcast a refresh invalidated by a newer listing',async()=>{
 await loadInstalledListing('/m');
 let finish!:(models:LocalModel[])=>void;
 vi.mocked(scanModels).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=loadInstalledListing('/m',true);
 clearInstalledListing();
 const updated={...model,family:'anima'};
 vi.mocked(scanModels).mockResolvedValueOnce([updated]);
 const current=await loadInstalledListing('/m');
 const receive=vi.fn();window.addEventListener(MODEL_LIBRARY_UPDATED,receive);
 try{finish([model]);await pending;expect(receive).not.toHaveBeenCalled();expect(await loadInstalledListing('/m')).toBe(current);}
 finally{window.removeEventListener(MODEL_LIBRARY_UPDATED,receive);}
});
it('reuses tab snapshots and broadcasts explicit refresh/index reload without another scan',async()=>{
 const receive=vi.fn();window.addEventListener(MODEL_LIBRARY_UPDATED,receive);
 try{await loadInstalledListing('/m');await loadInstalledListing('/m');expect(scanModels).toHaveBeenCalledTimes(1);expect(receive).not.toHaveBeenCalled();const refreshed=await loadInstalledListing('/m',true);expect(refreshed[0].previewRevision).toBeGreaterThan(0);expect(receive).toHaveBeenCalledTimes(1);expect(scanModels).toHaveBeenLastCalledWith('/m',[],true);const reloaded=await loadInstalledListing('/m',false,true);expect(reloaded[0].previewRevision).toBeGreaterThan(refreshed[0].previewRevision!);expect(receive).toHaveBeenCalledTimes(2);
 const updated={...model,family:'anima'};publishModelLibrary({root:'/m',updates:[updated]});expect((await loadInstalledListing('/m'))[0].family).toBe('anima');expect(scanModels).toHaveBeenCalledTimes(3);
 }finally{window.removeEventListener(MODEL_LIBRARY_UPDATED,receive);}
});
