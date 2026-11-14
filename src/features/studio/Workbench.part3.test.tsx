import { adopt, choosePipe, clickMedia, collection, dock, dropTile, evidence, heldJob, ltxModels, menuOf, pipe, sessionModel, sessionModels, sessionSettings, videoEvidence } from './Workbench.testHarness';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { Workbench } from './Workbench';
import { I18nProvider } from '../../i18n/I18nProvider';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels } from '../../lib/models';
import { runWorkbenchJob, pollWorkbench, uploadMask, uploadInput, type JobStatus } from '../../lib/jobs';

test('IPC fixture: with an environment the models folder is scanned on mount instead of probing the backend',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'sdxl/base.safetensors',path:'/m/checkpoints/sdxl/base.safetensors',size:1,info:null},{category:'loras',name:'grain.safetensors',path:'/m/loras/grain.safetensors',size:1,info:null},{category:'vae',name:'x.safetensors',path:'/m/vae/x.safetensors',size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 dock('Models');
 expect((await screen.findByRole('button',{name:'sdxl/base.safetensors'})).getAttribute('aria-pressed')).toBe('true');
 dock('LoRAs');expect(screen.getByRole('button',{name:'grain.safetensors'}).getAttribute('aria-pressed')).toBe('false');
 expect(scanModels).toHaveBeenCalledExactlyOnceWith('/m',[]);
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(1); // only the sampler/scheduler lists, never the model list
});

test('Windows model tree filtering and short names preserve the exact selected identifier',async()=>{
 const name='sdxl\\anime\\My Model.safetensors';
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name,path:'C:\\models\\'+name,size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'C:\\models'}}/></I18nProvider>);
 dock('Models');
 const tree=await screen.findByRole('navigation',{name:'Folders'});
 fireEvent.click(within(tree).getByRole('button',{name:'anime'}));
 const tile=screen.getByRole('button',{name});
 expect(tile.querySelector('.wb-tile-name')!.textContent).toBe('My Model');
 fireEvent.click(tile);
 expect((screen.getByRole('combobox',{name:'Checkpoint'}) as HTMLSelectElement).value).toBe(name);
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.checkpoint')!)).toBe(name);
});

test('model and LoRA docks get a subfolder tree from the scanned names that filters the tiles per tab',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'sdxl/base.safetensors',path:'/m/checkpoints/sdxl/base.safetensors',size:1,info:null},{category:'checkpoints',name:'sd15/old.safetensors',path:'/m/checkpoints/sd15/old.safetensors',size:1,info:null},{category:'checkpoints',name:'sdxl/anime/pony.safetensors',path:'/m/checkpoints/sdxl/anime/pony.safetensors',size:1,info:null},{category:'loras',name:'grain.safetensors',path:'/m/loras/grain.safetensors',size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 dock('Models');
 const tree=await screen.findByRole('navigation',{name:'Folders'});
 fireEvent.click(within(tree).getByRole('button',{name:'anime'}));
 expect(screen.getByRole('button',{name:'sdxl/anime/pony.safetensors'})).toBeTruthy();expect(screen.queryByRole('button',{name:'sdxl/base.safetensors'})).toBeNull();
 fireEvent.click(within(tree).getByRole('button',{name:'sdxl'}));
 expect(screen.getByRole('button',{name:'sdxl/base.safetensors'})).toBeTruthy();expect(screen.queryByRole('button',{name:'sd15/old.safetensors'})).toBeNull();
 dock('LoRAs');expect(screen.queryByRole('navigation',{name:'Folders'})).toBeNull();expect(screen.getByRole('button',{name:'grain.safetensors'})).toBeTruthy(); // no subfolders, no tree, unfiltered
 dock('Models');expect(within(screen.getByRole('navigation',{name:'Folders'})).getByRole('button',{name:'sdxl'}).getAttribute('aria-current')).toBe('location');
 fireEvent.click(within(screen.getByRole('navigation',{name:'Folders'})).getByRole('button',{name:'Models'}));
 expect(screen.getByRole('button',{name:'sd15/old.safetensors'})).toBeTruthy();
 // Tiles print the short name; the full path stays the accessible name. The view choice is remembered.
 expect(screen.getByRole('button',{name:'sd15/old.safetensors'}).querySelector('.wb-tile-name')!.textContent).toBe('old');
 fireEvent.change(screen.getByRole('combobox',{name:'View'}),{target:{value:'list'}});
 expect(document.querySelector('.wb-dock')!.getAttribute('data-view')).toBe('list');
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.dock.view')!)).toBe('list');
});

test.each([
 ['/env/ComfyUI/input','/env/ComfyUI/input/ref.png'],
 ['/env/ComfyUI/input/','/env/ComfyUI/input/ref.png'],
 ['C:\\env\\ComfyUI\\input\\','C:\\env\\ComfyUI\\input\\ref.png'],
 ['C:/env/ComfyUI/input/','C:\\env\\ComfyUI\\input\\ref.png'],
])('IPC fixture: Image→Image keeps native input-folder names and denoise (%s)',async(input,path)=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'ref.png',path,kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'job-2',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false});
 vi.mocked(pollWorkbench).mockResolvedValue(collection([{id:'job-2',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:'x',generationReady:false}]));
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input,output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await screen.findByRole('option',{name:'Image',selected:true});
 expect(pipe('Image → Image').disabled).toBe(false);
 for(const name of ['Text → Video','Image → Video','Video → Video','Multi-reference → Video'])expect(pipe(name).disabled).toBe(true);
 choosePipe('Image → Image');
 // Without a picture to edit the Image pipeline is text to image: Run is open.
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));adopt();
 const ref=screen.getByRole('img',{name:'ref.png'});
 Object.defineProperties(ref,{naturalWidth:{value:1920},naturalHeight:{value:1080}});fireEvent.load(ref);
 // The slider under a number field drives the same value.
 fireEvent.change(screen.getByLabelText('Denoise').parentElement!.querySelector('input.wb-slider')!,{target:{value:'0.3'}});
 expect((screen.getByLabelText('Denoise') as HTMLInputElement).value).toBe('0.3');
 fireEvent.change(screen.getByLabelText('Denoise'),{target:{value:'0.4'}});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({inputImage:'ref.png',denoise:0.4,checkpoint:'a.safetensors'});
 // ✕ on the preview drops the pick (and the shown job): the Image pipeline is back to text to image.
 fireEvent.click(screen.getByRole('button',{name:'Close preview'}));
 expect(screen.queryByRole('img',{name:'ref.png'})).toBeNull();
 expect(screen.queryByRole('button',{name:'Close preview'})).toBeNull();
 expect(screen.getByRole('button',{name:'ref.png'}).getAttribute('aria-current')).toBe('false');
 expect(screen.queryByLabelText('Input scaling')).toBeNull();
});

test('IPC fixture: with an edit draft open, a queue pick opens beside the editor; a render opens in a zoomable full view',async()=>{
 // Own prerequisites rather than inheriting a previous test's mock.
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'out.png',path:'/env/ComfyUI/output/out.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 let made=0;
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({id:`job-${++made}`,baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'succeeded',outputRoot:'/env/ComfyUI/output',outputs:[{filename:'DEAS_0001.png',subfolder:'',type:'output'}],error:null,generationReady:false,intent:vi.mocked(runWorkbenchJob).mock.lastCall![1]} as JobStatus));
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await screen.findByRole('option',{name:'Image',selected:true});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await screen.findByRole('img',{name:'DEAS_0001.png'});
 expect(document.querySelector('.wb-editor-host')?.hasAttribute('hidden')).not.toBe(false); // text to image: the render takes the stage
 // Using a picture to edit switches the Image pipeline to editing.
 fireEvent.click(screen.getByRole('button',{name:'out.png'}));adopt();
 const img=screen.getByRole('img',{name:'out.png'});
 Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(img);
 fireEvent.click(screen.getByRole('button',{name:/Succeeded/}));
 expect(document.querySelector('.wb-editor-host')?.hasAttribute('hidden')).toBe(false);
 expect(document.querySelector('.wb-stage')?.classList.contains('wb-split')).toBe(true);
 clickMedia(screen.getByRole('img',{name:'DEAS_0001.png'}) as HTMLImageElement);
 const dialog=screen.getByRole('dialog',{name:'DEAS_0001.png'});
 expect(within(dialog).getByRole('button',{name:'Fit'})).toBeTruthy();
 fireEvent.keyDown(window,{key:'Escape'});
 expect(screen.queryByRole('dialog')).toBeNull();
 // A queue pick is preview only: after ✕ it does not bring the job's source back into the editor.
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(2));
 fireEvent.click(screen.getByRole('button',{name:'Close preview'}));
 expect(document.querySelector('.wb-editor-host')).toBeNull();
 fireEvent.click(screen.getAllByRole('button',{name:/Succeeded/})[0]); // newest first = the image-to-image job
 expect(document.querySelector('.wb-editor-host')).toBeNull();
 // Slider compare zooms with the wheel at the cursor; double-click resets.
 fireEvent.click(within(document.querySelector<HTMLElement>('.wb-stage > [data-media-tools]')!).getByRole('button',{name:'Slider'}));
 const compare=document.querySelector<HTMLElement>('.wb-compare')!;
 act(()=>{compare.dispatchEvent(new WheelEvent('wheel',{deltaY:-500,clientX:10,clientY:10,cancelable:true}));});
 expect(Number(compare.dataset.zoom)).toBeGreaterThan(1);
 fireEvent.doubleClick(compare);
 expect(compare.dataset.zoom).toBe('1.00');
});

