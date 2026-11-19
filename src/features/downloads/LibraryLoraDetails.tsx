import { useRef, useState } from 'react';
import { ModelPreview } from '../../components/models/ModelPreview';
import { useI18n } from '../../i18n/I18nProvider';
import { modelTriggerWords, type LocalModel, type LoraEdit } from '../../lib/models';
import { reportLibraryError } from './libraryDiagnostics';

type CopyText = (text:string,key:string)=>Promise<void>;

async function encodeCover(file:File):Promise<number[]> {
 if(file.size<=0||file.size>16*1024*1024)throw new Error('Invalid image size');
 const url=URL.createObjectURL(file);
 try{
  const image=new Image();
  image.src=url;
  await image.decode();
  if(!image.naturalWidth||!image.naturalHeight)throw new Error('Invalid image');
  const scale=Math.min(1,1024/Math.max(image.naturalWidth,image.naturalHeight));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));
  canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
  const context=canvas.getContext('2d');
  if(!context)throw new Error('Image conversion is unavailable');
  context.drawImage(image,0,0,canvas.width,canvas.height);
  const png=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Could not encode image')),'image/png'));
  return Array.from(new Uint8Array(await png.arrayBuffer()));
 }finally{URL.revokeObjectURL(url);}
}

export function LibraryTriggerWords({model,copy,copied,onEdit,disabled}:{model:LocalModel;copy:CopyText;copied:string;onEdit?:(edit:LoraEdit)=>Promise<void>;disabled:boolean}) {
 const {t}=useI18n();
 const [draft,setDraft]=useState<string|null>(null);
 const [saving,setSaving]=useState(false);
 const [error,setError]=useState(false);
 const words=modelTriggerWords(model);
 const pending=draft===null?[]:[...new Set(draft.split(/\r?\n/).map(word=>word.trim()).filter(Boolean))];
 const valid=pending.length<=50&&pending.every(word=>[...word].length<=200&&!/\p{Cc}/u.test(word));
 const save=async()=>{
  if(!onEdit||!valid)return;
  setError(false);setSaving(true);
  try{await onEdit({kind:'triggerWords',words:pending});setDraft(null);}
  catch{setError(true);}
  finally{setSaving(false);}
 };
 if(!onEdit&&!words.length)return null;
 return <section className="library-detail-section">
  <div className="library-section-heading">
   <h4>{t('downloads.installed.words')}</h4>
   <div className="library-lora-actions">
    {words.length>0&&<button type="button" onClick={()=>void copy(words.join(', '),'words')}>{copied==='words'?t('library.copied'):t('library.copyAll')}</button>}
    {onEdit&&draft===null&&<button type="button" data-library-lora-triggers disabled={disabled} onClick={()=>{setError(false);setDraft(words.join('\n'));}}>{t('library.editTriggerWords')}</button>}
   </div>
  </div>
  {draft===null?<div className="library-trigger-words">{words.map((word,i)=><button type="button" key={`${word}-${i}`} onClick={()=>void copy(word,`word-${i}`)}>{copied===`word-${i}`?'✓ ':''}{word}</button>)}</div>:<>
   <label>{t('library.triggerWordsHint')}<textarea value={draft} maxLength={11000} disabled={saving} onChange={event=>setDraft(event.currentTarget.value)} rows={4}/></label>
   <div className="library-lora-actions">
    <button className="action-button" type="button" disabled={!valid||disabled||saving} onClick={()=>void save()}>{t('modelMeta.save')}</button>
    <button className="action-button" type="button" disabled={saving} onClick={()=>{setDraft(null);setError(false);}}>{t('modelMeta.cancel')}</button>
   </div>
  </>}
  {error&&<p role="alert">{t('modelMeta.error')}</p>}
 </section>;
}

export function LibraryCoverEditor({model,onEdit,disabled,blur}:{model:LocalModel;onEdit:(edit:LoraEdit)=>Promise<void>;disabled:boolean;blur:boolean}) {
 const {t}=useI18n();
 const input=useRef<HTMLInputElement>(null);
 const [busy,setBusy]=useState(false);
 const [result,setResult]=useState<'saved'|'error'|null>(null);
 const replace=async(file:File)=>{
  setResult(null);setBusy(true);
  try{await onEdit({kind:'preview',png:await encodeCover(file)});setResult('saved');}
  catch{reportLibraryError('lora-edit');setResult('error');}
  finally{setBusy(false);}
 };
 return <section className="library-detail-section library-cover-editor">
  <div className={blur?'library-cover-thumbnail is-sensitive':'library-cover-thumbnail'}><ModelPreview model={model} fallback={null}/></div>
  <div>
   <button type="button" className="action-button" data-library-lora-cover disabled={disabled||busy} onClick={()=>input.current?.click()}>{t('library.replacePreview')}</button>
   <input hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp" aria-label={t('library.replacePreview')} ref={input} onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file&&!disabled&&!busy)void replace(file);}}/>
   {result&&<p role={result==='error'?'alert':'status'}>{t(result==='error'?'library.previewEditError':'library.previewEdited')}</p>}
  </div>
 </section>;
}

export function LibraryPromptExamples({model,copy,copied,blur}:{model:LocalModel;copy:CopyText;copied:string;blur:boolean}) {
 const {t}=useI18n();
 const examples=model.info?.civitai?.examples??[];
 return <section className="library-detail-section" data-library-lora-examples tabIndex={-1}>
  <h4>{t('library.promptExamples')}</h4>
  {!examples.length&&<p className="field-help">{t('library.promptExamplesEmpty')}</p>}
  {examples.map(({image,prompt,negativePrompt},index)=><details key={index} className="library-prompt-example">
   <summary><span className={blur?'library-example-image is-sensitive':'library-example-image'}><img src={image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"/></span>{t('library.promptExample',{n:index+1})}</summary>
   <div className="library-example-prompt">
    <button type="button" className="action-button" onClick={()=>void copy(prompt,`example-${index}`)}>{t(copied===`example-${index}`?'library.copied':'library.copyExamplePrompt')}</button>
    <pre>{prompt}</pre>
    {negativePrompt&&<><button type="button" className="action-button" onClick={()=>void copy(negativePrompt,`example-negative-${index}`)}>{t(copied===`example-negative-${index}`?'library.copied':'library.copyExampleNegative')}</button><pre>{negativePrompt}</pre></>}
   </div>
  </details>)}
 </section>;
}
