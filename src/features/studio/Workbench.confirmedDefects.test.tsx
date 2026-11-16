import {adopt,dock,evidence,heldJob,historicalImage,imageModels,mossNodes,mountMoss,openHistoryRecord,recentHistoryRecord,sessionModel,sessionSettings} from './Workbench.testHarness';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {expect,test,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import {Workbench} from './Workbench';
import {I18nProvider} from '../../i18n/I18nProvider';
import {scanModels} from '../../lib/models';
import {checkRecipePrerequisites} from '../../lib/recipePrerequisites';
import {autoRefine,runWorkbenchJob,uploadMask} from '../../lib/jobs';
import {readImageMetadata} from '../../lib/imageMetadata';
import {lyingSigmaSamplingNodes} from '../../lib/lyingSigma';

const negative=()=>document.querySelector<HTMLTextAreaElement>('[data-run-negative]')!;
const run=()=>screen.getByRole('button',{name:'Run'});

test.each([undefined,'','19, 22'])('history restores MOSS skip layers exactly, including absence (%s)',async skipLayers=>{
 const record=recentHistoryRecord({...historicalImage,checkpoint:'moss.safetensors',diffusion:{family:'moss-image',clipType:'moss_image',textEncoder:'qwen3.5_9b.safetensors',vae:'flux2-vae.safetensors'},...(skipLayers===undefined?{}:{skipLayers})});
 vi.mocked(invoke).mockImplementation(async command=>command==='native_jobs_history'?{schemaVersion:1,records:[record],readOnly:false,error:null}:{path:'/input',parent:'/',entries:[],truncated:false});
 await mountMoss();
 fireEvent.change(document.querySelector('[data-moss-skip-layers]')!,{target:{value:'7'}});
 await openHistoryRecord();fireEvent.click(document.querySelector('[data-history-apply]')!);
 fireEvent.click(screen.getByRole('button',{name:'Close history'}));
 expect(document.querySelector('[data-moss-skip-layers]')).toHaveProperty('value',skipLayers??'');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});


test.each([false,true])('metadata reuse restores linked MOSS SLG or clears absent layers (%s)',async linked=>{
 vi.mocked(invoke).mockImplementation(async command=>command==='native_jobs_history'?{schemaVersion:1,records:[],readOnly:false,error:null}:{path:'/out',parent:'/',entries:[{name:'meta.png',path:'/out/meta.png',kind:'file',media:'image',size:1,modified:1}],truncated:false});
 vi.mocked(readImageMetadata).mockResolvedValue([['prompt',JSON.stringify({
  sampler:{class_type:'KSampler',inputs:{model:[linked?'slg':'model',0],seed:123,steps:50}},
  slg:{class_type:'SkipLayerGuidanceDiTSimple',inputs:{model:['model',0],double_layers:'',single_layers:'19, 22',start_percent:0,end_percent:1}},
  model:{class_type:'UNETLoader',inputs:{unet_name:'moss.safetensors'}}
 })]]);
 await mountMoss();fireEvent.change(document.querySelector('[data-moss-skip-layers]')!,{target:{value:'7'}});
 fireEvent.click(await screen.findByRole('button',{name:'meta.png'}));
 fireEvent.click(document.querySelector('[data-more]')!);fireEvent.click(document.querySelector('[data-more-apply]')!);
 await waitFor(()=>expect(document.querySelector('[data-moss-skip-layers]')).toHaveProperty('value',linked?'19, 22':''));
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each(['','  ','authored negative'])('same-kind model switches preserve exact negative (%j), including remembered drafts',async value=>{
 localStorage.setItem('deas.pref.studio.run.negative',JSON.stringify(value));
 await mountMoss();expect(negative().value).toBe(value);
 sessionModel('a.safetensors');
 fireEvent.change(negative(),{target:{value}});
 sessionModel('moss.safetensors');expect(negative().value).toBe(value);
 sessionModel('a.safetensors');expect(negative().value).toBe(value);
 sessionModel('moss.safetensors');expect(negative().value).toBe(value);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('genuine initial MOSS defaults still seed the card negative',async()=>{
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'moss.safetensors',family:'moss-image',path:'/m/moss',size:1,info:null},
  {category:'text_encoders',name:'qwen3.5_9b.safetensors',path:'/m/e',size:1,info:null},
  {category:'vae',name:'flux2-vae.safetensors',path:'/m/v',size:1,info:null}
 ]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:mossNodes,diffusionModels:['moss.safetensors'],clipTypes:['moss_image']}});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await screen.findByRole('option',{name:'moss.safetensors'});
 dock('Models');fireEvent.click(await screen.findByRole('button',{name:'moss.safetensors'}));
 expect(negative().value).toContain('jpeg artifact');
 expect(screen.getByLabelText('Steps')).toHaveProperty('value','50');
});

