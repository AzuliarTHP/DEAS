import type { LocalModel } from './models';
/** UI identity only; native commands still authorize the real files. */
export function modelPathKey(path:string){const windows=/^[a-z]:[\\/]|^\\\\|^\/\//i.test(path);let value=(windows?path.replace(/\\/g,'/'):path).replace(/\/+$/,'');if(windows)value=value.replace(/^\/\/\?\/UNC\//i,'//').replace(/^\/\/\?\//,'').toLowerCase();return value;}

export const MODEL_LIBRARY_UPDATED='deas:model-library-updated';
export type ModelLibraryUpdate={root:string;models?:LocalModel[];updates?:LocalModel[]};
export const publishModelLibrary=(detail:ModelLibraryUpdate)=>window.dispatchEvent(new CustomEvent(MODEL_LIBRARY_UPDATED,{detail}));
let previewRevision=0;
export function refreshModelPreviews(models:LocalModel[]){const revision=previewRevision=Math.max(Date.now(),previewRevision+1);return models.map(m=>({...m,previewRevision:revision}));}
export function patchModels(models:LocalModel[],updates:LocalModel[]){const byPath=new Map(updates.map(m=>[modelPathKey(m.path),m]));return models.map(m=>{const update=byPath.get(modelPathKey(m.path));return update?{...update,addedAt:m.addedAt,previewRevision:update.previewRevision??m.previewRevision,localPreview:update.localPreview??m.localPreview}:m;});}
export function applyLibraryUpdate(old:LocalModel[],change:ModelLibraryUpdate){const root=modelPathKey(change.root)+'/';const incoming=new Set(change.models?.map(m=>modelPathKey(m.path)));const models=change.models?[...change.models,...old.filter(m=>!modelPathKey(m.path).startsWith(root)&&!incoming.has(modelPathKey(m.path)))]:old;return change.updates?patchModels(models,change.updates):models;}