test('a queue click only previews; Use these settings is the explicit restore',async()=>{
 vi.mocked(scanModels).mockResolvedValue(sessionModels);vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,checkpoints:sessionModels.map(m=>m.name)}});
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/',entries:[{name:'source.png',path:'/out/source.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({...heldJob('edit-job','succeeded'),baseUrl:evidence.baseUrl,outputRoot:'/out',outputs:[{filename:'result.png',subfolder:'',type:'output'}],intent:vi.mocked(runWorkbenchJob).mock.lastCall![1]}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/out'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'source.png'}));adopt();
 const img=document.querySelector<HTMLImageElement>('.wb-current-preview img')!;Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(img);
 choosePipe('Image → Image');sessionModel('folder/a.safetensors');sessionSettings({positive:'remembered i2i',steps:36});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await screen.findByRole('img',{name:'result.png'});fireEvent.click(screen.getByRole('button',{name:'Close preview'}));
 choosePipe('Text → Image');sessionSettings({positive:'outgoing t2i',steps:49}); // ✕ above cleared the picture to edit: text to image
 const row=document.querySelector('[data-job-id="edit-job"] .wb-queue-select')!;
 fireEvent.click(row);
 expect(document.querySelector('[data-pipeline]')).toHaveProperty('value','image');expect(screen.getByLabelText('Prompt')).toHaveProperty('value','outgoing t2i');
 expect(screen.getByLabelText('Steps')).toHaveProperty('value','49');
 fireEvent.contextMenu(row);
 expect(document.querySelector('[data-pipeline]')).toHaveProperty('value','image');
 fireEvent.click(screen.getByRole('menuitem',{name:'Reuse prompt'}));
 expect(screen.getByLabelText('Prompt')).toHaveProperty('value','remembered i2i');
 expect(screen.getByLabelText('Steps')).toHaveProperty('value','49');
 expect(document.querySelector('[data-pipeline]')).toHaveProperty('value','image');
 fireEvent.contextMenu(row);
 fireEvent.click(screen.getByRole('menuitem',{name:'Use these settings'}));
 await waitFor(()=>expect(document.querySelector('[data-pipeline]')).toHaveProperty('value','image'));
 await waitFor(()=>expect(screen.getByLabelText('Prompt')).toHaveProperty('value','remembered i2i'));
 expect(screen.getByLabelText('Steps')).toHaveProperty('value','36');
 expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
});

test('changing only the checkpoint keeps the prompts exactly, empty ones included',async()=>{
 vi.mocked(scanModels).mockResolvedValue(sessionModels);vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-model-picker]')?.textContent).toContain('folder/a.safetensors'));
 sessionModel('folder/a.safetensors');sessionSettings({positive:'old A',negative:'old A negative',steps:31});
 sessionModel('other/a.safetensors');sessionSettings({positive:'  edited, with spaces  ',negative:'',steps:32});
 sessionModel('folder/a.safetensors');
 expect(screen.getByLabelText('Prompt')).toHaveProperty('value','  edited, with spaces  ');
 expect(document.querySelector('#run-negative')).toHaveProperty('value','');
 expect(screen.getByLabelText('Steps')).toHaveProperty('value','31');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each(['click','Enter',' '] as const)('retained original opens and stars source A, not edited draft B (%s)',async activation=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a.safetensors',size:1,info:null,family:'sdxl'}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(invoke).mockImplementation(async(command,args)=>{
  if(command==='native_media_star_status')return {starred:false,unavailable:null};
  if(command==='native_media_star')return {oldPath:'/out/source-a.png',path:'/out/starred/source-a.png'};
  return {path:'/out',parent:'/',entries:['source-a.png','draft-b.png'].map(name=>({name,path:'/out/'+name,kind:'file',media:'image',symlink:false,size:1,modified:1})),truncated:false};
 });
 vi.mocked(runWorkbenchJob).mockImplementation(async(_endpoint,intent)=>({...heldJob('source-a-job','succeeded',evidence.baseUrl),intent,outputRoot:'/out',outputs:[{filename:'render.png',subfolder:'',type:'output'}]}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',input:'/input',output:'/out'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Image → Image').disabled).toBe(false));choosePipe('Image → Image');
 fireEvent.click(await screen.findByRole('button',{name:'source-a.png'}));adopt();
 const source=screen.getByRole('img',{name:'source-a.png'});
 Object.defineProperties(source,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(source);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await screen.findByRole('img',{name:'render.png'});
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({inputImage:'source-a.png [output]'});
 fireEvent.click(screen.getByRole('button',{name:'draft-b.png'}));adopt();
 const draft=screen.getByRole('img',{name:'draft-b.png'});
 Object.defineProperties(draft,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(draft);
 fireEvent.click(screen.getByRole('button',{name:'Select'}));
 const base=document.querySelector<HTMLElement>('[data-layer="base"]')!;
 fireEvent.keyDown(base,{key:'ArrowLeft'});expect(base.style.left).toBe('-8px');
 fireEvent.click(document.querySelector('[data-job-id="source-a-job"] .wb-queue-select')!);
 expect(base.querySelector('img')?.getAttribute('src')).toContain('/out/draft-b.png');
 expect(base.style.left).toBe('-8px');
 const original=document.querySelector<HTMLImageElement>('.wb-current-preview > figure.media-preview img')!;
 expect(original.getAttribute('src')).toContain('/out/source-a.png');
 expect(original.getAttribute('role')).toBe('button');expect(original.tabIndex).toBe(0);
 if(activation==='click')clickMedia(original);else{original.focus();expect(document.activeElement).toBe(original);expect(fireEvent.keyDown(original,{key:activation})).toBe(false);}
 const viewer=screen.getByRole('dialog',{name:'source-a.png'});
 expect(viewer.querySelector('img')?.getAttribute('src')).toContain('/out/source-a.png');
 expect(within(viewer).queryByRole('button',{name:'Star draft-b.png'})).toBeNull();
 const star=within(viewer).getByRole('button',{name:'Star source-a.png'});
 await waitFor(()=>expect(star.hasAttribute('disabled')).toBe(false));fireEvent.click(star);
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_media_star',{path:'/out/source-a.png'}));
 expect(invoke).not.toHaveBeenCalledWith('native_media_star',{path:'/out/draft-b.png'});
 expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
});

