import { adopt, choosePipe, collection, dock, evidence, h3VideoFiles, heldJob, mediaEntries, openHistoryRecord, pipe, promptDrop, recentHistoryRecord, videoEvidence, videoSam } from './Workbench.testHarness';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { Workbench } from './Workbench';
import { I18nProvider } from '../../i18n/I18nProvider';
import { faceRefineNodes, faceRefineStillNodes, sam3VideoNodes } from '../../lib/sam3';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { invoke } from '@tauri-apps/api/core';
import { applyStudioSettings, captureStudioSettings } from '../../lib/preferences';
import { scanModels } from '../../lib/models';
import { autoRefine, readCurrentWorkbench, runWorkbenchJob, uploadInput, uploadMask } from '../../lib/jobs';

test.each([[0,2],[1,1]])('manual face refinement uses the whole source, not the analysis window %s / %s',async(start,duration)=>{
 localStorage.setItem('deas.pref.studio.run.pipeline',JSON.stringify('t2v'));
 localStorage.setItem('deas.pref.studio.run.samVideoStart',JSON.stringify(start));
 localStorage.setItem('deas.pref.studio.run.samVideoDuration',JSON.stringify(duration));
 vi.mocked(scanModels).mockResolvedValue([...h3VideoFiles(),{category:'checkpoints',name:videoSam,path:'/m/'+videoSam,size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,...faceRefineNodes,...sam3VideoNodes],checkpoints:[videoSam]}});
 const source={...heldJob('face-source','succeeded',evidence.baseUrl),outputRoot:'/out',outputs:[{filename:'five-seconds.mp4',subfolder:'clips',type:'output' as const,format:'video/mp4'}]};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([source]));
 vi.mocked(uploadInput).mockResolvedValue('uploaded.mp4');
 vi.mocked(runWorkbenchJob).mockResolvedValue(heldJob('face-result','failed',evidence.baseUrl));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/out',input:'/in'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-job-id="face-source"]')).not.toBeNull());
 fireEvent.click(document.querySelector('[data-job-id="face-source"] .wb-queue-select')!);
 dock('Post-Processing');fireEvent.click(document.querySelector('[data-post-card="face-analysis"]')!);
 const run=await screen.findByRole('button',{name:'Refine faces'});
 await waitFor(()=>expect(run).toHaveProperty('disabled',false));
 expect(document.querySelector('[data-sam-video="startSeconds"]')).toHaveProperty('value',String(start));
 expect(document.querySelector('[data-sam-video="durationSeconds"]')).toHaveProperty('value',String(duration));
 fireEvent.click(run);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(uploadInput).toHaveBeenCalledExactlyOnceWith(evidence.baseUrl,'/out/clips/five-seconds.mp4');
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({recipeId:'h3-face-refine',sourceVideo:'uploaded.mp4',startSeconds:0,durationSeconds:0});
});


