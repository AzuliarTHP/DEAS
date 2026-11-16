import { dock, evidence, h3VideoFiles, heldJob, videoEvidence } from './Workbench.testHarness';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { Workbench } from './Workbench';
import { I18nProvider } from '../../i18n/I18nProvider';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels } from '../../lib/models';
import { runWorkbenchJob } from '../../lib/jobs';
import { applyStudioSettings, captureStudioSettings } from '../../lib/preferences';
import { defaultTve } from './TvePostControls';
import { revealTarget, searchIndex } from '../../lib/search';

const upscaler='minimax_h3_latent_upscaler.safetensors';
async function mount(saved?:boolean,node=true){
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 localStorage.setItem('deas.pref.studio.run.latent.h3',JSON.stringify({enabled:true,model:upscaler,scale:2,steps:1,denoise:0.2}));
 if(saved!==undefined)localStorage.setItem('deas.pref.studio.run.streamDecode',JSON.stringify(saved));
 vi.mocked(scanModels).mockResolvedValue(h3VideoFiles());
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'DEAS_VideoPostprocessGate','DaSiWaH3TiledUpscale',...(node?['DEAS_H3StreamVideoSave']:[])],h3LatentUpscaleModels:[upscaler]}});
 vi.mocked(runWorkbenchJob).mockResolvedValue(heldJob('stream','failed',evidence.baseUrl));
 const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
 const view=render(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-plan-intent]')?.textContent).toContain('video-generation'));
 const intent=JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!);
 if(saved===true)expect(intent.streamDecode).toBe(true);else expect(intent).not.toHaveProperty('streamDecode');
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);dock('Post-Processing');
 return view;
}

test.each([undefined,false,true])('H3 streaming restores %s, captures settings and emits only explicit true',async saved=>{
 await mount(saved);
 const toggle=document.querySelector<HTMLInputElement>('[data-stream-decode]');
 expect(toggle).not.toBeNull();
 expect(toggle!.checked).toBe(saved===true);
 expect(captureStudioSettings()['studio.run.streamDecode']).toBe(saved===true);
 act(()=>{expect(applyStudioSettings({'studio.run.streamDecode':true})).toBe(true);});
 expect(toggle!.checked).toBe(true);
 expect(document.querySelector('[data-post-card="latent"]')?.getAttribute('data-post-count')).toBe('2');
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 fireEvent.click(toggle!);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({streamDecode:true,latentUpscale:{model:upscaler}});
});

test('streaming stays explicit when a full-IMAGE option is enabled and search reveals its existing category',async()=>{
 await mount(true);
 const entry=searchIndex.find(e=>e.target==='[data-stream-decode]')!;
 expect(entry.dockTab).toBe('post');
 fireEvent.click(document.querySelector('[data-post-card="latent"]')!);
 expect(revealTarget(entry.target).state).toBe('revealed');
 expect(document.querySelector<HTMLInputElement>('[data-stream-decode]')!.checked).toBe(true);
 act(()=>{expect(applyStudioSettings({'studio.run.tve':{...defaultTve,denoise:true}})).toBe(true);});
 expect(document.querySelector('[data-stream-decode]')).toHaveProperty('checked',true);
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(document.body.textContent).toContain('whole IMAGE batch');
 fireEvent.click(document.querySelector('[data-stream-decode]')!);
 expect(captureStudioSettings()['studio.run.streamDecode']).toBe(false);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('default-off streaming is omitted from the submitted intent',async()=>{
 await mount();
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).not.toHaveProperty('streamDecode');
});

test('saved explicit streaming cannot silently fall back when its capability is unavailable',async()=>{
 await mount(true,false);
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',true);
 expect(document.body.textContent).toContain('DEAS_H3StreamVideoSave');
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});