test('baseline-first readiness blocks only enabled refine and recovers when disabled',async()=>{
 localStorage.setItem('deas.pref.studio.run.post','true');
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a',size:1,info:null,family:'sdxl'}]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await screen.findByText(/Refine requires the DEAS baseline-first adapter/);
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('tab',{name:/Post-Processing/}));
 fireEvent.click(document.querySelector('[data-post-card="refine"]')!);
 fireEvent.click(screen.getByRole('checkbox',{name:'Refine / Upscale after every run'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 expect(screen.queryByText(/Refine requires the DEAS baseline-first adapter/)).toBeNull();
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('IPC fixture: Post-process upscales the shown image alone, then the render; the opt-in tab adds a refine pass to Run',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'DEAS_ImagePostprocessGate']}});
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'out.png',path:'/env/ComfyUI/output/out.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 let n=0;
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({id:`job-${++n}`,baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'succeeded',outputRoot:'/env/ComfyUI/output',outputs:[{filename:`DEAS_000${n}.png`,subfolder:'',type:'output'}],error:null,generationReady:false,intent:vi.mocked(runWorkbenchJob).mock.lastCall![1]} as JobStatus));
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'out.png'}));adopt();
 const img=screen.getByRole('img',{name:'out.png'});
 Object.defineProperties(img,{naturalWidth:{value:1000},naturalHeight:{value:600}});fireEvent.load(img);
 // Refine/Upscale live in the preview toolbar on every image (a video model would get an image job — videos are excluded).
 expect(screen.getByRole('button',{name:'Refine'})).toBeTruthy();
 expect(screen.getByRole('button',{name:'Upscale'})).toBeTruthy();
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 fireEvent.click(document.querySelector('[data-post-card="refine"]')!);
 fireEvent.change(screen.getByLabelText('Upscale factor'),{target:{value:'2'}});
 expect(screen.getByRole('button',{name:'Refine'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Image to Image'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Refine'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Refine'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const first=vi.mocked(runWorkbenchJob).mock.calls[0][1];
 expect(first).toMatchObject({inputImage:'out.png [output]',denoise:0.25,width:1984,height:1216,inputResize:{width:1984,height:1216,crop:'disabled'}}); // 2000×1200 snapped per edge to the SDXL 64 grid
 expect(first.refine).toBeUndefined();expect(first.upscaleModel).toBeUndefined();
 // Default: side by side, the still-mounted editor on the source left, the render right.
 expect(await screen.findByRole('img',{name:'DEAS_0001.png'})).toBeTruthy();
 expect(document.querySelector('.wb-editor-host')?.hasAttribute('hidden')).toBe(false);
 expect(screen.queryByRole('slider',{name:'Original / edited divider'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Slider',pressed:false}));
 expect(screen.getByRole('img',{name:'Original'})).toBeTruthy();
 expect(screen.getByRole('slider',{name:'Original / edited divider'})).toBeTruthy();
 expect(document.querySelector('.wb-editor-host')?.hasAttribute('hidden')).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Slider',pressed:true}));
 expect(document.querySelector('.wb-editor-host')?.hasAttribute('hidden')).toBe(false);
 // Instant again on the shown render: transfer its actual file, never infer the backend root.
 vi.mocked(uploadInput).mockResolvedValue('deas-inputs/shown.png');
 fireEvent.click(within(document.querySelector<HTMLElement>('.wb-stage > [data-media-tools]')!).getByRole('button',{name:'Refine'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(2));
 expect(vi.mocked(runWorkbenchJob).mock.calls[1][1]).toMatchObject({inputImage:'deas-inputs/shown.png',width:3968,height:2432});
 // Opt-in: every Run gets the refine pass at the upscaled grid size.
 for(let i=0;i<3&&screen.queryByLabelText('Input scaling');i++)fireEvent.click(screen.getByRole('button',{name:'Close preview'})); // no picture to edit: text to image
 fireEvent.click(screen.getByRole('checkbox',{name:'Refine / Upscale after every run'}));
 expect(screen.getByRole('tab',{name:'Post-Processing'}).querySelector('.wb-dock-badge')?.textContent).toBe('1');
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(3));
 const third=vi.mocked(runWorkbenchJob).mock.calls[2][1];
 expect(third.refine).toEqual({width:2048,height:2048,denoise:0.25});
 expect(third.inputImage).toBeUndefined();
 // Tiled refine is offered only when the backend lists the DaSiWa node; tiles = SDXL native 1024², overlap 128 on the 64 grid.
 const tiledBox=screen.getByRole('checkbox',{name:'Tiled refine (DaSiWa Tiled Diffusion)'});
 expect(tiledBox.hasAttribute('disabled')).toBe(true);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,nodes:[...evidence.allowlist.nodes,'DEAS_ImagePostprocessGate','DaSiWaTiledDiffusion']}});
 cleanup();
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await screen.findByRole('option',{name:'Image',selected:true});
 fireEvent.click(document.querySelector('[data-post-card="refine"]')!);
 const box=await screen.findByRole('checkbox',{name:'Tiled refine (DaSiWa Tiled Diffusion)'});
 await waitFor(()=>expect(box.hasAttribute('disabled')).toBe(false));
 fireEvent.click(box);
 expect(screen.getByText('Samples the refine pass in 1024×1024 tiles with 128 px overlap blended every step — the model’s native size, so large outputs stay sharp and seamless.')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(4));
 expect(vi.mocked(runWorkbenchJob).mock.calls[3][1].refine).toEqual({width:2048,height:2048,denoise:0.25,tiled:{tileWidth:1024,tileHeight:1024,overlap:128}});
});

test.each([{cropped:false,paintBase:false,delayed:false,paintLayer:false},{cropped:true,paintBase:false,delayed:false,paintLayer:false},{cropped:false,paintBase:true,delayed:false,paintLayer:false},{cropped:true,paintBase:false,delayed:true,paintLayer:true}])('IPC fixture: Inpaint preserves draft and submits edited base ($cropped, $paintBase)',async({cropped,paintBase,delayed,paintLayer})=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 const entry=(name:string)=>({name,path:`/env/ComfyUI/output/${name}`,kind:'file',symlink:false,media:'image',size:1,modified:1});
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[entry('out.png'),entry('cat.png')],truncated:false}));
 vi.stubGlobal('Image',class{naturalWidth=200;naturalHeight=100;onload=()=>{};onerror=()=>{};decode=async()=>{};set src(_:string){setTimeout(()=>this.onload());}});
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'job-in',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:null,generationReady:false});
 const uploadedMask='deas-masks/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png';
 let releaseMask!:(name:string)=>void;
 vi.mocked(uploadMask).mockResolvedValue(uploadedMask);
 if(delayed)vi.mocked(uploadMask).mockReturnValueOnce(new Promise(yes=>{releaseMask=yes;}));
 const ctx={canvas:{width:1024,height:640},save:vi.fn(),restore:vi.fn(),getImageData:vi.fn(()=>({data:new Uint8ClampedArray([255,255,255,255])})),arc:vi.fn(),fill:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),clearRect:vi.fn(),fillRect:vi.fn(),drawImage:vi.fn()};
 const restore=[vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D),
  vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(cb=>cb({arrayBuffer:async()=>new Uint8Array([137,80,78,71]).buffer} as Blob)), // jsdom Blob has no arrayBuffer
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:512,height:320} as DOMRect)];
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'out.png'}));adopt();
 const img=screen.getByRole('img',{name:'out.png'});
 Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(img);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Inpaint'}).hasAttribute('disabled')).toBe(false));
 expect(screen.queryByRole('checkbox',{name:'Inpaint only masked'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Inpaint'}));
 expect((screen.getByRole('spinbutton',{name:'Mask Blur (px)'}) as HTMLInputElement).value).toBe('4');
 if(cropped){const padding=screen.getByRole('spinbutton',{name:'Context padding (px)'});expect((padding as HTMLInputElement).disabled).toBe(true);fireEvent.click(screen.getByRole('checkbox',{name:'Inpaint only masked'}));expect((padding as HTMLInputElement).disabled).toBe(false);fireEvent.change(padding,{target:{value:'32'}});dock('Post-Processing');expect(document.querySelector<HTMLInputElement>('[data-sam="margin"]')!.value).toBe('32');fireEvent.change(screen.getByRole('spinbutton',{name:'Mask Blur (px)'}),{target:{value:'8'}});dock('Media');await screen.findByRole('button',{name:'cat.png'});}
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true); // nothing painted yet
 const mask=screen.getByLabelText('Inpaint mask',{selector:'canvas'}) as HTMLCanvasElement;
 const viewport=document.querySelector<HTMLElement>('[data-editor-viewport]')!;
 viewport.setPointerCapture=vi.fn();
 expect([mask.width,mask.height]).toEqual([1024,640]);
 fireEvent(viewport,new MouseEvent('pointerdown',{clientX:256,clientY:160,buttons:1,bubbles:true}));
 fireEvent(viewport,new MouseEvent('pointerup',{clientX:256,clientY:160,bubbles:true}));
 expect(ctx.arc).toHaveBeenCalledWith(512,320,24,0,Math.PI*2);
 fireEvent.click(screen.getByRole('button',{name:'Image to Image'}));
 fireEvent.click(screen.getByRole('button',{name:'Inpaint'}));
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 dropTile('cat.png');
 const layer=await screen.findByRole('group',{name:'Inserted image cat.png [output]'});
 await waitFor(()=>{
  expect(layer.classList.contains('is-selected')).toBe(true);
  expect(screen.getByRole('button',{name:'Select',pressed:true})).toBeTruthy();
 });
 fireEvent.keyDown(layer,{key:'ArrowRight'});
 fireEvent.click(screen.getByRole('button',{name:'out.png'}));adopt();
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 expect(screen.getByRole('group',{name:'Inserted image cat.png [output]'})).toBe(layer);
 expect(screen.getByLabelText('Inpaint mask',{selector:'canvas'})).toBe(mask);
 expect(document.querySelector('[data-editor-viewport]')).toBe(viewport);
 if(paintLayer){
  fireEvent.click(screen.getByRole('button',{name:'Brush'}));
  fireEvent(viewport,new MouseEvent('pointerdown',{clientX:256,clientY:160,buttons:1,bubbles:true}));
  fireEvent(viewport,new MouseEvent('pointerup',{clientX:256,clientY:160,bubbles:true}));
 }
 if(paintBase){
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,blob:async()=>new Blob()})));
  vi.stubGlobal('createImageBitmap',vi.fn(async()=>({close:vi.fn()})));
  fireEvent.click(screen.getByRole('button',{name:'Base image'}));fireEvent.click(screen.getByRole('button',{name:'Brush'}));
  fireEvent(viewport,new MouseEvent('pointerdown',{clientX:200,clientY:100,buttons:1,bubbles:true}));
  fireEvent(viewport,new MouseEvent('pointerup',{clientX:200,clientY:100,bubbles:true}));
 }
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 if(delayed){
  await waitFor(()=>expect(uploadMask).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'next draft'} });
  fireEvent.change(screen.getByLabelText('Mask Blur (px)'),{target:{value:'12'}});
  fireEvent.keyDown(layer,{key:'ArrowRight'});
  expect(runWorkbenchJob).not.toHaveBeenCalled();
  await act(async()=>releaseMask(uploadedMask));
 }
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(uploadMask).toHaveBeenCalledWith('http://127.0.0.1:7801',new Uint8Array([137,80,78,71]));
 const intent=vi.mocked(runWorkbenchJob).mock.calls[0][1];
 expect(intent).toMatchObject({inputImage:paintBase?'deas-masks/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png':'out.png [output]',inputMask:'deas-masks/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png',denoise:0.8,width:1024,height:640});
 expect(intent.inputResize).toBeUndefined();
 if(cropped){expect(intent.maskBlur).toBe(8);expect(intent.inpaintCrop).toEqual({x:0,y:0,width:41,height:41,targetWidth:1024,targetHeight:1024});}
 else{expect(intent.maskBlur).toBe(4);expect(intent.inpaintCrop).toBeUndefined();}
 if(paintBase){expect(intent.inputLayers).toBeUndefined();expect(uploadMask).toHaveBeenCalledTimes(2);}
 else expect(intent.inputLayers).toEqual([{image:paintLayer?uploadedMask:'cat.png [output]',x:420,y:270,width:200,height:100}]); // original size, centred then moved
 // The edit job opens side by side: the same editor stays live on the left, no return needed.
 expect(screen.queryByRole('button',{name:'Return to edit draft'})).toBeNull();
 expect(document.querySelector('.wb-editor-host')?.hasAttribute('hidden')).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'out.png'}));adopt();
 expect(document.querySelector('[data-editor-viewport]')).toBe(viewport);
 expect(screen.getByRole('group',{name:'Inserted image cat.png [output]'})).toBe(layer);
 // Run re-enables once the submitted job is observed; under parallel load that poll can land after this line.
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'cat.png'}));adopt();
 const next=screen.getByRole('img',{name:'cat.png'});
 Object.defineProperties(next,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(next);
 expect(screen.queryByRole('group',{name:'Inserted image cat.png [output]'})).toBeNull();
 expect(screen.getByLabelText('Inpaint mask',{selector:'canvas'})).not.toBe(mask);
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 restore.forEach(s=>s.mockRestore());
 vi.unstubAllGlobals();
});