test('nine active LoRAs block Run; disabling one allows eight without shrinking saved selection',async()=>{
 const loras=Array.from({length:12},(_,i)=>({name:`style-${i}.safetensors`,strength:1,enabled:i<9}));
 localStorage.setItem('deas.pref.studio.run.loras',JSON.stringify(loras));
 vi.mocked(scanModels).mockResolvedValue([...imageModels,...loras.map(l=>({category:'loras',name:l.name,family:'sdxl',path:'/m/'+l.name,size:1,info:null}))]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'LoraLoader'],loras:loras.map(l=>l.name)}});
 vi.mocked(runWorkbenchJob).mockResolvedValue(heldJob('eight-loras','failed'));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('9 LoRAs are active'));
 expect(run()).toHaveProperty('disabled',true);
 expect(screen.getByRole('alert').textContent).toContain('Disable LoRAs until 8 or fewer are active');
 fireEvent.click(run());expect(runWorkbenchJob).not.toHaveBeenCalled();
 sessionSettings({loras:loras.map((l,i)=>i===8?{...l,enabled:false}:l)});
 await waitFor(()=>expect(run()).toHaveProperty('disabled',false));
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.loras')!)).toHaveLength(12);
 fireEvent.click(run());await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledOnce());
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toHaveProperty('loras',loras.slice(0,8).map(({name,strength})=>({name,strength})));
});

test('manual SAM refinement omits enabled Lying Sigma without changing its authoring preference',async()=>{
 const sam='SAM3/sam3.1.safetensors';
 for(const [key,value] of Object.entries({samTargets:'eyes',samCheckpoint:sam,lyingSigma:{factor:-0.05,startPercent:0.25,endPercent:0.9}}))localStorage.setItem('deas.pref.studio.run.'+key,JSON.stringify(value));
 vi.mocked(scanModels).mockResolvedValue(imageModels);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,...lyingSigmaSamplingNodes,'SAM3_Detect'],checkpoints:[...evidence.allowlist.checkpoints,sam]}});
 vi.mocked(invoke).mockResolvedValue({path:'/out',parent:'/',entries:[{name:'source.png',path:'/out/source.png',kind:'file',media:'image',size:1,modified:1}],truncated:false});
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,blob:async()=>new Blob()})));
 vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:1024,height:640,close:vi.fn()})));
 vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(done=>done({arrayBuffer:async()=>new Uint8Array([1,2]).buffer} as Blob));
 vi.mocked(uploadMask).mockResolvedValue('source-upload.png');
 vi.mocked(autoRefine).mockResolvedValue({job:null,skipped:0});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/out'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'source.png'}));adopt();
 const source=screen.getByRole('img',{name:'source.png'});Object.defineProperties(source,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(source);
 dock('Post-Processing');
 const refine=document.querySelector<HTMLButtonElement>('.wb-post [data-sam="refine"]')!;
 await waitFor(()=>expect(refine.disabled).toBe(false));fireEvent.click(refine);
 await waitFor(()=>expect(autoRefine).toHaveBeenCalledOnce());
 const intent=vi.mocked(autoRefine).mock.lastCall![1];
 expect(intent).not.toHaveProperty('lyingSigma');expect(intent).toMatchObject({inputImage:'source-upload.png',width:1024,height:640});
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.lyingSigma')!)).toHaveProperty('factor',-0.05);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});
