import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { readPref, usePref } from '../../lib/preferences';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import './promptNotes.css';
type Folder={id:string;parent:string;name:string};
type Note={id:string;folder:string;title:string;positive:string;negative:string;seed:number};
type Notebook={folders:Folder[];notes:Note[];manualFolderOrder?:true};
type FolderDrop={id:string;edge:'before'|'after'|'inside'|'root'};

function validFolderHierarchy(folders:Folder[]) {
 const parents=new Map(folders.map(folder=>[folder.id,folder.parent]));
 for(const folder of folders){
  const seen=new Set([folder.id]);
  for(let parent=folder.parent;parent;parent=parents.get(parent)!){
   if(!parents.has(parent)||seen.has(parent)||seen.size>8)return false;
   seen.add(parent);
  }
 }
 return true;
}

export function validNotebook(value:unknown):value is Notebook {
 if(!value||typeof value!=='object')return false;const v=value as Notebook;
 if(v.manualFolderOrder!==undefined&&v.manualFolderOrder!==true)return false;
 if(!Array.isArray(v.folders)||v.folders.length>200||!Array.isArray(v.notes)||v.notes.length>500)return false;
 const text=(s:unknown,max:number)=>typeof s==='string'&&s.length<=max;
 if(!v.folders.every(f=>f&&text(f.id,80)&&!!f.id&&text(f.parent,80)&&text(f.name,80)&&!!f.name.trim())||new Set(v.folders.map(f=>f.id)).size!==v.folders.length)return false;
 if(!validFolderHierarchy(v.folders))return false;
 const ids=new Set(v.folders.map(f=>f.id));
 return new Set(v.notes.map(n=>n?.id)).size===v.notes.length&&v.notes.every(n=>n&&text(n.id,80)&&!!n.id&&text(n.folder,80)&&(!n.folder||ids.has(n.folder))&&text(n.title,100)&&!!n.title.trim()&&text(n.positive,16384)&&text(n.negative,16384)&&Number.isSafeInteger(n.seed)&&n.seed>=0);
}
const empty=(folder:string)=>({title:'',positive:'',negative:'',seed:'0',folder});
const sameFolderName=(left:string,right:string)=>left.trim().toLocaleLowerCase()===right.trim().toLocaleLowerCase();

function FolderNameDialog({title,initialName,siblings,storageError,onSave,onClose}:{
 title:string;initialName:string;siblings:Folder[];storageError:boolean;onSave:(name:string)=>void;onClose:()=>void;
}){
 const {t}=useI18n();
 const dialog=useRef<HTMLDialogElement>(null);
 const [name,setName]=useState(initialName);
 const trimmed=name.trim();
 const duplicate=siblings.some(folder=>sameFolderName(folder.name,trimmed));
 const canSave=!!trimmed&&!duplicate;
 useEffect(()=>{dialog.current?.showModal();},[]);
 return <dialog ref={dialog} aria-label={title} className="confirm-dialog prompt-note-name-dialog" onCancel={e=>{e.preventDefault();onClose();}}>
  <form onSubmit={e=>{e.preventDefault();if(canSave)onSave(trimmed);}}>
   <h3>{title}</h3>
   <label>{t('notes.folderName')}<input autoFocus maxLength={80} value={name} aria-invalid={duplicate||undefined} onChange={e=>setName(e.target.value)}/></label>
   {storageError&&<p role="alert">{t('notes.storageError')}</p>}
   <div className="confirm-actions">
    <button type="submit" disabled={!canSave}>{t('app.confirm')}</button>
    <button type="button" onClick={onClose}>{t('app.cancel')}</button>
   </div>
  </form>
 </dialog>;
}

type Props = {
 mainPrompts:{positive:string;negative:string};
 onUsePrompts:(positive:string,negative:string)=>void;
};

