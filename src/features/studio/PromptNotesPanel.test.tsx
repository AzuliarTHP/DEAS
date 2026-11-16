import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { PromptNotesPanel,validNotebook } from './PromptNotesPanel';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>{}),isTauri:()=>true}));
const mount=()=>render(<I18nProvider><PromptNotesPanel/></I18nProvider>);
const fill=(label:string,value:string)=>fireEvent.change(screen.getByLabelText(label),{target:{value}});
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name}));
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.locale.v1','en');vi.mocked(invoke).mockClear();Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value(this:HTMLDialogElement){this.open=true;}});});afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('creates nested folders and manually saves prompts/seed across restart; confirmed folder deletion includes descendants',()=>{
 const view=mount();fill('Folder name','Characters');click('New folder');fill('Folder name','Anima');click('New folder');
 fill('Note name','Portrait');fill('Note positive prompt','warm light');fill('Note negative prompt','blur');fill('Note seed','123456');
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.promptNotebook')!).notes).toHaveLength(0);
 click('Save note');const data=JSON.parse(localStorage.getItem('deas.pref.studio.promptNotebook')!);expect(data.folders).toHaveLength(2);expect(data.notes[0]).toMatchObject({title:'Portrait',positive:'warm light',negative:'blur',seed:123456,folder:data.folders[1].id});
 view.unmount();mount();click('Portrait');expect(screen.getByLabelText('Note positive prompt')).toHaveProperty('value','warm light');expect(screen.getByLabelText('Note seed')).toHaveProperty('value','123456');
 click('Characters');click('Delete folder');fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(screen.getByRole('button',{name:'Characters'})).toBeTruthy();
 click('Delete folder');fireEvent.click(document.querySelector('[data-confirm-dialog]')!);expect(JSON.parse(localStorage.getItem('deas.pref.studio.promptNotebook')!)).toEqual({folders:[],notes:[]});expect(invoke).not.toHaveBeenCalled();
});
it('guards unsaved drafts and rejects invalid seed values',()=>{
 mount();fill('Note name','Draft');fill('Note seed','NaN');expect(screen.getByRole('button',{name:'Save note'})).toHaveProperty('disabled',true);expect(screen.getByRole('button',{name:'New note'})).toHaveProperty('disabled',true);
 fill('Note seed','9007199254740992');expect(screen.getByRole('button',{name:'Save note'})).toHaveProperty('disabled',true);click('Discard changes');expect(screen.getByLabelText('Note name')).toHaveProperty('value','');
});
it('retains the draft and reports a fixed diagnostic if profile storage fails',()=>{
 mount();fill('Note name','Keep me');fill('Note positive prompt','private prompt');const fail=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('quota');});click('Save note');
 expect(screen.getByRole('alert').textContent).toContain('Could not save notes');expect(screen.getByLabelText('Note positive prompt')).toHaveProperty('value','private prompt');expect(invoke).toHaveBeenCalledWith('native_logs_prompt_notes_error');
 expect(screen.getByRole('button',{name:'New note'})).toHaveProperty('disabled',true);expect(localStorage.getItem('deas.pref.studio.promptNotebook')).toBeNull();
 fail.mockRestore();click('Save note');expect(JSON.parse(localStorage.getItem('deas.pref.studio.promptNotebook')!).notes[0].positive).toBe('private prompt');
});
it('rejects folder cycles, dangling notes and unsafe seeds',()=>{
 expect(validNotebook({folders:[{id:'a',parent:'a',name:'A'}],notes:[]})).toBe(false);
 expect(validNotebook({folders:[],notes:[{id:'n',folder:'missing',title:'N',positive:'',negative:'',seed:0}]})).toBe(false);
 expect(validNotebook({folders:[],notes:[{id:'n',folder:'',title:'N',positive:'',negative:'',seed:Infinity}]})).toBe(false);
});

it('renames a folder, updates a note, moves it to root and deletes only after confirmation',()=>{
 mount();fill('Folder name','Old');click('New folder');fill('Folder name','New');click('Rename folder');
 fill('Note name','First');fill('Note positive prompt','one');click('Save note');fill('Note positive prompt','two');fill('Note folder','');click('Save note');
 const data=JSON.parse(localStorage.getItem('deas.pref.studio.promptNotebook')!);expect(data.folders[0].name).toBe('New');expect(data.notes[0]).toMatchObject({folder:'',positive:'two'});
 click('Delete note');fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(JSON.parse(localStorage.getItem('deas.pref.studio.promptNotebook')!).notes).toHaveLength(1);
 click('Delete note');fireEvent.click(document.querySelector('[data-confirm-dialog]')!);expect(JSON.parse(localStorage.getItem('deas.pref.studio.promptNotebook')!).notes).toHaveLength(0);
});
it('keeps folders and folder-specific notes in separate panes with New beside Delete and Seed beside Name',()=>{
 const view=mount();fill('Folder name','First');click('New folder');fill('Note name','First note');click('Save note');click('All notes');
 fill('Folder name','Second');click('New folder');fill('Note name','Second note');click('Save note');
 const folders=view.container.querySelector('.prompt-note-folders')!,notes=view.container.querySelector('.prompt-note-browser')!;
 const toolbar=folders.querySelector('.prompt-note-folder-toolbar')!;
 expect([...toolbar.querySelectorAll('button')].map(button=>button.getAttribute('aria-label')??button.textContent)).toEqual(['All notes','New folder','Rename folder','Delete folder']);
 expect(folders.querySelector('.prompt-note-list')).toBeNull();expect(notes.textContent).toContain('Second note');expect(notes.textContent).not.toContain('First note');
 click('First');expect(notes.textContent).toContain('First note');expect(notes.textContent).not.toContain('Second note');
 expect(screen.getByRole('button',{name:'Delete note'}).nextElementSibling).toBe(screen.getByRole('button',{name:'New note'}));
 expect([...view.container.querySelectorAll('.prompt-note-fields>label')].map(label=>label.firstChild?.textContent)).toEqual(['Note name','Note seed','Note folder']);
});
