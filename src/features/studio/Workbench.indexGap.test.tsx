import { dock, evidence } from './Workbench.testHarness';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { Workbench } from './Workbench';
import { I18nProvider } from '../../i18n/I18nProvider';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels } from '../../lib/models';
import { backendIndexGap } from '../../lib/modelLibrary';

test('backend names missing from the index form one stable key across path separators and folders',()=>{
 const models=[{category:'checkpoints',name:'Illustrious/a.safetensors'},{category:'unet',name:'wan/high.safetensors'},{category:'loras',name:'style.safetensors'}];
 expect(backendIndexGap(models,{checkpoints:['Illustrious\\a.safetensors'],loras:['style.safetensors'],diffusionModels:['wan\\high.safetensors']})).toBe('');
 expect(backendIndexGap(models,{checkpoints:['Illustrious\\B.safetensors','Illustrious\\a.safetensors'],loras:['new.safetensors']})).toBe('illustrious/b.safetensors\nnew.safetensors');
 // A LoRA file is not a checkpoint just because the name matches.
 expect(backendIndexGap([{category:'loras',name:'x.safetensors'}],{checkpoints:['x.safetensors']})).toBe('x.safetensors');
});

test('hand-placed files the backend lists are announced next to Reload without an implicit rescan',async()=>{
 const listed={category:'checkpoints',name:'sdxl/base.safetensors',path:'/m/checkpoints/sdxl/base.safetensors',size:1,info:null};
 vi.mocked(scanModels).mockResolvedValue([listed]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,checkpoints:['sdxl\\base.safetensors','Illustrious\\new.safetensors'],loras:[]}});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 dock('Models');
 await waitFor(()=>expect(document.querySelector('[data-index-gap]')?.getAttribute('data-index-gap')).toBe('1'));
 const reload=document.querySelector<HTMLButtonElement>('[data-run-load]')!;
 expect(reload.getAttribute('aria-describedby')).toBe('studio-index-gap');
 expect(document.getElementById('studio-index-gap')?.textContent).toContain('1 model file');
 expect(scanModels).toHaveBeenCalledTimes(1);
 vi.mocked(scanModels).mockResolvedValue([listed,{...listed,name:'Illustrious/new.safetensors',path:'/m/checkpoints/Illustrious/new.safetensors'}]);
 fireEvent.click(reload);
 await waitFor(()=>expect(document.querySelector('[data-index-gap]')).toBeNull());
 expect(scanModels).toHaveBeenLastCalledWith('/m',[],true);
 expect(reload.hasAttribute('aria-describedby')).toBe(false);
});