test('IPC fixture: dropping a dock tile pastes the Output image as a movable layer and submits it as inputLayers in source pixels',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 const entry=(name:string)=>({name,path:`/env/ComfyUI/output/${name}`,kind:'file',symlink:false,media:'image',size:1,modified:1});
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[entry('src.png'),entry('cat.png')],truncated:false}));
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'job-l',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false});
 // jsdom never loads images: report a 2:1 picture.
 vi.stubGlobal('Image',class{naturalWidth=200;naturalHeight=100;onload=()=>{};onerror=()=>{};set src(_:string){setTimeout(()=>this.onload());}});
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'src.png'}));adopt();
 const img=screen.getByRole('img',{name:'src.png'});
 Object.defineProperties(img,{naturalWidth:{value:1000},naturalHeight:{value:600}});fireEvent.load(img);
 await screen.findByRole('button',{name:'Image to Image'});
 fireEvent.click(screen.getByRole('button',{name:'Image to Image'}));
 await waitFor(()=>expect(document.querySelector('[data-editor-viewport]')).not.toBeNull());
 dropTile('cat.png');
 expect(screen.getByRole('button',{name:'Image to Image',pressed:true})).toBeTruthy();
 const layer=await screen.findByRole('group',{name:'Inserted image cat.png [output]'});
 expect(screen.getByRole('img',{name:'src.png'})).toBeTruthy(); // the source stays selected
 fireEvent.keyDown(layer,{key:'ArrowRight'});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({inputImage:'src.png [output]',inputLayers:[{image:'cat.png [output]',x:408,y:250,width:200,height:100}]}); // original size centred (400,250) then ArrowRight +8
 vi.unstubAllGlobals();
});

