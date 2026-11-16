import { useI18n } from '../../i18n/I18nProvider';

function SelectionIcon({kind}:{kind:'all'|'clear'|'family'|'favorite'|'unfavorite'}) {
 return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  {kind==='all'||kind==='clear'?<><rect x="4" y="4" width="16" height="16" rx="3"/>{kind==='all'?<path d="m8 12 3 3 5-6"/>:<path d="m9 9 6 6m0-6-6 6"/>}</>:kind==='family'?<><path d="M3 3h7l11 11-7 7L3 10z"/><circle cx="7.5" cy="7.5" r="1"/></>:<><path d="m11 3 2.5 5.5 6 .7-4.5 4 1.3 6-5.3-3-5.3 3 1.3-6-4.5-4 6-.7z"/><circle cx="18.5" cy="18.5" r="4.5" fill="var(--panel)"/><path d="M16.5 18.5h4"/>{kind==='favorite'&&<path d="M18.5 16.5v4"/>}</>}
 </svg>;
}

export function StudioSelectionTools({active,count,disabled,anchorLabel,onToggle,onSelectMatching,onClear,onFamily,onFavorite}:{active:boolean;count:number;disabled:boolean;anchorLabel?:string;onToggle:()=>void;onSelectMatching:()=>void;onClear:()=>void;onFamily:()=>void;onFavorite:(value:boolean)=>void}) {
 const {t}=useI18n();
 const action=(kind:Parameters<typeof SelectionIcon>[0]['kind'],label:string,onClick:()=>void,unavailable=false)=><button type="button" className="studio-selection-icon" data-studio-selection={kind==='all'?'matching':kind} aria-label={t(label)} title={t(label)} disabled={unavailable} onClick={onClick}><SelectionIcon kind={kind}/></button>;
 return <div className="studio-family-tools">
  {active&&<div className="studio-family-toolbar" role="group" aria-label={t('library.selectModels')}>
   <span aria-live="polite">{t('library.selectedCount',{count:String(count)})}</span>
   {action('all','library.selectMatching',onSelectMatching,!anchorLabel)}
   {action('clear','library.clearSelection',onClear,!count)}
   {action('family','library.bulkFamily',onFamily,!count)}
   {action('favorite','library.favoriteAction',()=>onFavorite(true),!count)}
   {action('unfavorite','library.unfavoriteAction',()=>onFavorite(false),!count)}
  </div>}
  <button type="button" className="wb-dock-action studio-family-select" data-family-select aria-pressed={active} disabled={disabled} onClick={onToggle}>{t(active?'library.endSelection':'library.selectModels')}</button>
 </div>;
}