test('H3 image Face Refine enable is scoped to model/pipeline drafts, not a hidden global enable',async()=>{
 await stillFaceFixture({other:true});
 await waitFor(()=>expect(faceAuto().disabled).toBe(false));fireEvent.click(faceAuto());
 expect(faceAuto().checked).toBe(true);
 dock('Models');fireEvent.click(await screen.findByRole('button',{name:'a.safetensors'}));
 expect(captureStudioSettings()['studio.run.imageFaceRefine']).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'h3.safetensors'}));
 expect(captureStudioSettings()['studio.run.imageFaceRefine']).toBe(true);
 choosePipe('Text → Video');
 expect(captureStudioSettings()['studio.run.imageFaceRefine']).toBe(false);
 choosePipe('Image → Image');
 expect(captureStudioSettings()['studio.run.imageFaceRefine']).toBe(true);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('immutable image history restores Face Refine fields, and an absent block clears a stale enable',async()=>{
 await stillFaceFixture();
 const faceRefine={samCheckpoint:videoSam,prompt:'historic face',threshold:0.45,maxObjects:3,detectInterval:2,denoise:0.4,cropFactor:3,feather:9,minFace:48,subjects:'primary' as const};
 const base={recipeId:'checkpoint-text-to-image-diagnostic' as const,version:1 as const,family:'minimax-h3',positivePrompt:'old portrait',negativePrompt:'',checkpoint:'h3.safetensors',seed:42,width:1024,height:768,steps:8,cfg:1,sampler:'euler',scheduler:'normal',outputPrefix:'raw/image/history',h3Edit:{shiftVideo:10,shiftAudio:3},inputImage:'ref.png',denoise:1};
 let saved=recentHistoryRecord({...base,faceRefine});
 const before=JSON.stringify(saved);
 vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_jobs_history'?{schemaVersion:1,records:[saved],readOnly:false,error:null}:{path:(args as {path:string})?.path,parent:'/env',entries:mediaEntries,truncated:false});
 await openHistoryRecord();fireEvent.click(document.querySelector('[data-history-apply]')!);
 fireEvent.click(screen.getByRole('button',{name:'Close history'}));
 expect(captureStudioSettings()['studio.run.faceRefine']).toMatchObject({auto:false,prompt:'historic face',denoise:0.4,cropFactor:3,feather:9,minFace:48,primaryOnly:true});
 expect(captureStudioSettings()['studio.run.samCheckpoint']).toBe(videoSam);
 expect(JSON.stringify(saved)).toBe(before);
 saved={...recentHistoryRecord(base),id:'history-without-face'};
 fireEvent.click(screen.getByRole('button',{name:'Recent generations'}));
 await waitFor(()=>expect(document.querySelector('[data-history-id="history-without-face"]')).not.toBeNull());
 fireEvent.click(document.querySelector('[data-history-id="history-without-face"]')!);
 fireEvent.click(screen.getByRole('button',{name:'Use settings'}));fireEvent.click(document.querySelector('[data-history-apply]')!);
 expect(captureStudioSettings()['studio.run.imageFaceRefine']).toBe(false);
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});


test('saved video auto ON is not consent to still refinement when the image flag is absent',async()=>{
 await stillFaceFixture({videoAuto:true,imageAbsent:true});
 expect(faceAuto().checked).toBe(false);
 expect(captureStudioSettings()['studio.run.faceRefine']).toMatchObject({auto:true});
 expect(captureStudioSettings()['studio.run.imageFaceRefine']).toBe(false);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).not.toHaveProperty('faceRefine');
});

test('still consent changes only the image bit, not video auto permission',async()=>{
 await stillFaceFixture();
 await waitFor(()=>expect(faceAuto().disabled).toBe(false));fireEvent.click(faceAuto());
 expect(captureStudioSettings()['studio.run.imageFaceRefine']).toBe(true);
 expect(captureStudioSettings()['studio.run.faceRefine']).toMatchObject({auto:false});
});


test('manual H3 SAM refinement strips Face Refine while preserving still consent',async()=>{
 localStorage.setItem('deas.pref.studio.run.samTargets',JSON.stringify('eyes'));
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,blob:async()=>new Blob()})));
 vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:1024,height:768,close:vi.fn()})));
 vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(done=>done({arrayBuffer:async()=>new Uint8Array([1,2]).buffer} as Blob));
 vi.mocked(uploadMask).mockResolvedValue('source-upload.png');
 vi.mocked(autoRefine).mockResolvedValue({job:null,skipped:0});
 await stillFaceFixture({auto:true});
 fireEvent.click(document.querySelector('[data-post-card="sam"]')!);
 const refine=document.querySelector<HTMLButtonElement>('.wb-post [data-sam="refine"]')!;
 await waitFor(()=>expect(refine.disabled).toBe(false));fireEvent.click(refine);
 await waitFor(()=>expect(autoRefine).toHaveBeenCalledOnce());
 expect(vi.mocked(autoRefine).mock.lastCall![1]).not.toHaveProperty('faceRefine');
 expect(captureStudioSettings()['studio.run.imageFaceRefine']).toBe(true);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

