import type { ApiNode } from './execution';

/** Image first-pass modifier. Zero is an exact opt-out, including dependency checks. */
export interface LyingSigmaSettings { factor:number; startPercent:number; endPercent:number }
export const defaultLyingSigma:LyingSigmaSettings={factor:0,startPercent:0.25,endPercent:0.9};
export const lyingSigmaNode='DEAS_LyingSigmaSampler';
export const lyingSigmaSamplingNodes=[lyingSigmaNode,'RandomNoise','CFGGuider','KSamplerSelect','BasicScheduler','SamplerCustomAdvanced'] as const;
export function isLyingSigma(value:unknown):value is LyingSigmaSettings {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Record<string,unknown>;
 return Object.keys(v).length===3&&['factor','startPercent','endPercent'].every(k=>Object.hasOwn(v,k)&&typeof v[k]==='number'&&Number.isFinite(v[k]))
  &&(v.factor as number)>=-0.999&&(v.factor as number)<=1
  &&(v.startPercent as number)>=0&&(v.endPercent as number)<=1&&(v.startPercent as number)<(v.endPercent as number);
}
// These KSampler algorithms insert an extra sigma and discard the penultimate one.
// BasicScheduler alone cannot reproduce that schedule. Explicit schedules already use the custom path.
export function lyingSigmaScheduleIssue(sampler:string,steps:number,denoise:number,custom:boolean):'sampler'|'steps'|undefined {
 if(custom)return;
 if(['dpm_2','dpm_2_ancestral','uni_pc','uni_pc_bh2'].includes(sampler))return 'sampler';
 if(denoise>0&&Math.floor(steps/denoise)>10000)return 'steps';
}
/** Runs after all model/conditioning/mask wiring. Refine passes retain their original sampler. */
export function applyLyingSigma(graph:Record<string,ApiNode>,settings:LyingSigmaSettings|undefined):void {
 if(!settings?.factor)return;
 const original=graph['5'];
 if(original.class_type==='KSampler'){
  const i=original.inputs;
  graph.LSN={class_type:'RandomNoise',inputs:{noise_seed:i.seed}};
  graph.LSG={class_type:'CFGGuider',inputs:{model:i.model,positive:i.positive,negative:i.negative,cfg:i.cfg}};
  graph.LSQ={class_type:'KSamplerSelect',inputs:{sampler_name:i.sampler_name}};
  graph.LSZ={class_type:'BasicScheduler',inputs:{model:i.model,scheduler:i.scheduler,steps:i.steps,denoise:i.denoise}};
  graph['5']={class_type:'SamplerCustomAdvanced',inputs:{noise:['LSN',0],guider:['LSG',0],sampler:['LSQ',0],sigmas:['LSZ',0],latent_image:i.latent_image}};
 }
 graph.LS={class_type:lyingSigmaNode,inputs:{sampler:graph['5'].inputs.sampler,dishonesty_factor:settings.factor,start_percent:settings.startPercent,end_percent:settings.endPercent}};
 graph['5']={...graph['5'],inputs:{...graph['5'].inputs,sampler:['LS',0]}};
}
