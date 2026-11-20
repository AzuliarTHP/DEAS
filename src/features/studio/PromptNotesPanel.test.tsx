import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { PromptNotesPanel,validNotebook } from './PromptNotesPanel';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>{}),isTauri:()=>true}));
const mount=()=>render(<I18nProvider><PromptNotesPanel/></I18nProvider>);
const fill=(label:string,value:string)=>fireEvent.change(screen.getByLabelText(label),{target:{value}});
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name}));
const nameFolder=(action:string,name:string)=>{click(action);fill('Folder name',name);click('Confirm');};
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.locale.v1','en');vi.mocked(invoke).mockClear();Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value(this:HTMLDialogElement){this.open=true;}});});afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('creates nested folders and manually saves prompts/seed across restart; confirmed folder deletion includes descendants',()=>{
 const view=mount();nameFolder('New folder','Characters');nameFolder('New folder','Anima');
 expect(screen.getByText('Note folder · Characters / Anima')).toBeTruthy();
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

it('renames a folder and confirms note overwrites and deletions',()=>{
 mount();nameFolder('New folder','Old');nameFolder('Rename folder','New');
 fill('Note name','First');fill('Note positive prompt','one');click('Save note');
 expect(screen.queryByRole('dialog')).toBeNull();
 fill('Note name',' First ');fill('Note positive prompt','two');click('Save note');
 expect(screen.getByRole('dialog').textContent).toContain('Overwrite note “First”?');
 expect(document.activeElement).toBe(screen.getByRole('button',{name:'Cancel'}));
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.promptNotebook')!).notes[0]).toMatchObject({title:'First',positive:'one'});
 click('Cancel');
 expect(screen.queryByRole('dialog')).toBeNull();
 expect(screen.getByLabelText('Note positive prompt')).toHaveProperty('value','two');
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.promptNotebook')!).notes[0]).toMatchObject({title:'First',positive:'one'});
 click('Save note');fireEvent.click(document.querySelector('[data-confirm-dialog]')!);
 const data=JSON.parse(localStorage.getItem('deas.pref.studio.promptNotebook')!);expect(data.folders[0].name).toBe('New');expect(data.notes).toHaveLength(1);expect(data.notes[0]).toMatchObject({title:'First',folder:data.folders[0].id,positive:'two'});
 click('Delete note');fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(JSON.parse(localStorage.getItem('deas.pref.studio.promptNotebook')!).notes).toHaveLength(1);
 click('Delete note');fireEvent.click(document.querySelector('[data-confirm-dialog]')!);expect(JSON.parse(localStorage.getItem('deas.pref.studio.promptNotebook')!).notes).toHaveLength(0);
});
it('saves a renamed draft as a separate note and keeps the original after reopening',()=>{
 const view=mount();
 fill('Note name','Original');fill('Note positive prompt','one');click('Save note');
 fill('Note name','A new name');fill('Note positive prompt','two');click('Save note');
 expect(screen.queryByRole('dialog')).toBeNull();
 expect(screen.getByRole('button',{name:'A new name'}).getAttribute('aria-pressed')).toBe('true');
 const {notes}=JSON.parse(localStorage.getItem('deas.pref.studio.promptNotebook')!);
 expect(notes).toMatchObject([{title:'Original',positive:'one'},{title:'A new name',positive:'two'}]);
 expect(notes[0].id).not.toBe(notes[1].id);
 view.unmount();mount();
 click('Original');expect(screen.getByLabelText('Note positive prompt')).toHaveProperty('value','one');
 click('A new name');expect(screen.getByLabelText('Note positive prompt')).toHaveProperty('value','two');
});
it('keeps folders and folder-specific notes in separate panes with New beside Delete and Seed beside Name',()=>{
 const view=mount();nameFolder('New folder','First');fill('Note name','First note');click('Save note');click('All notes');
 nameFolder('New folder','Second');fill('Note name','Second note');click('Save note');
 const folders=view.container.querySelector('.prompt-note-folders')!,notes=view.container.querySelector('.prompt-note-browser')!;
 const toolbar=folders.querySelector('.prompt-note-folder-toolbar')!;
 expect([...toolbar.querySelectorAll('button')].map(button=>button.getAttribute('aria-label')??button.textContent)).toEqual(['All notes','New folder','Rename folder','Delete folder']);
 expect(folders.querySelector('.prompt-note-list')).toBeNull();expect(notes.textContent).toContain('Second note');expect(notes.textContent).not.toContain('First note');
 click('First');expect(notes.textContent).toContain('First note');expect(notes.textContent).not.toContain('Second note');
 expect(screen.getByText('Note folder · First')).toBeTruthy();
 expect(screen.queryByRole('combobox',{name:'Note folder'})).toBeNull();
 expect(screen.getByRole('button',{name:'Delete note'}).nextElementSibling).toBe(screen.getByRole('button',{name:'New note'}));
 expect([...view.container.querySelectorAll('.prompt-note-fields>label')].map(label=>label.firstChild?.textContent)).toEqual(['Note name','Note seed']);
});
it('opens folder naming only from the toolbar and rejects duplicate sibling names',()=>{
 mount();
 expect(screen.queryByLabelText('Folder name')).toBeNull();
 click('New folder');
 expect(screen.getByRole('dialog',{name:'New folder'})).toBeTruthy();
 expect(screen.getByRole('button',{name:'Confirm'})).toHaveProperty('disabled',true);
 fill('Folder name','Cancelled');click('Cancel');
 expect(screen.queryByRole('button',{name:'Cancelled'})).toBeNull();
 nameFolder('New folder','Styles');click('All notes');
 click('New folder');fill('Folder name',' styles ');
 expect(screen.getByRole('button',{name:'Confirm'})).toHaveProperty('disabled',true);
});
it('persists dragged sibling order, moves a subtree both ways, and blocks cycles',()=>{
 const view=mount();
 nameFolder('New folder','Alpha');nameFolder('New folder','Nested');
 nameFolder('New folder','Child');
 fill('Note name','Kept note');click('Save note');click('All notes');
 nameFolder('New folder','Zulu');
 const roots=()=>[...document.querySelectorAll('.prompt-note-tree > li > .prompt-note-folder > button:last-child')].map(button=>button.textContent);
 const drag=(source:Element,target:Element,y=3)=>{
  const hitTest=Object.getOwnPropertyDescriptor(document,'elementFromPoint');
  const bounds=vi.spyOn(target.closest('.prompt-note-folder')??target,'getBoundingClientRect').mockReturnValue({top:0,height:24} as DOMRect);
  Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>target});
  const pointer=(type:string,x:number,buttons:number)=>Object.assign(new MouseEvent(type,{bubbles:true,clientX:x,clientY:y,buttons}),{
   pointerId:1,isPrimary:true,pointerType:'mouse',
  });
  try{
   fireEvent(source,pointer('pointerdown',0,1));
   fireEvent(target,pointer('pointermove',10,1));
   fireEvent(target,pointer('pointerup',10,0));
  }finally{
   bounds.mockRestore();
   if(hitTest)Object.defineProperty(document,'elementFromPoint',hitTest);
   else Reflect.deleteProperty(document,'elementFromPoint');
  }
 };
 expect(roots()).toEqual(['Alpha','Zulu']);
 drag(screen.getByRole('button',{name:'Zulu'}),screen.getByRole('button',{name:'Alpha'}));
 expect(roots()).toEqual(['Zulu','Alpha']);
 drag(screen.getByRole('button',{name:'Nested'}),screen.getByRole('button',{name:'All notes'}));
 expect(roots()).toEqual(['Zulu','Alpha','Nested']);
 expect(screen.queryByRole('button',{name:'Expand Zulu'})).toBeNull();
 drag(screen.getByRole('button',{name:'Nested'}),screen.getByRole('button',{name:'Zulu'}),12);
 expect(roots()).toEqual(['Zulu','Alpha']);
 expect(screen.getByRole('button',{name:'Collapse Zulu'}).getAttribute('aria-expanded')).toBe('true');
 const beforeCycle=localStorage.getItem('deas.pref.studio.promptNotebook');
 drag(screen.getByRole('button',{name:'Zulu'}),screen.getByRole('button',{name:'Child'}),12);
 expect(localStorage.getItem('deas.pref.studio.promptNotebook')).toBe(beforeCycle);
 view.unmount();mount();
 expect(roots()).toEqual(['Zulu','Alpha']);
 click('Collapse Zulu');expect(screen.queryByRole('button',{name:'Nested'})).toBeNull();
 click('Expand Zulu');
 click('Child');click('Kept note');expect(screen.getByText('Note folder · Zulu / Nested / Child')).toBeTruthy();
});