test('checkpoint dropdown and Models tiles share selection/defaults and missing models are not substituted',async()=>{
 const model=(name:string,family='sdxl',category='checkpoints')=>({category,name,family,path:'/m/'+name,size:1,info:null});
 vi.mocked(scanModels).mockResolvedValue([model('first.safetensors'),model('second.safetensors'),model('unsupported.safetensors','unknown','diffusion_models')]);
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 const select=await screen.findByRole('combobox',{name:'Checkpoint'});
 await waitFor(()=>expect((select as HTMLSelectElement).value).toBe('first.safetensors'));
 expect(within(select).queryByRole('option',{name:'unsupported.safetensors'})).toBeNull();
 fireEvent.change(select,{target:{value:'second.safetensors'}});
 dock('Models');expect(screen.getByRole('button',{name:'second.safetensors'}).getAttribute('aria-pressed')).toBe('true');
 expect((screen.getByLabelText('Steps') as HTMLInputElement).value).toBe('20'); // same-family switch keeps the settings on screen instead of reapplying family defaults
 fireEvent.click(screen.getByRole('button',{name:'first.safetensors'}));expect((select as HTMLSelectElement).value).toBe('first.safetensors');
 expect(localStorage.getItem('deas.pref.studio.run.checkpoint')).toBe('"first.safetensors"');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('known models in the wrong loader folder are hidden from the picker but remain disabled in Models, including duplicate names',async()=>{
 const m=(category:string,name:string,family?:string)=>({category,name,family,path:`/m/${category}/${name}`,size:1,info:null});
 const anima='dasiwaAnima_obsidianArchivesV2+Int8.safetensors';
 vi.mocked(scanModels).mockResolvedValue([m('checkpoints',anima,'anima'),m('diffusion_models',anima,'anima'),m('diffusion_models','misplaced-sdxl.safetensors','sdxl'),m('unet','legacy-anima.safetensors','anima'),m('checkpoints','unknown.safetensors')]);
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 const select=await screen.findByRole('combobox',{name:'Checkpoint'});
 await waitFor(()=>expect(within(select).getAllByRole('option',{name:anima})).toHaveLength(1));
 expect((within(select).getByRole('option',{name:anima}) as HTMLOptionElement).value).toBe(JSON.stringify(['diffusion_models',`/m/diffusion_models/${anima}`,anima]));
 expect((select as HTMLSelectElement).selectedOptions[0].disabled).toBe(false);
 expect(within(select).queryByRole('option',{name:'misplaced-sdxl.safetensors'})).toBeNull();
 expect((within(select).getByRole('option',{name:'legacy-anima.safetensors'}) as HTMLOptionElement).disabled).toBe(false);
 expect((within(select).getByRole('option',{name:'unknown.safetensors'}) as HTMLOptionElement).disabled).toBe(false);
 dock('Models');
 const tiles=screen.getAllByRole('button',{name:anima}) as HTMLButtonElement[];
 expect(tiles.filter(b=>b.getAttribute('aria-disabled')==='true')).toHaveLength(1);
 expect(tiles.find(b=>b.getAttribute('aria-disabled')==='false')?.getAttribute('aria-pressed')).toBe('true');
 expect(screen.getByRole('button',{name:'misplaced-sdxl.safetensors'}).getAttribute('aria-disabled')).toBe('true');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('a remembered misplaced Anima stays blocked with an actionable warning rather than selecting another model',async()=>{
 const name='misplaced-anima.safetensors';
 localStorage.setItem('deas.pref.studio.run.checkpoint',JSON.stringify(name));
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name,family:'anima',path:'/m/'+name,size:1,info:null},{category:'checkpoints',name:'other.safetensors',path:'/m/other',size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('diffusion_models'));
 expect((screen.getByRole('combobox',{name:'Checkpoint'}) as HTMLSelectElement).value).toBe(name);
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('companion files are collapsed below the other settings and preserve their choices while closed',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'diffusion_models',name:'anima.safetensors',family:'anima',path:'/m/a',size:1,info:null},{category:'text_encoders',name:'qwen_3_600m.safetensors',path:'/m/e',size:1,info:null},{category:'vae',name:'wan_2.1_vae.safetensors',path:'/m/v',size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 const summary=await screen.findByText('Model files',{selector:'summary'}),details=summary.parentElement!;
 expect(details.hasAttribute('open')).toBe(false);expect(details.contains(screen.getByLabelText('Text encoder'))).toBe(true);
 expect(details.previousElementSibling?.classList.contains('wb-controls')).toBe(true);
 fireEvent.click(summary);const encoder=screen.getByRole('combobox',{name:'Text encoder'});
 fireEvent.change(encoder,{target:{value:'qwen_3_600m.safetensors'}});
 fireEvent.click(summary);expect(details.hasAttribute('open')).toBe(false);
 fireEvent.click(summary);expect((screen.getByRole('combobox',{name:'Text encoder'}) as HTMLSelectElement).value).toBe('qwen_3_600m.safetensors');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('Anima recommends renamed header-detected companions and ignores misleading known-incompatible names',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,diffusionModels:['anima.safetensors'],nodes:[...evidence.allowlist.nodes,'UNETLoader']}});
 const m=(category:string,name:string,family?:string,component?:string)=>({category,name,family,component,path:'/m/'+name,size:1,info:null});
 const encoder='dasiwaAnima_luminousLabyrinthV1_txt.safetensors',vae='provider-renamed-vae.safetensors';
 vi.mocked(scanModels).mockResolvedValue([m('diffusion_models','anima.safetensors','anima'),m('text_encoders',encoder,undefined,'qwen3-0.6b'),m('vae',vae,undefined,'wan-2.1-vae'),m('text_encoders','qwen_3_600m-impostor.safetensors',undefined,'qwen3-vl-8b')]);
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await screen.findByRole('combobox',{name:'Text encoder'});
 for(const [label,name] of [['Text encoder',encoder],['VAE',vae]]){
  const select=screen.getByRole('combobox',{name:label}) as HTMLSelectElement;
  expect(select.selectedOptions[0].textContent).toBe('Automatic · '+name);
  expect(screen.getByRole('switch',{name:label+': All files'}).getAttribute('aria-checked')).toBe('false');
 }
 expect(within(screen.getByRole('combobox',{name:'Text encoder'})).queryByRole('option',{name:'qwen_3_600m-impostor.safetensors'})).toBeNull();
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('companion overrides are independently selectable without inferred matches, persist and gate Run when switched off',async()=>{
 const m=(category:string,name:string,family?:string)=>({category,name,family,path:'/m/'+category+'/'+name,size:1,info:null});
 const renamed='dasiwaAnima_luminousLabyrinthV1_txt.safetensors';
 vi.mocked(scanModels).mockResolvedValue([m('diffusion_models','anima.safetensors','anima'),m('text_encoders',renamed),m('vae','custom-vae.safetensors'),m('checkpoints','not-an-encoder.safetensors')]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,diffusionModels:['anima.safetensors'],nodes:[...evidence.allowlist.nodes,'UNETLoader']}});
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'component-job',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:null,generationReady:false});
 const mount=()=>render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 const view=mount();await screen.findByRole('combobox',{name:'Text encoder'});
 const encoder=screen.getByRole('combobox',{name:'Text encoder'}),vae=screen.getByRole('combobox',{name:'VAE'});
 const encoderSwitch=screen.getByRole('switch',{name:'Text encoder: All files'}),vaeSwitch=screen.getByRole('switch',{name:'VAE: All files'});
 expect(encoderSwitch.getAttribute('aria-checked')).toBe('false');
 expect(within(encoder).queryByRole('option',{name:renamed})).toBeNull();
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 fireEvent.click(encoderSwitch);expect(vaeSwitch.getAttribute('aria-checked')).toBe('false');
 expect(within(encoder).queryByRole('option',{name:'not-an-encoder.safetensors'})).toBeNull();
 expect((encoder as HTMLSelectElement).value).toBe(''); // widening the list never auto-picks an arbitrary file
 fireEvent.change(encoder,{target:{value:renamed}});
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 fireEvent.click(vaeSwitch);fireEvent.change(vae,{target:{value:'custom-vae.safetensors'}});
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({checkpoint:'anima.safetensors',componentOverrides:{textEncoders:true,vaes:true,audioVaes:false,textProjections:false},diffusion:{textEncoder:renamed,clipType:'stable_diffusion',vae:'custom-vae.safetensors'}});
 fireEvent.click(encoderSwitch);
 expect((encoder as HTMLSelectElement).value).toBe(renamed); // never silently replace the manual choice
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 expect(screen.getByRole('alert').textContent).toContain(renamed);
 view.unmount();mount();await screen.findByRole('combobox',{name:'Text encoder'});
 expect((screen.getByRole('combobox',{name:'Text encoder'}) as HTMLSelectElement).value).toBe(renamed);
 expect(screen.getByRole('switch',{name:'Text encoder: All files'}).getAttribute('aria-checked')).toBe('false');
 expect(screen.getByRole('switch',{name:'VAE: All files'}).getAttribute('aria-checked')).toBe('true');
});

test('audio VAE and text-projection overrides submit exact manual choices and never silently fall back after filtering or removal',async()=>{
 const m=(category:string,name:string,family?:string)=>({category,name,family,path:'/m/'+name,size:1,info:null});
 let files=[m('diffusion_models','ltx.safetensors','ltx-2'),m('text_encoders','gemma.safetensors'),m('text_encoders','text_projection.safetensors'),m('text_encoders','custom-projection.safetensors'),m('vae','video_vae.safetensors'),m('vae','audio_vae.safetensors'),m('vae','custom-audio.safetensors')];
 vi.mocked(scanModels).mockImplementation(async()=>files);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,diffusionModels:['ltx.safetensors'],nodes:[...evidence.allowlist.nodes,'UNETLoader']}});
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'video-components-job',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:null,generationReady:false});
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 await screen.findByRole('combobox',{name:'Audio VAE'});
 for(const [label,file] of [['Audio VAE','custom-audio.safetensors'],['Text projection','custom-projection.safetensors']]){
  fireEvent.click(screen.getByRole('switch',{name:label+': All files'}));
  fireEvent.change(screen.getByRole('combobox',{name:label}),{target:{value:file}});
 }
 expect(screen.getByRole('switch',{name:'Text encoder: All files'}).getAttribute('aria-checked')).toBe('false');
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({family:'ltx-2',componentOverrides:{textEncoders:false,vaes:false,audioVaes:true,textProjections:true},ltx:{audioVae:'custom-audio.safetensors',textProjection:'custom-projection.safetensors'}});
 fireEvent.click(screen.getByRole('switch',{name:'Audio VAE: All files'}));
 expect((screen.getByRole('combobox',{name:'Audio VAE'}) as HTMLSelectElement).value).toBe('custom-audio.safetensors');
 expect(screen.getByRole('alert').textContent).toContain('custom-audio.safetensors');
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 fireEvent.click(screen.getByRole('switch',{name:'Audio VAE: All files'}));
 files=files.filter(file=>file.name!=='custom-audio.safetensors');dock('Models');fireEvent.click(document.querySelector('[data-run-load]')!);
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('custom-audio.safetensors'));
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 expect((screen.getByRole('combobox',{name:'Audio VAE'}) as HTMLSelectElement).value).toBe('custom-audio.safetensors');
 expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
});

