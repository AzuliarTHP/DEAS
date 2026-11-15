import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ModelPreview } from '../../components/models/ModelPreview';
import { useDialogBackdropClose } from '../../components/useDialogBackdropClose';
import { useI18n } from '../../i18n/I18nProvider';
import type { LocalModel } from '../../lib/models';
import { reportLibraryError } from '../downloads/libraryDiagnostics';

/** A second native modal above the LoRA picker; reads only its existing model snapshot. */
export function LoraDetailsDialog({model,onClose}:{model:LocalModel;onClose:()=>void}) {
 const {t,locale}=useI18n(),dialog=useRef<HTMLDialogElement>(null);
 const [copied,setCopied]=useState(false),[copyError,setCopyError]=useState(false);
 const info=model.info?.civitai,words=info?.trainedWords??[];
 useEffect(()=>{const opener=document.activeElement as HTMLElement|null,el=dialog.current!;el.showModal();return()=>{if(el.open)el.close();if(opener?.isConnected)opener.focus();};},[]);
 const backdrop=useDialogBackdropClose(onClose);
 const copy=async()=>{try{await navigator.clipboard.writeText(words.join(', '));setCopied(true);setCopyError(false);}catch{setCopyError(true);reportLibraryError('clipboard');}};
 return createPortal(<dialog ref={dialog} {...backdrop} className="lora-details-dialog" aria-label={t('loraDetails.title')} onCancel={e=>{e.preventDefault();e.stopPropagation();onClose();}}>
  <header><h2>{info?.name??model.name.split(/[\\/]/).at(-1)}</h2><button type="button" className="action-button" onClick={onClose}>{t('studio.close')}</button></header>
  <div className="lora-details-content"><div className="lora-details-preview"><ModelPreview model={model} fallback={<span aria-hidden="true">◆</span>}/></div>
   <div className="lora-details-facts"><dl>
    <dt>{t('modelMeta.filename')}</dt><dd>{model.name}</dd>
    <dt>{t('downloads.version')}</dt><dd>{info?.version??'—'}</dd>
    <dt>{t('library.base')}</dt><dd>{info?.base??model.family??t('library.unclassified')}</dd>
    <dt>{t('downloads.size')}</dt><dd>{model.size.toLocaleString(locale)}</dd>
    <dt>{t('downloads.installed.path')}</dt><dd>{model.path}</dd>
   </dl><section className="lora-details-triggers"><h3>{t('downloads.installed.words')}</h3>
    {words.length?<><div className="lora-trigger-words">{words.map((word,i)=><code key={`${i}:${word}`}>{word}</code>)}</div><button type="button" className="action-button" onClick={()=>void copy()}>{t(copied?'library.copied':'library.copyAll')}</button></>:<p>{t('loraDetails.noTriggers')}</p>}
    {copyError&&<p role="alert">{t('library.copyError')}</p>}
   </section></div></div>
 </dialog>,document.body);
}
