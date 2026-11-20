import { MODEL_LIBRARY_UPDATED,patchModels,modelPathKey,type ModelLibraryUpdate,publishModelLibrary,refreshModelPreviews } from '../../lib/modelLibrary';
import { scanModels, type LocalModel, type ModelRefreshScope } from '../../lib/models';
import { reportLibraryError } from './libraryDiagnostics';

// One folder's listing for this app session. Never persist model metadata or cache
// execution admission: generation continues to use the native validation paths.
let listing: {root:string; models:LocalModel[]|null; pending?:Promise<LocalModel[]>; updates?:LocalModel[][]; completedFetch?:{id:string;reload:Promise<LocalModel[]>}}|undefined;

export function loadInstalledListing(root:string, refresh=false, reloadIndex=false, scope?:ModelRefreshScope):Promise<LocalModel[]> {
 if(listing?.root!==root)listing={root,models:null};
 const entry=listing;
 if(entry.pending)return entry.pending;
 if(!refresh&&!reloadIndex&&entry.models!==null)return Promise.resolve(entry.models);
 entry.updates=[];
 entry.pending=(scope?scanModels(root,[],refresh,scope):scanModels(root,[],refresh)).then(value=>{
  const revisions=new Map(entry.models?.map(model=>[modelPathKey(model.path),model.previewRevision]));
  const previous=value.map(model=>({...model,previewRevision:revisions.get(modelPathKey(model.path))}));
  const patched=entry.updates!.reduce(patchModels,previous);
  const inScope=(model:LocalModel)=>!scope||
   (scope.category==='models'?['checkpoints','diffusion_models'].includes(model.category):model.category===scope.category)&&
   (!scope.folder||model.name.replace(/\\/g,'/').startsWith(scope.folder+'/'));
  const fresh=refresh?new Map(refreshModelPreviews(patched.filter(inScope)).map(model=>[model.path,model])):null;
  const models=fresh?patched.map(model=>fresh.get(model.path)??model):patched;
  entry.models=models;
  if(listing===entry&&(refresh||reloadIndex))publishModelLibrary({root,models});
  return models;
 }).catch(error=>{reportLibraryError('listing');throw error;}).finally(()=>{entry.pending=undefined;entry.updates=undefined;});
 return entry.pending;
}

export function reloadAfterFetch(root:string,id:string):Promise<LocalModel[]> {
 if(listing?.root!==root)return loadInstalledListing(root,false,true);
 const entry=listing;
 if(entry.completedFetch?.id===id)return entry.completedFetch.reload.then(models=>entry.models??models);
 const reload=Promise.resolve(entry.pending).catch(()=>{}).then(()=>
  listing===entry?loadInstalledListing(root,false,true):entry.models??[]);
 entry.completedFetch={id,reload};
 return reload.catch(error=>{
  if(entry.completedFetch?.id===id)entry.completedFetch=undefined;
  throw error;
 });
}

export function rememberInstalledListing(root:string, models:LocalModel[]) {
 if(listing?.root===root)listing.models=models;
}

export function clearInstalledListing() { listing=undefined; }

// Edit meta can be used from Studio while Library is unmounted.
if(typeof window!=='undefined')window.addEventListener('deas:model-family-changed',event=>{
 const model=(event as CustomEvent<LocalModel>).detail;
 listing?.updates?.push([model]);
 if(listing?.models)listing.models=listing.models.map(old=>old.path===model.path?{...model,addedAt:old.addedAt,localPreview:model.localPreview??old.localPreview}:old);
});

if(typeof window!=='undefined')window.addEventListener(MODEL_LIBRARY_UPDATED,event=>{const change=(event as CustomEvent<ModelLibraryUpdate>).detail;if(listing&&change.updates&&modelPathKey(listing.root)===modelPathKey(change.root)){listing.updates?.push(change.updates);if(listing.models)listing.models=patchModels(listing.models,change.updates);}});