test('IPC fixture: families gate models and LoRAs, picking applies the family defaults and a diffusion model submits its encoder and VAE',async()=>{
 const m=(category:string,name:string,family?:string)=>({category,name,path:`/m/${category}/${name}`,size:1,info:null,...(family?{family}:{})});
 vi.mocked(scanModels).mockResolvedValue([m('checkpoints','ill.safetensors','sdxl'),m('diffusion_models','k2.safetensors','krea-2'),m('diffusion_models','h3.safetensors','minimax-h3'),m('unet','odd.safetensors'),
  m('text_encoders','qwen3vl_4b.safetensors'),m('vae','Q/qwen_image_vae.safetensors'),m('loras','k-style.safetensors','krea-2'),m('loras','ill-style.safetensors','sdxl'),m('loras','mystery.safetensors')]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,checkpoints:['ill.safetensors'],diffusionModels:['k2.safetensors','h3.safetensors','odd.safetensors'],nodes:[...evidence.allowlist.nodes,'UNETLoader'],samplers:['euler','er_sde','res_multistep'],schedulers:['normal','simple','beta']}});
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'job-3',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:'x',generationReady:false});
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 dock('Models');
 expect((await screen.findByRole('button',{name:/h3\.safetensors/})).getAttribute('aria-disabled')).toBe('false'); // H3 edits pictures in the one Image pipeline
 expect(screen.getByRole('button',{name:/odd\.safetensors/}).getAttribute('aria-disabled')).toBe('true'); // unknown diffusion model
 fireEvent.click(screen.getByRole('button',{name:/k2\.safetensors/}));
 expect((screen.getByLabelText('Steps') as HTMLInputElement).value).toBe('8');
 expect((screen.getByLabelText('CFG') as HTMLInputElement).value).toBe('1');
 expect((screen.getByLabelText('Text encoder') as HTMLSelectElement).selectedOptions[0].textContent).toBe('Automatic · qwen3vl_4b.safetensors');
 dock('LoRAs');
 expect(screen.queryByRole('button',{name:/ill-style/})).toBeNull(); // other family hidden, unknown kept
 fireEvent.click(screen.getByRole('button',{name:/k-style/}));expect(screen.getByRole('button',{name:/mystery/})).toBeTruthy();
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(1); // the backend list is read once when the endpoint is known, so the first click already shows it
 await waitFor(()=>expect(Array.from((screen.getByLabelText('Sampler') as HTMLSelectElement).options,o=>o.value)).toEqual(['euler','er_sde','res_multistep']));
 fireEvent.focus(screen.getByLabelText('Sampler'));expect(checkRecipePrerequisites).toHaveBeenCalledTimes(1);
 fireEvent.change(screen.getByLabelText('Sampler'),{target:{value:'res_multistep'}});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({checkpoint:'k2.safetensors',sampler:'res_multistep',scheduler:'simple',loras:[{name:'k-style.safetensors',strength:1}],diffusion:{textEncoder:'qwen3vl_4b.safetensors',clipType:'krea2',vae:'Q/qwen_image_vae.safetensors'}});
});

test('IPC fixture: a Turbo family locks steps and scheduler to its saved schedule, submits the sigmas and keeps the base family LoRAs',async()=>{
 const m=(category:string,name:string,family?:string)=>({category,name,path:`/m/${category}/${name}`,size:1,info:null,...(family?{family}:{})});
 vi.mocked(scanModels).mockResolvedValue([m('diffusion_models','turbo.safetensors','qwen-image-2.1-turbo'),m('text_encoders','qwen3vl_8b.safetensors'),m('vae','qwen_image_2.1_vae.safetensors'),m('loras','q-style.safetensors','qwen-image-2.1')]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,diffusionModels:['turbo.safetensors'],nodes:[...evidence.allowlist.nodes,'UNETLoader']}});
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'job-4',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:'x',generationReady:false});
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 dock('Models');fireEvent.click(await screen.findByRole('button',{name:/turbo\.safetensors/}));
 const steps=screen.getByLabelText('Steps') as HTMLInputElement;expect(steps.value).toBe('8');expect(steps.disabled).toBe(true);
 const scheduler=screen.getByLabelText('Scheduler') as HTMLSelectElement;expect(scheduler.disabled).toBe(true);expect(scheduler.options[scheduler.selectedIndex].text).toBe('CUSTOM');
 expect((screen.getByLabelText('Sampler') as HTMLSelectElement).disabled).toBe(false);
 dock('LoRAs');expect(screen.getByRole('button',{name:/q-style/})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({checkpoint:'turbo.safetensors',steps:8,cfg:1,sampler:'euler',sigmas:[1.0,0.978453,0.95418,0.926626,0.89508,0.845148,0.704534,0.414568,0]});
 // A typed schedule in Options overrides the model's own; steps follow it.
 dock('Options');fireEvent.change(screen.getByRole('textbox',{name:'Custom sigmas'}),{target:{value:'1, 0.6, 0.3, 0'}});
 expect((screen.getByLabelText('Steps') as HTMLInputElement).value).toBe('3');
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(2));
 expect(vi.mocked(runWorkbenchJob).mock.calls[1][1]).toMatchObject({steps:3,sigmas:[1,0.6,0.3,0]});
});

test('automatic aspect is confined to media pipelines and text pipelines ignore image and video previews',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[
  {name:'wide.png',path:'/env/input/wide.png',kind:'file',symlink:false,media:'image',size:1,modified:1},
  {name:'portrait.mp4',path:'/env/input/portrait.mp4',kind:'file',symlink:false,media:'video',size:1,modified:2},
 ],truncated:false}));
 const {container}=render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/input'}}/></I18nProvider>);
 await screen.findByRole('option',{name:'Image',selected:true});
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 const aspectPicker=screen.getByLabelText('Aspect ratio') as HTMLSelectElement;
 expect(Array.from(aspectPicker.options,o=>o.value)).not.toContain('auto');
 fireEvent.change(screen.getByLabelText('Resolution'),{target:{value:'model'}});
 // A preview alone is not a picture to edit: the Image pipeline stays text to image.
 fireEvent.click(await screen.findByRole('button',{name:'wide.png'}));
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1024');
 adopt();
 const image=screen.getByRole('img',{name:'wide.png'});
 Object.defineProperties(image,{naturalWidth:{value:1920},naturalHeight:{value:1080}});fireEvent.load(image);
 expect(Array.from(aspectPicker.options,o=>o.value)).toContain('auto');
 expect(aspectPicker.value).toBe('auto');
 fireEvent.change(screen.getByLabelText('Input scaling'),{target:{value:'target'}});
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1344');
 fireEvent.click(screen.getByRole('button',{name:'Close preview'})); // clearing the picture to edit returns to text to image
 expect(Array.from(aspectPicker.options,o=>o.value)).not.toContain('auto');
 expect(aspectPicker.value).toBe('1:1');
 // Native: the stage video plays a blob of the asset bytes (WebKitGTK rejects asset:// media), fetched once per selection.
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,blob:async()=>new Blob(['x'],{type:'video/mp4'})})));
 Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=>'blob:deas/1')});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});
 fireEvent.click(screen.getByRole('button',{name:'portrait.mp4'}));adopt();
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 const video=container.querySelector('.wb-stage video')!;
 expect(fetch).toHaveBeenCalledWith('asset://localhost//env/input/portrait.mp4');
 await waitFor(()=>expect(video.getAttribute('src')).toBe('blob:deas/1'));
 Object.defineProperties(video,{videoWidth:{value:1080},videoHeight:{value:1920}});fireEvent.loadedMetadata(video);
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1024');
 expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('1024');
 expect(container.querySelector('.wb-resolution-summary')).toBeNull();
 expect(container.querySelector('.wb-aspect-picker .wb-aspect-swatch')).not.toBeNull();
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 expect(pipe('Image → Video').disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('Width'),{target:{value:'640'}});
 fireEvent.change(screen.getByLabelText('Height'),{target:{value:'480'}});
 fireEvent.click(screen.getByRole('button',{name:'wide.png'}));adopt();
 const nextImage=screen.getByRole('img',{name:'wide.png'});
 Object.defineProperties(nextImage,{naturalWidth:{value:1920},naturalHeight:{value:1080}});fireEvent.load(nextImage);
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('640');
 expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('480');
 expect((screen.getByLabelText('Resolution') as HTMLSelectElement).value).toBe('fixed');
});

