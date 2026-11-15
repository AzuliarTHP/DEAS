import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { MediaPanel } from '../media/MediaPanel';
import type { MediaSort } from '../media/MediaLibrary';
import { I18nProvider } from '../../i18n/I18nProvider';
import { ReferencesOverlay } from './ReferencesOverlay';
import { ReferencesPanel } from './ReferencesPanel';
vi.mock('@tauri-apps/api/core',()=>({isTauri:vi.fn(()=>false),invoke:vi.fn(),convertFileSrc:(p:string)=>`asset://localhost/${p}`}));
vi.mock('@tauri-apps/api/webview',()=>({getCurrentWebview:()=>({onDragDropEvent:async()=>()=>{}})}));
const methods=Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype);
beforeEach(()=>{
 vi.mocked(isTauri).mockReturnValue(false);
 localStorage.setItem('deas.locale.v1','en');
 Object.defineProperties(HTMLDialogElement.prototype,{
  showModal:{configurable:true,value:function(){this.open=true;}},
  close:{configurable:true,value:function(){this.open=false;}}
 });
});
afterEach(()=>{
 cleanup();
 for(const name of ['showModal','close'])if(methods[name])Object.defineProperty(HTMLDialogElement.prototype,name,methods[name]);else Reflect.deleteProperty(HTMLDialogElement.prototype,name);
});
test.each(['button','cancel'])('References opens a named modal, hosts selection and editing, and closes via %s',method=>{
 const onClose=vi.fn(),onChange=vi.fn();
 const {unmount}=render(<StrictMode><I18nProvider><ReferencesOverlay onClose={onClose} picker={<button>{'Pick fixture'}</button>}><ReferencesPanel family="ltx-2" seconds={5} refs={[]} label={()=>''} onChange={onChange} onAdd={vi.fn()} onInsert={vi.fn()}/></ReferencesOverlay></I18nProvider></StrictMode>);
 const dialog=screen.getByRole('dialog',{name:'References'}) as HTMLDialogElement;
 expect(dialog.open).toBe(true);expect(screen.getByRole('button',{name:'Pick fixture'})).toBeTruthy();
 expect(document.activeElement).toBe(screen.getByRole('button',{name:'Close'}));
 expect(document.querySelector('[data-references]')).toBeTruthy();
 if(method==='button')fireEvent.click(screen.getByRole('button',{name:'Close'}));else{
  const event=new Event('cancel',{cancelable:true});fireEvent(dialog,event);expect(event.defaultPrevented).toBe(true);
 }
 expect(dialog.open).toBe(false);expect(onClose).toHaveBeenCalledTimes(1);expect(onChange).not.toHaveBeenCalled();
 unmount();expect(onClose).toHaveBeenCalledTimes(1);
});

test('H3 overview is compact; nested edit keeps changes, identity and outer modal on Escape',()=>{
 const outerClose=vi.fn();
 function Harness(){
  const [refs,setRefs]=useState<import('./ReferencesPanel').VideoRef[]>([
   {item:{name:'clip.mp4',path:'/in/clip.mp4',src:'asset://clip.mp4',media:'video'},second:0,strength:1,mediaMode:'video',trimStart:1,trimEnd:4},
   {item:{name:'other.png',src:'asset://other.png',media:'image'},second:0,strength:1,mediaMode:'video',instructions:'keep me'}
  ]);
  return <ReferencesOverlay onClose={outerClose} picker={<button>{'Picker'}</button>}><ReferencesPanel refs={refs} onChange={setRefs} family="minimax-h3" seconds={5} label={(_,i)=>String(i+1)} onAdd={vi.fn()} onInsert={vi.fn()}/></ReferencesOverlay>;
 }
 const pause=vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
 render(<I18nProvider><Harness/></I18nProvider>);
 expect(document.querySelectorAll('.reference-thumb')).toHaveLength(2);
 expect(document.querySelector('.reference-media')).toBeNull();
 const edit=screen.getByRole('button',{name:'Edit clip.mp4'});edit.focus();fireEvent.click(edit);
 const inner=screen.getByRole('dialog',{name:'Edit clip.mp4'});
 expect(document.querySelectorAll('.reference-media')).toHaveLength(1);
 fireEvent.change(screen.getByLabelText('Start of clip.mp4'),{target:{value:'2'}});
 fireEvent.change(screen.getByLabelText('Use of clip.mp4'),{target:{value:'audio'}});
 expect(screen.getByRole('dialog',{name:'Edit clip.mp4'})).toBe(inner);
 expect(screen.getByLabelText('Start of clip.mp4')).toHaveProperty('value','2');
 const event=new Event('cancel',{cancelable:true,bubbles:true});fireEvent(inner,event);
 expect(outerClose).not.toHaveBeenCalled();expect(screen.getByRole('dialog',{name:'References'})).toHaveProperty('open',true);
 expect(document.querySelector('.reference-media')).toBeNull();expect(pause).toHaveBeenCalled();
 expect(document.activeElement).toBe(screen.getByRole('button',{name:'Edit clip.mp4'}));
 expect(document.querySelector('[data-ref="other.png"]')!.textContent).toContain('keep me');
 expect(document.querySelector('[data-ref="clip.mp4"]')!.textContent).toContain('2.00');
 fireEvent.click(screen.getByRole('button',{name:'Edit clip.mp4'}));
 expect(screen.getByLabelText('Start of clip.mp4')).toHaveProperty('value','2');
 expect(screen.getByLabelText('End of clip.mp4')).toHaveProperty('value','4');
 expect(screen.getByLabelText('Use of clip.mp4')).toHaveProperty('value','audio');
 pause.mockRestore();
});

