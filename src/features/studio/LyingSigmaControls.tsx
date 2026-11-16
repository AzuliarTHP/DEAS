import { useId } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { isLyingSigma, type LyingSigmaSettings } from '../../lib/lyingSigma';

const percent=(value:number)=>Number((value*100).toPrecision(15));

export function LyingSigmaControls({value,onChange,unavailable}:{value:LyingSigmaSettings;onChange:(value:LyingSigmaSettings)=>void;unavailable?:string}) {
 const {t}=useI18n(),id=useId(),hint=id+'-hint';
 const update=(key:keyof LyingSigmaSettings,n:number)=>{const next={...value,[key]:n};if(isLyingSigma(next))onChange(next);};
 return <div className="wb-lying-sigma wb-wide" data-lying-sigma>
  <div className="wb-field">
   <div className="wb-lying-sigma-heading"><label htmlFor={id}>{t('studio.run.lyingSigma')}</label>{value.factor===0&&<small id={hint}>{t('studio.run.lyingSigma.off')}</small>}</div>
   {/* Align the native step base with hundredths; restored values retain their exact precision. */}
   <input id={id} data-lying-sigma-factor aria-describedby={hint} type="number" min={-0.99} max={1} step={0.01} value={value.factor} onChange={e=>update('factor',Number(e.target.value))}/>
  </div>
  {value.factor!==0&&<small id={hint}>{t('studio.run.lyingSigma.hint')}</small>}
  {value.factor!==0&&<>
   <details><summary>{t('studio.run.lyingSigma.timing')}</summary><div className="wb-lying-sigma-timing">
    <label className="wb-field"><span>{t('studio.run.lyingSigma.start')}</span><input data-lying-sigma-start type="number" min={0} max={percent(value.endPercent)} step={0.1} value={percent(value.startPercent)} onChange={e=>update('startPercent',Number(e.target.value)/100)}/></label>
    <label className="wb-field"><span>{t('studio.run.lyingSigma.end')}</span><input data-lying-sigma-end type="number" min={percent(value.startPercent)} max={100} step={0.1} value={percent(value.endPercent)} onChange={e=>update('endPercent',Number(e.target.value)/100)}/></label>
   </div></details>
   {unavailable&&<small role="status">{unavailable}</small>}
  </>}
 </div>;
}
