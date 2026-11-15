import { scanModels, type LocalModel } from '../../lib/models';
import { reportLibraryError } from './libraryDiagnostics';

// One folder's listing for this app session. Never persist model metadata or cache
// execution admission: generation continues to use the native validation paths.
let listing: {root:string; models:LocalModel[]|null; pending?:Promise<LocalModel[]>}|undefined;

export function loadInstalledListing(root:string, refresh=false, reloadIndex=false):Promise<LocalModel[]> {
 if(listing?.root!==root)listing={root,models:null};
 const entry=listing;
 if(entry.pending)return entry.pending;
 if(!refresh&&!reloadIndex&&entry.models!==null)return Promise.resolve(entry.models);
 entry.pending=scanModels(root,[],refresh).then(models=>{entry.models=models;return models;}).catch(error=>{reportLibraryError('listing');throw error;}).finally(()=>{entry.pending=undefined;});
 return entry.pending;
}

export function rememberInstalledListing(root:string, models:LocalModel[]) {
 if(listing?.root===root)listing.models=models;
}

export function clearInstalledListing() { listing=undefined; }

// Edit meta can be used from Studio while Library is unmounted.
if(typeof window!=='undefined')window.addEventListener('deas:model-family-changed',event=>{
 const model=(event as CustomEvent<LocalModel>).detail;
 if(listing?.models)listing.models=listing.models.map(old=>old.path===model.path?{...model,addedAt:old.addedAt,localPreview:old.localPreview}:old);
});