export function PromptNotesPanel({mainPrompts,onUsePrompts}:Props){
 const {t}=useI18n();const [book,setNotebook]=useState<Notebook>(()=>readPref('studio.promptNotebook',{folders:[],notes:[]},validNotebook));const [storageError,setStorageError]=useState(false);
 const setBook=(change:Notebook|((old:Notebook)=>Notebook))=>{const next=typeof change==='function'?change(book):change;if(!validNotebook(next))return false;try{localStorage.setItem('deas.pref.studio.promptNotebook',JSON.stringify(next));setNotebook(next);setStorageError(false);return true;}catch{setStorageError(true);if(isTauri())void invoke('native_logs_prompt_notes_error').catch(()=>{});return false;}};
 const [expanded,setExpanded]=usePref<string[]>('studio.promptNotes.expanded',[],(v):v is string[]=>Array.isArray(v)&&v.length<=200&&v.every(id=>typeof id==='string'&&id.length<=80));
 const [folder,setFolder]=useState('');const [id,setId]=useState('');const [draft,setDraft]=useState(empty(''));const [deleting,setDeleting]=useState(false);const [deletingFolder,setDeletingFolder]=useState<Folder|null>(null);
 const [namingFolder,setNamingFolder]=useState<{parent:string;target?:Folder}|null>(null);
 const folderPane=useRef<HTMLElement>(null);
 const dragged=useRef<{folder:Folder;pointer:number;x:number;y:number;started:boolean}|null>(null);
 const [movingFolder,setMovingFolder]=useState('');
 const [dropTarget,setDropTarget]=useState<FolderDrop|null>(null);
 const [pendingOverwrite,setPendingOverwrite]=useState<{note:Note;originalTitle:string}|null>(null);
 const saved=book.notes.find(n=>n.id===id);const baseline=saved?{...saved,seed:String(saved.seed)}:empty(folder);
 const folderPath:string[]=[];
 for(let parent=draft.folder;parent;){
  const entry=book.folders.find(item=>item.id===parent);
  if(!entry)break;
  folderPath.unshift(entry.name);
  parent=entry.parent;
 }
 const folderOptions=book.folders.map(item=>{const path=[item.name];for(let parent=item.parent;parent;){const entry=book.folders.find(row=>row.id===parent);if(!entry)break;path.unshift(entry.name);parent=entry.parent;}return {id:item.id,path:path.join(' / ')};}).sort((a,b)=>a.path.localeCompare(b.path));
 const location=`${t('notes.location')} · ${folderPath.join(' / ')||t('notes.root')}`;
 const dirty=['title','positive','negative','seed','folder'].some(key=>draft[key as keyof typeof draft]!==baseline[key as keyof typeof baseline]);
 const validSeed=/^\d+$/.test(draft.seed)&&Number.isSafeInteger(Number(draft.seed))&&Number(draft.seed)>=0;
 const title=draft.title.trim();
 const overwrite=saved?.title===title?saved:undefined;
 const canSave=!!title&&title.length<=100&&draft.positive.length<=16384&&draft.negative.length<=16384&&(!draft.folder||book.folders.some(f=>f.id===draft.folder))&&validSeed&&(!!overwrite||book.notes.length<500);
 const persistNote=(note:Note,overwrite:boolean)=>{
  if(!setBook(old=>({...old,notes:overwrite?old.notes.map(item=>item.id===note.id?note:item):[...old.notes,note]})))return;
  setId(note.id);
  setDraft({...note,seed:String(note.seed)});
 };
 const saveDraft=()=>{
  if(!canSave)return;
  const note:Note={...draft,id:overwrite?.id??crypto.randomUUID(),title,seed:Number(draft.seed)};
  if(overwrite)setPendingOverwrite({note,originalTitle:overwrite.title});
  else persistNote(note,false);
 };
 const chooseFolder=(value:string)=>{setFolder(value);setId('');setDraft(empty(value));};
 const chooseNote=(note:Note)=>{setId(note.id);setDraft({title:note.title,positive:note.positive,negative:note.negative,folder:note.folder,seed:String(note.seed)});};
 const copyMainPrompts=()=>{
  setDraft(current=>{
   if(current.title.trim()||(!mainPrompts.positive&&!mainPrompts.negative))return {...current,...mainPrompts};
   const names=new Set(book.notes.filter(note=>note.folder===current.folder).map(note=>note.title));
   const untitled=t('notes.untitled');
   let suggestedTitle=untitled;
   for(let suffix=2;names.has(suggestedTitle);suffix++)suggestedTitle=`${untitled} ${suffix}`;
   return {...current,...mainPrompts,title:suggestedTitle};
  });
 };
 const selectedFolder=book.folders.find(item=>item.id===folder);
 const canCreate=!dirty&&book.folders.length<200&&(!folder||folderPath.length<8);
 const orderedFolders=book.manualFolderOrder?book.folders:[...book.folders].sort((a,b)=>a.name.localeCompare(b.name));
 const saveFolderName=(name:string)=>{
  if(!namingFolder)return;
  const {target,parent}=namingFolder;
  const next={id:target?.id??crypto.randomUUID(),parent,name};
  if(!setBook(old=>({...old,folders:target?old.folders.map(item=>item.id===target.id?next:item):[...old.folders,next]})))return;
  setNamingFolder(null);
  if(!target){
   if(parent)setExpanded(old=>[...new Set([...old,parent])]);
   chooseFolder(next.id);
  }
 };
 const endDrag=()=>{
  const pointer=dragged.current?.pointer;
  dragged.current=null;
  setMovingFolder('');
  setDropTarget(null);
  if(pointer!==undefined&&folderPane.current?.hasPointerCapture?.(pointer))folderPane.current.releasePointerCapture(pointer);
 };
 const startDrag=(event:PointerEvent,source:Folder)=>{
  if(dirty||event.button!==0||!event.isPrimary||event.pointerType==='touch')return;
  dragged.current={folder:source,pointer:event.pointerId,x:event.clientX,y:event.clientY,started:false};
 };
 const dropAt=(source:Folder,x:number,y:number):FolderDrop|null=>{
  const hit=document.elementFromPoint(x,y)?.closest<HTMLElement>('[data-note-folder],[data-note-root]');
  if(dirty||!hit||!folderPane.current?.contains(hit))return null;
  if(hit.hasAttribute('data-note-root')){
   return source.parent&&!book.folders.some(item=>!item.parent&&sameFolderName(item.name,source.name))
    ?{id:'',edge:'root'}:null;
  }
  const target=book.folders.find(item=>item.id===hit.dataset.noteFolder);
  if(!target||source.id===target.id)return null;
  if(source.parent===target.parent){
   const {top,height}=hit.getBoundingClientRect();
   if(y<=top+height/4)return {id:target.id,edge:'before'};
   if(y>=top+height*3/4)return {id:target.id,edge:'after'};
  }
  if(source.parent===target.id||book.folders.some(item=>item.parent===target.id&&sameFolderName(item.name,source.name)))return null;
  const reparented=book.folders.map(item=>item.id===source.id?{...item,parent:target.id}:item);
  return validFolderHierarchy(reparented)?{id:target.id,edge:'inside'}:null;
 };
 const moveDrag=(event:PointerEvent<HTMLElement>)=>{
  const drag=dragged.current;
  if(!drag||drag.pointer!==event.pointerId)return;
  if(!(event.buttons&1)){endDrag();return;}
  if(!drag.started){
   if(Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<5)return;
   event.currentTarget.setPointerCapture?.(event.pointerId);
   drag.started=true;
   setMovingFolder(drag.folder.id);
  }
  const target=dropAt(drag.folder,event.clientX,event.clientY);
  setDropTarget(current=>current?.id===target?.id&&current?.edge===target?.edge?current:target);
 };
 const placeFolder=(event:PointerEvent)=>{
  const drag=dragged.current;
  if(!drag||drag.pointer!==event.pointerId)return;
  const target=drag.started?dropAt(drag.folder,event.clientX,event.clientY):null;
  endDrag();
  if(!target)return;
  event.preventDefault();
  const source=drag.folder;
  const next=orderedFolders.filter(item=>item.id!==source.id);
  if(target.edge==='root'){
   next.push({...source,parent:''});
  }else if(target.edge==='inside'){
   next.push({...source,parent:target.id});
  }else{
   const index=next.findIndex(item=>item.id===target.id);
   next.splice(index+(target.edge==='after'?1:0),0,source);
  }
  if(next.every((item,index)=>item===orderedFolders[index]))return;
  if(setBook(old=>({...old,folders:next,manualFolderOrder:true}))&&target.edge==='inside'){
   setExpanded(old=>old.includes(target.id)?old:[...old,target.id]);
  }
 };
 const tree=(parent:string,level:number):React.ReactNode=>orderedFolders.filter(item=>item.parent===parent).map(item=>{
  const hasChildren=orderedFolders.some(child=>child.parent===item.id);
  const open=expanded.includes(item.id);
  return <li key={item.id}>
   <div className="prompt-note-folder" style={{paddingInlineStart:level*10}} data-note-folder={item.id}
    data-folder-drop={dropTarget?.id===item.id?dropTarget.edge:undefined} data-moving={movingFolder===item.id||undefined}>
    {hasChildren?<button type="button" className="prompt-note-folder-toggle" aria-expanded={open}
     aria-label={t(open?'notes.collapse':'notes.expand',{name:item.name})}
     onClick={()=>setExpanded(old=>open?old.filter(id=>id!==item.id):[...old,item.id])}>
     <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
    </button>:<span className="prompt-note-folder-toggle" aria-hidden="true"/>}
    <button type="button" disabled={dirty} aria-pressed={folder===item.id} onPointerDown={e=>startDrag(e,item)} onClick={()=>chooseFolder(item.id)}>{item.name}</button>
   </div>
   {hasChildren&&open&&<ul>{tree(item.id,level+1)}</ul>}
  </li>;
 });
 return <div className="prompt-notebook" onKeyDown={e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();e.stopPropagation();}}}>
  <aside ref={folderPane} className="prompt-note-folders" aria-label={t('notes.folders')}
   onPointerMove={moveDrag} onPointerUp={placeFolder} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
   onPointerLeave={()=>{if(dragged.current&&!dragged.current.started)endDrag();}}>
   <h3>{t('notes.folders')}</h3>
   <div className="prompt-note-folder-toolbar">
    <button type="button" disabled={dirty} aria-pressed={!folder} onClick={()=>chooseFolder('')} data-note-root
     data-folder-drop={dropTarget?.edge==='root'?'root':undefined}>{t('notes.all')}</button>
    <button type="button" disabled={!canCreate} onClick={()=>setNamingFolder({parent:folder})} aria-label={t('notes.newFolder')} title={t('notes.newFolder')}>+</button>
    <button type="button" disabled={dirty||!selectedFolder} onClick={()=>{if(selectedFolder)setNamingFolder({parent:selectedFolder.parent,target:selectedFolder});}} aria-label={t('notes.renameFolder')} title={t('notes.renameFolder')}>
     <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m15 4 5 5-12 12-5 1 1-5Z M13 6l5 5"/></svg>
    </button>
    <button type="button" disabled={dirty||!selectedFolder} onClick={()=>setDeletingFolder(selectedFolder??null)} aria-label={t('notes.deleteFolder')} title={t('notes.deleteFolder')}>
     <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></svg>
    </button>
   </div>
   <ul className="prompt-note-tree">{tree('',0)}</ul>
  </aside>
  <nav className="prompt-note-browser" aria-label={t('notes.saved')}><h3>{t('notes.saved')}</h3><ul className="prompt-note-list">{book.notes.filter(n=>!folder||n.folder===folder).sort((a,b)=>a.title.localeCompare(b.title)).map(n=><li key={n.id}><button type="button" disabled={dirty} aria-pressed={id===n.id} onClick={()=>chooseNote(n)}>{n.title}</button></li>)}</ul></nav><section className="prompt-note-editor" aria-label={t('notes.editor')}>{storageError&&<p role="alert">{t('notes.storageError')}</p>}<div className="prompt-note-actions"><button type="button" disabled={!canSave} onClick={saveDraft}>{t('notes.save')}</button><button type="button" disabled={!dirty} onClick={()=>setDraft(saved?{title:saved.title,positive:saved.positive,negative:saved.negative,folder:saved.folder,seed:String(saved.seed)}:empty(folder))}>{t('notes.discard')}</button><button type="button" disabled={!saved||dirty} onClick={()=>setDeleting(true)}>{t('notes.delete')}</button><button type="button" disabled={dirty} onClick={()=>{setId('');setDraft(empty(folder));}}>{t('notes.new')}</button>
   <button type="button" data-note-use-prompts disabled={!saved} title={t('notes.usePromptsHelp')}
    onClick={()=>{if(saved)onUsePrompts(saved.positive,saved.negative);}}>{t('notes.usePrompts')}</button>
   <button type="button" data-note-copy-main-prompts title={t('notes.copyMainPromptsHelp')}
    onClick={copyMainPrompts}>{t('notes.copyMainPrompts')}</button>
   {dirty&&<small role="status">{t('notes.unsaved')}</small>}<small className="prompt-note-location" title={location}>{location}</small></div><div className="prompt-note-fields"><label>{t('notes.title')}<input maxLength={100} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label><label>{t('notes.seed')}<input inputMode="numeric" maxLength={16} value={draft.seed} aria-invalid={!validSeed} onChange={e=>setDraft({...draft,seed:e.target.value})}/></label><label>{t('notes.moveTo')}<select data-note-move value={draft.folder} onChange={e=>setDraft({...draft,folder:e.target.value})}><option value="">{t('notes.root')}</option>{folderOptions.map(option=><option key={option.id} value={option.id}>{option.path}</option>)}</select></label></div><div className="prompt-note-prompts"><label>{t('notes.positive')}<textarea aria-label={t('notes.positive')} maxLength={16384} value={draft.positive} onChange={e=>setDraft({...draft,positive:e.target.value})}/></label><label>{t('notes.negative')}<textarea aria-label={t('notes.negative')} maxLength={16384} value={draft.negative} onChange={e=>setDraft({...draft,negative:e.target.value})}/></label></div></section>{namingFolder&&<FolderNameDialog title={t(namingFolder.target?'notes.renameFolder':'notes.newFolder')} initialName={namingFolder.target?.name??''}
  siblings={book.folders.filter(item=>item.parent===namingFolder.parent&&item.id!==namingFolder.target?.id)}
  storageError={storageError} onSave={saveFolderName} onClose={()=>setNamingFolder(null)}/>}
 {pendingOverwrite&&<ConfirmDialog focusCancel message={t('notes.confirmOverwrite',{name:pendingOverwrite.originalTitle})} onDone={accepted=>{
  setPendingOverwrite(null);
  if(accepted)persistNote(pendingOverwrite.note,true);
 }}/>}{deletingFolder&&<ConfirmDialog message={t('notes.confirmDeleteFolder',{name:deletingFolder.name})} onDone={accepted=>{if(accepted){const remove=new Set([deletingFolder.id]);let changed=true;while(changed){changed=false;for(const f of book.folders)if(remove.has(f.parent)&&!remove.has(f.id)){remove.add(f.id);changed=true;}}if(!setBook(old=>({...old,folders:old.folders.filter(f=>!remove.has(f.id)),notes:old.notes.filter(n=>!remove.has(n.folder))}))){setDeletingFolder(null);return;}setExpanded(old=>old.filter(id=>!remove.has(id)));chooseFolder(deletingFolder.parent);}setDeletingFolder(null);}}/>}{deleting&&<ConfirmDialog message={t('notes.confirmDelete',{name:saved?.title??''})} onDone={accepted=>{setDeleting(false);if(accepted){if(!setBook(old=>({...old,notes:old.notes.filter(n=>n.id!==id)})))return;setId('');setDraft(empty(folder));}}}/>}</div>;
}