test('Inpaint rejects a source outside the model grid instead of silently rounding its pixels',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'odd.png',path:'/env/out/odd.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/env/out'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'odd.png'}));adopt();
 const img=screen.getByRole('img',{name:'odd.png'});
 Object.defineProperties(img,{naturalWidth:{value:1000},naturalHeight:{value:600}});fireEvent.load(img);
 fireEvent.click(screen.getByRole('button',{name:'Inpaint'}));
 expect(screen.getByText('Resample this image to the selected model’s resolution grid before inpainting.')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 expect(uploadMask).not.toHaveBeenCalled();
});

test.each(['late','error'])('Dropped tile %s loading cannot create a guessed or stale image layer',async(mode)=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a',size:1,info:null,family:'sdxl'}]);
 const entry=(name:string)=>({name,path:`/env/out/${name}`,kind:'file',symlink:false,media:'image',size:1,modified:1});
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[entry('base.png'),entry('cat.png'),entry('other.png')],truncated:false}));
 let loaded=()=>{},failed=()=>{};
 vi.stubGlobal('Image',class{naturalWidth=200;naturalHeight=100;onload=()=>{};onerror=()=>{};set src(_:string){loaded=()=>this.onload();failed=()=>this.onerror();}});
 try{
  render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/env/out'}}/></I18nProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'base.png'}));adopt();
  const img=screen.getByRole('img',{name:'base.png'});
  Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(img);
  await waitFor(()=>expect(document.querySelector('[data-editor-viewport]')).not.toBeNull());
  dropTile('cat.png');
  if(mode==='late'){
   fireEvent.click(screen.getByRole('button',{name:'other.png'}));adopt();
   const other=screen.getByRole('img',{name:'other.png'});
   Object.defineProperties(other,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(other);
   await act(async()=>loaded());
  }
  else{await act(async()=>failed());expect(screen.getByRole('alert').textContent).toBe('This image could not be loaded for insertion.');}
  expect(screen.queryByRole('group',{name:'Inserted image cat.png [output]'})).toBeNull();
 }finally{vi.unstubAllGlobals();}
});

test('native resolution is one model-driven choice and migrates the removed 768px preference',async()=>{
 localStorage.setItem('deas.pref.studio.run.resolution',JSON.stringify('auto'));
 localStorage.setItem('deas.pref.studio.run.width','768');
 localStorage.setItem('deas.pref.studio.run.height','768');
 const m=(category:string,name:string,family?:string)=>({category,name,path:`/m/${category}/${name}`,size:1,info:null,...(family?{family}:{})});
 vi.mocked(scanModels).mockResolvedValue([m('checkpoints','base.safetensors','sdxl'),m('diffusion_models','qwen.safetensors','qwen-image-2.1'),m('text_encoders','qwen3vl_8b.safetensors'),m('vae','qwen_image_2.1_vae.safetensors')]);
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 dock('Models');
 await screen.findByRole('button',{name:/base.safetensors/});
 const picker=screen.getByLabelText('Resolution') as HTMLSelectElement;
 expect(Array.from(picker.options,o=>o.value)).not.toContain('auto');
 expect(Array.from(picker.options).filter(o=>o.textContent==='Native')).toHaveLength(1);
 expect(picker.value).toBe('model');
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1024');
 fireEvent.click(screen.getByRole('button',{name:/qwen.safetensors/}));
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('2048');
 expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('2048');
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.resolution')!)).toBe('model');
});

test('resolution picker follows reference metadata, forwards padded pixels to the model and remembers settings',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'wide.png',path:'/env/input/wide.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'resolution-job',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:'fixture',generationReady:false});
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/input'}}/></I18nProvider>);
 await screen.findByRole('option',{name:'Image',selected:true});
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'wide.png'}));adopt();
 choosePipe('Image → Image');
 fireEvent.change(screen.getByLabelText('Resolution'),{target:{value:'model'}});
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 const ref=screen.getByRole('img',{name:'wide.png'});
 Object.defineProperties(ref,{naturalWidth:{value:1920},naturalHeight:{value:1080}});fireEvent.load(ref);
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1344');
 expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('768');
 fireEvent.change(screen.getByLabelText('Aspect ratio'),{target:{value:'1:1'}});
 fireEvent.change(screen.getByLabelText('Resolution'),{target:{value:'1024p'}});
 fireEvent.change(screen.getByLabelText('Input scaling'),{target:{value:'pad'}});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({width:1024,height:1024,inputImage:'wide.png',inputResize:{width:1024,height:576,crop:'disabled',pad:{left:0,right:0,top:224,bottom:224}}});
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.inputScaling')!)).toBe('pad');
 fireEvent.change(screen.getByLabelText('Resolution'),{target:{value:'fixed'}});
 fireEvent.change(screen.getByLabelText('Width'),{target:{value:'8192'}});
 fireEvent.change(screen.getByLabelText('Height'),{target:{value:'8192'}});
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
});

test('IPC fixture: video families enable Image→Video; LTX submits a video intent with frames on the 8k+1 grid and a video output plays in the stage',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(scanModels).mockResolvedValue([
  {category:'unet',name:'LTX2/ltx.safetensors',path:'/m/unet/LTX2/ltx.safetensors',size:1,info:null,family:'ltx-2'},
  {category:'text_encoders',name:'gemma_3_12B_it_fp8.safetensors',path:'/m/text_encoders/gemma.safetensors',size:1,info:null},
  {category:'text_encoders',name:'ltx-2.3_text_projection_bf16.safetensors',path:'/m/text_encoders/proj.safetensors',size:1,info:null},
  {category:'vae',name:'LTX2/LTX23_video_vae_bf16.safetensors',path:'/m/vae/v.safetensors',size:1,info:null},
  {category:'vae',name:'LTX2/LTX23_audio_vae_bf16.safetensors',path:'/m/vae/a.safetensors',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'ref.png',path:'/env/ComfyUI/input/ref.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({id:'job-v',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'succeeded',outputs:[{filename:'x_00001.webm',subfolder:'video',type:'output',format:'video/webm'}],error:null,generationReady:false,intent:vi.mocked(runWorkbenchJob).mock.lastCall![1]} as JobStatus));
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Text → Video').disabled).toBe(false));
 expect(pipe('Image → Video').disabled).toBe(false);
 expect(pipe('Video → Video').disabled).toBe(false);
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));adopt();
 choosePipe('Image → Video');fireEvent.click(menuOf('ref.png').getByRole('menuitem',{name:'Use as first frame'}));
 expect((screen.getByLabelText('Steps') as HTMLInputElement).value).toBe('8');
 const ref=screen.getByRole('img',{name:'ref.png'});
 Object.defineProperties(ref,{naturalWidth:{value:1280},naturalHeight:{value:704}});fireEvent.load(ref);
 fireEvent.change(screen.getByLabelText('Seconds'),{target:{value:'2'}});
 expect(screen.getByText('49 frames · 2.00 s')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({recipeId:'video-generation',family:'ltx-2',model:'LTX2/ltx.safetensors',textEncoder:'gemma_3_12B_it_fp8.safetensors',vae:'LTX2/LTX23_video_vae_bf16.safetensors',frames:49,frameRate:24,firstFrame:'ref.png',output:{codec:'Auto',container:'Auto',quality:20},ltx:{textProjection:'ltx-2.3_text_projection_bf16.safetensors',audioVae:'LTX2/LTX23_audio_vae_bf16.safetensors',passes:1}});
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).not.toHaveProperty('imageFormat');
 await waitFor(()=>expect(document.querySelector('.wb-stage video')?.getAttribute('src')).toBe('http://127.0.0.1:7801/view?filename=x_00001.webm&subfolder=video&type=output'));
 expect(screen.queryByRole('tab',{name:'Continuity'})).toBeNull();
});

