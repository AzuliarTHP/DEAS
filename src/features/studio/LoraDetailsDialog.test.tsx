import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { LoraDetailsDialog } from './LoraDetailsDialog';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn().mockResolvedValue(undefined),isTauri:()=>true}));
const model={category:'loras',name:'style.safetensors',path:'/fixture/style.safetensors',size:1,info:{sha256:'',size:1,fetchedAt:1,civitai:{modelId:1,versionId:1,name:'Style',version:'v1',modelType:'LORA',category:'loras',nsfw:false,trainedWords:['league of legends, official art','warm light\nsoft shading','official art']}}};
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.locale.v1','en');Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value(this:HTMLDialogElement){this.open=true;}});Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value(this:HTMLDialogElement){this.open=false;}});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:vi.fn().mockResolvedValue(undefined)}});vi.mocked(invoke).mockClear();});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('selects individual comma/newline-separated phrases and copies only selected words in metadata order',async()=>{
 render(<I18nProvider><LoraDetailsDialog model={model} onClose={()=>{}}/></I18nProvider>);
 expect(screen.getByRole('button',{name:'Copy selected (0)'})).toHaveProperty('disabled',true);
 fireEvent.click(screen.getByRole('button',{name:'soft shading'}));fireEvent.click(screen.getByRole('button',{name:'official art'}));
 expect(screen.getAllByRole('button',{name:'official art'})).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:'Copy selected (2)'}));
 await waitFor(()=>expect(navigator.clipboard.writeText).toHaveBeenCalledWith('official art, soft shading'));
 fireEvent.click(screen.getByRole('button',{name:'official art'}));expect(screen.getByRole('button',{name:'official art'}).getAttribute('aria-pressed')).toBe('false');
 fireEvent.click(screen.getByRole('button',{name:'Copy all'}));await waitFor(()=>expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(model.info.civitai.trainedWords.join(', ')));
});
it('retains the selection after clipboard refusal and logs only the fixed operation',async()=>{
 vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'));
 render(<I18nProvider><LoraDetailsDialog model={model} onClose={()=>{}}/></I18nProvider>);fireEvent.click(screen.getByRole('button',{name:'warm light'}));fireEvent.click(screen.getByRole('button',{name:'Copy selected (1)'}));
 await screen.findByRole('alert');expect(screen.getByRole('button',{name:'warm light'}).getAttribute('aria-pressed')).toBe('true');expect(invoke).toHaveBeenCalledWith('native_logs_library_error',{operation:'clipboard'});expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toContain('warm light');
});
