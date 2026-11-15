import { useEffect, useRef } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import './modelAutoLoad.css';

export function ModelViewAllControl({value,onChange}:{value:boolean;onChange:(value:boolean)=>void}) {
 const {t}=useI18n();
 return <label className="model-view-all" title={t('library.viewAllHelp')}><input type="checkbox" checked={value} onChange={event=>onChange(event.target.checked)}/>{t('library.viewAll')}</label>;
}

/** Append from the existing snapshot, without any native request or filesystem work. */
export function ModelAutoLoad({onMore}:{onMore:()=>void}) {
 const {t}=useI18n();const sentinel=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const node=sentinel.current;if(!node)return;
  if(typeof IntersectionObserver==='undefined'){let active=true;queueMicrotask(()=>{if(active)onMore();});return()=>{active=false;};}
  const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))onMore();},{root:node.closest('[data-model-scroll]'),rootMargin:'300px'});
  observer.observe(node);return()=>observer.disconnect();
 },[onMore]);
 return <div ref={sentinel} className="model-auto-load" role="status">{t('library.loadingMore')}</div>;
}
