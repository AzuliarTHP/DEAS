import { useMemo, useRef } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { usePref } from '../lib/preferences';
import './modelFolderTree.css';

interface Folder {path:string; label:string; count:number; children:Map<string,Folder>}
const validExpanded=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=10000&&v.every(p=>typeof p==='string'&&p.length<=32768);

/** File names are normalized for browsing only; selected model IDs are never rewritten. */
export function ModelFolderTree({names,selected,onSelect,storageKey,rootLabel,disabled=false,hiddenFolders=[],onToggleHidden}:{names:string[];selected:string;onSelect:(folder:string)=>void;storageKey:string;rootLabel:string;disabled?:boolean;hiddenFolders?:string[];onToggleHidden?:(folder:string)=>void}) {
 const {t}=useI18n();const host=useRef<HTMLElement>(null);
 const [expanded,setExpanded]=usePref<string[]>('modelFolders.expanded.'+storageKey,[],validExpanded);
 const root=useMemo(()=>{
  const node:Folder={path:'',label:rootLabel,count:names.length,children:new Map()};
  for(const name of names){let parent=node;const parts=name.split(/[\\/]/).slice(0,-1).filter(Boolean);for(const part of parts){const path=parent.path?`${parent.path}/${part}`:part;let child=parent.children.get(part);if(!child){child={path,label:part,count:0,children:new Map()};parent.children.set(part,child);}child.count++;parent=child;}}
  return node;
 },[names,rootLabel]);
 const isOpen=(path:string)=>path===''?!expanded.includes('__root_closed__'):expanded.includes(path);
 const toggle=(path:string)=>{const key=path||'__root_closed__';setExpanded(old=>old.includes(key)?old.filter(p=>p!==key):[...old,key]);};
 const keydown=(event:React.KeyboardEvent<HTMLButtonElement>,node:Folder)=>{
  const buttons=[...host.current?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')??[]];const index=buttons.indexOf(event.currentTarget);
  let target:HTMLButtonElement|undefined;
  if(event.key==='ArrowDown')target=buttons[Math.min(buttons.length-1,index+1)];
  else if(event.key==='ArrowUp')target=buttons[Math.max(0,index-1)];
  else if(event.key==='Home')target=buttons[0];
  else if(event.key==='End')target=buttons.at(-1);
  else if(event.key==='ArrowRight'&&node.children.size){if(!isOpen(node.path))toggle(node.path);else target=buttons[index+1];}
  else if(event.key==='ArrowLeft'){if(node.children.size&&isOpen(node.path))toggle(node.path);else {const parent=node.path.includes('/')?node.path.slice(0,node.path.lastIndexOf('/')):'';target=buttons.find(b=>b.dataset.folderPath===parent);}}
  else return;
  event.preventDefault();target?.focus();
 };
 const render=(node:Folder,level:number):React.ReactNode=>{
  const children=[...node.children.values()].sort((a,b)=>a.label.localeCompare(b.label));const open=isOpen(node.path);const ownHidden=hiddenFolders.includes(node.path);const inheritedHidden=hiddenFolders.some(path=>path!==node.path&&(path===''||node.path.startsWith(`${path}/`)));const hidden=ownHidden||inheritedHidden;
  return <li role="none" key={node.path}><div className={`model-folder-row${selected===node.path?' is-selected':''}${hidden?' is-hidden':''}`} style={{paddingInlineStart:`${(level-1)*.7}rem`}}>
   {children.length>0?<button className="model-folder-toggle" type="button" tabIndex={-1} aria-label={t(open?'library.collapseFolder':'library.expandFolder',{name:node.label})} disabled={disabled} onClick={()=>toggle(node.path)}>{open?'⌄':'›'}</button>:<span className="model-folder-spacer"/>}
   <button className="model-folder-select" role="treeitem" type="button" aria-level={level} aria-expanded={children.length?open:undefined} aria-selected={selected===node.path} aria-current={selected===node.path?'location':undefined} aria-label={node.label} data-folder-path={node.path} disabled={disabled} onClick={()=>onSelect(node.path)} onKeyDown={e=>keydown(e,node)}><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" aria-hidden="true"><path d="M2 5h6l2 2h8v10H2z"/></svg><span>{node.label}</span><small aria-hidden="true">{node.count}</small></button>
   {onToggleHidden&&<button type="button" className="model-folder-visibility" aria-label={t(hidden?'library.showFolder':'library.hideFolder',{name:node.label})} title={t(inheritedHidden?'library.folderHiddenByParent':hidden?'library.showFolder':'library.hideFolder',{name:node.label})} aria-pressed={hidden} disabled={disabled||inheritedHidden} onClick={()=>onToggleHidden(node.path)}><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>{hidden&&<path d="m3 3 18 18"/>}</svg></button>}
  </div>{children.length>0&&open&&<ul role="group">{children.map(child=>render(child,level+1))}</ul>}</li>;
 };
 return <nav ref={host} className="model-folder-tree" aria-label={t('library.folderTree')} data-model-folder-tree><ul role="tree" aria-label={t('library.folderTree')}>{render(root,1)}</ul></nav>;
}