test('image mode hosts any editor beside the picker and keeps the shared modal contract',()=>{
 const onClose=vi.fn();
 render(<I18nProvider><ReferencesOverlay onClose={onClose} picker={<button>{'Picker'}</button>}><div data-image-references>{'bar'}</div></ReferencesOverlay></I18nProvider>);
 const dialog=screen.getByRole('dialog',{name:'References'}) as HTMLDialogElement;
 expect(dialog.querySelector('[data-image-references]')).toBeTruthy();expect(document.querySelector('[data-references]')).toBeNull();
 const event=new Event('cancel',{cancelable:true});fireEvent(dialog,event);
 expect(dialog.open).toBe(false);expect(onClose).toHaveBeenCalledTimes(1);
});

test('an open picker refreshes and re-sorts generated images without resetting selection, reference trims or the editor',async()=>{
 vi.mocked(isTauri).mockReturnValue(true);
 let generated=false;
 const output='/overlay-refresh/output',path=output+'/raw',onSelect=vi.fn(),onClose=vi.fn();
 vi.mocked(invoke).mockImplementation(async(command,args)=>{
  if(command==='native_media_thumbnail')return (args as {path:string}).path;
  if(command==='native_media_reference_thumbnail')return '/cache/clip.png';
  if(command==='native_media_star_status')return {starred:false,unavailable:'Fixture'};
  const folder=(args as {path:string}).path;
  return {path:folder,parent:null,truncated:false,entries:folder===path?[
   {name:'a.png',path:path+'/a.png',kind:'file',media:'image',size:1,modified:1},
   {name:'z.png',path:path+'/z.png',kind:'file',media:'image',size:2,modified:generated?3:2},
   ...(generated?[{name:'new.png',path:path+'/new.png',kind:'file',media:'image',size:3,modified:4}]:[])
  ]:[]};
 });
 const pause=vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
 function Harness({revision=0}:{revision?:number}){
  const [sort,setSort]=useState<MediaSort>('name');
  const [refs,setRefs]=useState<import('./ReferencesPanel').VideoRef[]>([{item:{name:'clip.mp4',path:'/in/clip.mp4',src:'asset://clip',media:'video'},second:0,strength:1,mediaMode:'video',trimStart:1,trimEnd:4}]);
  return <ReferencesOverlay onClose={onClose} picker={<MediaPanel roots={{output}} outputRevision={revision} selected={{name:'z.png',path:path+'/z.png',src:'asset://selected',media:'image'}} onSelect={onSelect} controls={{query:'',onQuery:vi.fn(),sort,onSort:setSort,view:'tiles',onView:vi.fn()}}/>}><ReferencesPanel refs={refs} onChange={setRefs} family="minimax-h3" seconds={5} label={(_,i)=>String(i+1)} onAdd={vi.fn()} onInsert={vi.fn()}/></ReferencesOverlay>;
 }
 const ui=render(<I18nProvider><Harness/></I18nProvider>);
 const dialog=screen.getByRole('dialog',{name:'References'}),picker=within(dialog);
 const tile=await picker.findByRole('button',{name:'z.png'});
 await waitFor(()=>expect(tile.querySelector('img')).not.toBeNull());
 const src=tile.querySelector('img')!.getAttribute('src');
 fireEvent.click(picker.getByRole('button',{name:'Edit clip.mp4'}));
 const editor=screen.getByRole('dialog',{name:'Edit clip.mp4'});
 fireEvent.change(screen.getByLabelText('Start of clip.mp4'),{target:{value:'2'}});
 fireEvent.change(picker.getByRole('combobox',{name:'Sort'}),{target:{value:'date'}});
 generated=true;ui.rerender(<I18nProvider><Harness revision={1}/></I18nProvider>);
 await picker.findByRole('button',{name:'new.png'});
 const names=()=>within(picker.getByRole('list',{name:'Folder contents'})).getAllByRole('button').filter(b=>b.hasAttribute('data-media')).map(b=>b.title);
 expect(names()).toEqual(['new.png','z.png','a.png']);
 await waitFor(()=>expect(tile.querySelector('img')?.getAttribute('src')).not.toBe(src));
 expect(tile.getAttribute('aria-current')).toBe('true');
 expect(screen.getByRole('dialog',{name:'Edit clip.mp4'})).toBe(editor);
 expect(screen.getByLabelText('Start of clip.mp4')).toHaveProperty('value','2');
 expect(screen.getByLabelText('End of clip.mp4')).toHaveProperty('value','4');
 expect(onSelect).not.toHaveBeenCalled();expect(onClose).not.toHaveBeenCalled();
 ui.unmount();pause.mockRestore();
});
