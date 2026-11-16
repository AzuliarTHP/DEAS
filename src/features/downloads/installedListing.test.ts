import { beforeEach,expect,it,vi } from 'vitest';
import { scanModels,type LocalModel } from '../../lib/models';
import { clearInstalledListing,loadInstalledListing } from './installedListing';
import { MODEL_LIBRARY_UPDATED,publishModelLibrary } from '../../lib/modelLibrary';
vi.mock('../../lib/models',()=>({scanModels:vi.fn()}));
const model:LocalModel={category:'loras',name:'style.pt',path:'/m/loras/style.pt',size:1,info:null};
beforeEach(()=>{clearInstalledListing();vi.mocked(scanModels).mockReset().mockResolvedValue([model]);});
it('reuses tab snapshots and broadcasts explicit refresh/index reload without another scan',async()=>{
 const receive=vi.fn();window.addEventListener(MODEL_LIBRARY_UPDATED,receive);
 try{await loadInstalledListing('/m');await loadInstalledListing('/m');expect(scanModels).toHaveBeenCalledTimes(1);expect(receive).not.toHaveBeenCalled();const refreshed=await loadInstalledListing('/m',true);expect(refreshed[0].previewRevision).toBeGreaterThan(0);expect(receive).toHaveBeenCalledTimes(1);expect(scanModels).toHaveBeenLastCalledWith('/m',[],true);const reloaded=await loadInstalledListing('/m',false,true);expect(reloaded[0].previewRevision).toBeGreaterThan(refreshed[0].previewRevision!);expect(receive).toHaveBeenCalledTimes(2);
 const updated={...model,family:'anima'};publishModelLibrary({root:'/m',updates:[updated]});expect((await loadInstalledListing('/m'))[0].family).toBe('anima');expect(scanModels).toHaveBeenCalledTimes(3);
 }finally{window.removeEventListener(MODEL_LIBRARY_UPDATED,receive);}
});