const facePref={auto:false,denoise:0.3,cropFactor:2.5,feather:6,prompt:''};
const stillUp='minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors';
async function stillFaceFixture({auto=false,missing='',refs=false,other=false,videoAuto=false,imageAbsent=false}={}){
 localStorage.setItem('deas.pref.studio.run.pipeline',JSON.stringify('i2i'));
 localStorage.setItem('deas.pref.studio.run.checkpoint',JSON.stringify('h3.safetensors'));
 localStorage.setItem('deas.pref.studio.run.faceRefine',JSON.stringify({...facePref,auto:videoAuto}));
 if(!imageAbsent)localStorage.setItem('deas.pref.studio.run.imageFaceRefine',JSON.stringify(auto));
 const files=h3VideoFiles();
 vi.mocked(scanModels).mockResolvedValue([...files,...(other?[{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]:[]),{category:'checkpoints',name:videoSam,path:'/m/'+videoSam,size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,
  nodes:[...videoEvidence.allowlist.nodes,'LoadImage','MiniMaxH3ReferenceToVideo','DaSiWaH3TiledUpscale','SAM3_Detect',...faceRefineStillNodes].filter(n=>n!==missing),
  ...(missing==='oldABI'?{}:{faceRefineStill:missing!=='ABI'}),checkpoints:missing==='SAM'?[]:[videoSam],h3LatentUpscaleModels:[stillUp]}});
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string})?.path,parent:'/env',entries:mediaEntries,truncated:false}));
 vi.mocked(uploadInput).mockImplementation(async(_url,path)=>'deas-inputs/'+path.split('/').at(-1));
 vi.mocked(runWorkbenchJob).mockResolvedValue(heldJob('still-face','failed',evidence.baseUrl));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',input:'/env/ComfyUI/input',output:'/out'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Image → Image').disabled).toBe(false));
 choosePipe('Image → Image');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));adopt();
 const img=(await screen.findAllByRole('img',{name:'ref.png'})).find(e=>e.classList.contains('wb-zoomable'))!;
 Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:768}});fireEvent.load(img);
 if(refs)promptDrop('image','/outside/jacket.png');
 dock('Post-Processing');fireEvent.click(document.querySelector('[data-post-card="face-analysis"]')!);
 await waitFor(()=>expect(document.querySelector('[data-face-refine="auto"]')).not.toBeNull());
}
const faceAuto=()=>document.querySelector<HTMLInputElement>('[data-face-refine="auto"]')!;

test.each([false,true])('H3 still Run captures Face Refine only when enabled (%s), with refs and latent upscale',async auto=>{
 await stillFaceFixture({refs:true});
 expect(faceAuto().checked).toBe(false);
 expect(document.querySelector('[data-sam-video]')).toBeNull();
 expect(document.querySelector('[data-face-refine="run"]')).toBeNull();
 if(auto){await waitFor(()=>expect(faceAuto().disabled).toBe(false));fireEvent.click(faceAuto());}
 fireEvent.click(document.querySelector('[data-post-card="latent"]')!);
 fireEvent.click(screen.getByLabelText('Latent upscale after sampling'));
 fireEvent.change(screen.getByLabelText('Latent upscale model'),{target:{value:stillUp}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const captured=vi.mocked(runWorkbenchJob).mock.calls[0][1];
 expect(captured).toMatchObject({recipeId:'checkpoint-text-to-image-diagnostic',family:'minimax-h3',h3Edit:expect.any(Object),inputImage:'ref.png',nativeImageReference:{method:'minimax-h3',images:['deas-inputs/jacket.png']},latentUpscale:{model:stillUp,scale:2}});
 if(auto)expect(captured).toMatchObject({faceRefine:{samCheckpoint:videoSam,denoise:0.3,cropFactor:2.5,feather:6}});
 else expect(captured).not.toHaveProperty('faceRefine');
 expect(JSON.stringify(captured)).not.toContain('DEAS_VideoPostprocessGate');
});

test.each(['ABI','oldABI','SAM','DEAS_ImagePostprocessGate','DEAS_H3FaceRefine'])('H3 still missing %s blocks ON, not OFF, and permits turning OFF',async missing=>{
 await stillFaceFixture({auto:true,missing});
 expect(faceAuto()).toHaveProperty('checked',true);
 expect(faceAuto()).toHaveProperty('disabled',false);
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 fireEvent.click(faceAuto());
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 expect(faceAuto()).toHaveProperty('disabled',true);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).not.toHaveProperty('faceRefine');
});

test('H3 still settings reuse the existing transferable prefs and preserve default-OFF',async()=>{
 await stillFaceFixture();
 const settings=captureStudioSettings();
 expect(settings['studio.run.faceRefine']).toEqual(facePref);
 expect(applyStudioSettings({...settings,'studio.run.imageFaceRefine':true,'studio.run.faceRefine':{...facePref,prompt:'exact face',primaryOnly:true,minFace:48}})).toBe(true);
 await waitFor(()=>expect(faceAuto()).toHaveProperty('checked',true));
 expect(captureStudioSettings()['studio.run.faceRefine']).toMatchObject({auto:false,prompt:'exact face',primaryOnly:true,minFace:48});
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});