test.each(['ltx-2','wan','sdxl','minimax-h3'])('Continuity is absent from non-H3-video pipelines (%s)',async family=>{
 const model={category:'diffusion_models',name:'model.safetensors',path:'/m/model.safetensors',size:1,info:null,family};
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(scanModels).mockResolvedValue(family==='ltx-2'?[...ltxModels]:[model]);
 render(<I18nProvider><Workbench onOpenPromptForge={vi.fn()} endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 await act(async()=>{});
 for(const pipeline of family==='ltx-2'||family==='wan'?['t2v','i2v','v2v','ref2v']:['t2i','i2i']){
  fireEvent.change(screen.getByRole('combobox',{name:'Pipeline'}),{target:{value:pipeline}});
  expect(screen.queryByRole('button',{name:'Continuity'})).toBeNull();
  expect(screen.queryByRole('dialog',{name:'Continuity'})).toBeNull();
  expect(document.querySelector('[data-open-prompt-forge]')).toBeNull();
 }
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test('H3 continuity opens outside the dock, preserves edits and restores focus when closed',async()=>{
 localStorage.setItem('deas.pref.studio.dock.tab',JSON.stringify('continuity'));
 localStorage.setItem('deas.pref.studio.run.continuity',JSON.stringify({enabled:true,session:'kept-session',outputMode:'segment',steps:[{id:'one',seconds:5,action:''},{id:'two',seconds:6,action:'turn'}]}));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'MiniMaxH3/h3.safetensors',path:'/m/h3.safetensors',size:1,info:null,family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/t.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors',path:'/m/v.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors',path:'/m/a.safetensors',size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Text → Video').disabled).toBe(false));choosePipe('Text → Video');
 expect(screen.queryByRole('tab',{name:'Continuity'})).toBeNull();
 expect(screen.getByRole('tab',{name:'Media'}).getAttribute('aria-selected')).toBe('true');
 const open=screen.getByRole('button',{name:'Continuity'});open.focus();fireEvent.click(open);
 const dialog=screen.getByRole('dialog',{name:'Continuity'});
 expect(within(dialog).getByText('kept-session')).toBeTruthy();
 fireEvent.change(within(dialog).getByLabelText('Next action'),{target:{value:'a new action'}});
 fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));
 expect(screen.queryByRole('dialog',{name:'Continuity'})).toBeNull();expect(document.activeElement).toBe(open);
 fireEvent.click(open);
 expect((within(screen.getByRole('dialog',{name:'Continuity'})).getByLabelText('Next action') as HTMLTextAreaElement).value).toBe('a new action');
 fireEvent(screen.getByRole('dialog',{name:'Continuity'}),new Event('cancel',{cancelable:true}));
 expect(screen.queryByRole('dialog',{name:'Continuity'})).toBeNull();expect(document.activeElement).toBe(open);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('H3 frame people are opt-in, reach the Forge and reset on a new source picture',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'MiniMaxH3/h3.safetensors',path:'/m/h3.safetensors',size:1,info:null,family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/t.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors',path:'/m/v.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors',path:'/m/a.safetensors',size:1,info:null}]);
 const calls:{route:string;body:Record<string,unknown>}[]=[];
 vi.mocked(invoke).mockImplementation(async(c,a)=>{
  if(c==='native_llm_read')return {provider:'ollama',baseUrl:'http://127.0.0.1:11434'};
  if(c==='native_forge'){const x=a as {route:string;body:Record<string,unknown>};calls.push(x);return x.route==='models'?{models:[{id:'m',label:'M'}],errors:{},creativity:['balanced'],shot_counts:['Auto'],default_shots:'Auto'}:{simple_prompt:'a scene',warnings:[]};}
  return {path:(a as {path:string})?.path,parent:'/env',entries:['first.png','other.png'].map(name=>({name,path:`/env/ComfyUI/input/${name}`,kind:'file',symlink:false,media:'image',size:1,modified:1})),truncated:false};
 });
 function Workspace(){
  const [host,setHost]=useState<HTMLDivElement|null>(null),[tab,setTab]=useState('generate');
  return <><button onClick={()=>setTab('generate')}>Return to Generate</button><button onClick={()=>setTab('forge')}>Return to Forge</button>
   <div hidden={tab!=='generate'}><Workbench forgeHost={host} onOpenPromptForge={()=>setTab('forge')} endpoint="http://127.0.0.1:7801" root="/env" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></div>
   <div ref={setHost} hidden={tab!=='forge'}/></>;
 }
 render(<I18nProvider><Workspace/></I18nProvider>);
 expect(document.querySelector('[data-open-prompt-forge]')).toBeNull();
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'first.png'}));adopt();
 await waitFor(()=>expect(pipe('Image → Video').disabled).toBe(false));choosePipe('Image → Video');fireEvent.click(menuOf('first.png').getByRole('menuitem',{name:'Use as first frame'}));
 expect(document.querySelector('.wb-settings [data-ref-people]')).toBeNull();
 // The prompt's Forge link keeps the hammer (colour-inverted), not an arrow.
 expect(document.querySelector('.forge-hammer.forge-link svg')).toBeTruthy();
 fireEvent.click(document.querySelector('[data-open-prompt-forge]')!);
 expect(document.querySelector('[data-h3-forge-tab]')).toBeTruthy();
 expect(screen.queryByRole('dialog',{name:'Prompt Forge'})).toBeNull();
 // People & order is an always-open section in the Forge tab, not a collapsed menu.
 expect(document.querySelector('[data-h3-forge-tab] details[data-ref-people]')).toBeNull();
 expect(screen.getByRole('region',{name:/^People & order · .*first\.png$/})).toBeTruthy();
 const people=screen.getByRole('button',{name:'Character 2 in first.png'});
 expect(people.getAttribute('aria-pressed')).toBe('false');
 fireEvent.click(people);
 fireEvent.change(screen.getByRole('combobox',{name:'Character order in first.png'}),{target:{value:'y'}});
 expect(people.getAttribute('aria-pressed')).toBe('true');
 fireEvent.click(people);expect(people.getAttribute('aria-pressed')).toBe('false');
 fireEvent.click(people);
 await screen.findAllByRole('option',{name:'M'});
 fireEvent.change(screen.getByRole('textbox',{name:'Card of Character 2'}),{target:{value:'adult traveller, blue coat'}});
 fireEvent.change(screen.getByRole('textbox',{name:'Idea or prompt to enhance'}),{target:{value:'a walk'}});
 fireEvent.click(screen.getByRole('button',{name:'Write'}));
 await screen.findByRole('textbox',{name:'Result'});
 expect(calls.find(c=>c.route==='h3')!.body).toMatchObject({mode:'I2VA',easy:false,references:[{path:'first.png',who:[2],who_axis:'y'}],cast:{2:'adult traveller, blue coat'}});
 fireEvent.click(screen.getByRole('button',{name:'Apply'}));
 fireEvent.click(screen.getByRole('button',{name:'Return to Generate'}));
 expect(screen.getByRole('textbox',{name:'Prompt'})).toHaveProperty('value','a scene');
 fireEvent.click(screen.getByRole('button',{name:'Return to Forge'}));
 expect(screen.getByRole('textbox',{name:'Card of Character 2'})).toHaveProperty('value','adult traveller, blue coat');
 expect(screen.getByRole('textbox',{name:'Result'})).toHaveProperty('value','a scene');
 expect(document.querySelector('[data-forge-draft="1"]')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Return to Generate'}));
 fireEvent.click(screen.getByRole('button',{name:'other.png'}));adopt();
 fireEvent.click(document.querySelector('[data-open-prompt-forge]')!);
 expect(screen.getByRole('button',{name:'Character 2 in other.png'}).getAttribute('aria-pressed')).toBe('false');
 fireEvent.click(screen.getByRole('button',{name:'Return to Generate'}));
 choosePipe('Multi-reference → Video');dock('References');fireEvent.click(document.querySelector('[data-video-role-remove="first"]')!);dock('Media');
 fireEvent.click(menuOf('first.png').getByRole('menuitem',{name:'Add as reference'}));
 fireEvent.click(document.querySelector('[data-open-prompt-forge]')!);
 fireEvent.click(screen.getByRole('button',{name:'Character 2 in first.png'}));
 fireEvent.change(screen.getByRole('combobox',{name:'Character order in first.png'}),{target:{value:'z'}});
 fireEvent.click(screen.getByRole('button',{name:'Regenerate'}));
 await waitFor(()=>expect(calls.filter(c=>c.route==='h3')).toHaveLength(2));
 expect(calls.filter(c=>c.route==='h3')[1].body).toMatchObject({mode:'REF2VA',references:[{path:'first.png',who:[1,2],who_axis:'z'}]});
 fireEvent.click(screen.getByRole('button',{name:'Return to Generate'}));
 fireEvent.click(document.querySelector('[data-open-references]')!);
 fireEvent.click(within(screen.getByRole('dialog',{name:'References'})).getByRole('button',{name:'Edit first.png'}));
 expect(within(screen.getByRole('dialog',{name:'Edit first.png'})).getByRole('combobox',{name:'Character order in first.png'})).toHaveProperty('value','z');
});
