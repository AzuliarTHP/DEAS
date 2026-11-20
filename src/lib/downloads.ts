import { invoke, isTauri } from '@tauri-apps/api/core';

export type DownloadScope = 'user' | 'repo' | 'model' | 'search' | 'index' | 'backend';
export interface DownloadProvider { id:string; kind:string; label:string; origin:string; scopes:DownloadScope[]; anonymousNotice:string }
export interface CatalogEntry { id:string; label:string; providerId:string; scope:DownloadScope; locator:string; kind:string; target:string; license?:string; sha256?:string; preview?:string; media?:'image'|'video'; auth?:boolean; nsfw?:boolean; base?:string; publishedAt?:string }
export interface DownloadCatalog { version:1; providers:DownloadProvider[]; entries:CatalogEntry[] }
export interface DownloadResource { id:string; label:string; kind:string; url?:string; size?:number; sha256?:string; downloadable:boolean; locator?:string; license?:string; preview?:string; category?:string; auth?:boolean; nsfw?:boolean; base?:string; publishedAt?:string; version?:string; variant?:string }
export interface BrowseRequest { providerId:string; scope:DownloadScope; locator:string; cursor?:string; authenticated:boolean; nsfw?:boolean }
export interface DownloadListing { resources:DownloadResource[]; nextCursor:string|null; warnings:string[] }
export interface PlanRequest { providerId:string; resources:DownloadResource[]; parentPath:string; folderName:string; authenticated:boolean }
export interface DownloadPlan { id:string; target:string; resources:DownloadResource[]; totalKnownBytes:number; unknownSizeCount:number; warnings:string[]; canExecute:boolean }
/** One background queue entry; persisted by the native engine and resumable after interruption. */
export interface DownloadJob { id:string; label:string; provider:{id:string;kind:string;label:string;origin:string}; target:string; resources:DownloadResource[]; state:'queued'|'running'|'succeeded'|'failed'|'cancelled'|'interrupted'; completed:number; bytesPlaced:number; totalBytes:number; currentFile:string|null; error:string|null; fileBytes?:number[] }
export interface DownloadStatus { state:'idle'|'running'|'succeeded'|'failed'|'cancelled'; completed:number; total:number; bytesDownloaded:number; error:string|null; bytesPlaced?:number; totalBytes?:number; jobs?:DownloadJob[] }
export interface AuthMetadata { providerId:string; configured:boolean; persisted:boolean }
export interface AuthVerification { providerId:string; status:'verified'|'rejected'|'unavailable'|'unsupported' }
/** Transport is native-only. Catalog validation and credential origin binding belong to native code. */
function native<T>(command:string,args?:Record<string,unknown>):Promise<T> {
 if(!isTauri())return Promise.reject(new Error('Native transport unavailable'));
 return args===undefined?invoke<T>(command):invoke<T>(command,args);
}
export const readDownloadCatalog=()=>native<DownloadCatalog>('native_download_catalog');
export const importDownloadCatalog=(text:string)=>native<DownloadCatalog>('native_download_import_catalog',{text});
export const browseDownloads=(request:BrowseRequest)=>native<DownloadListing>('native_download_browse',{request});
export const pickDownloadParent=(title:string)=>native<string|null>('native_pick_directory',{title});
export const planDownloads=(request:PlanRequest)=>native<DownloadPlan>('native_download_plan',{request});
export const startDownloads=(planId:string)=>native<DownloadStatus>('native_download_start',{planId,confirmed:true});
/** Enqueue every planned folder group at once; the native worker runs the queue in the background. */
export const startDownloadsQueue=(planIds:string[])=>native<DownloadStatus>('native_download_start_queue',{planIds,confirmed:true});
/** Resume interrupted, cancelled or failed queue jobs (omit ids to resume every one). */
export const resumeDownloads=(jobIds?:string[])=>native<DownloadStatus>('native_download_resume',{jobIds:jobIds??null});
export const clearDownloadQueue=()=>native<DownloadStatus>('native_download_clear_queue');
export const readDownloadStatus=()=>native<DownloadStatus>('native_download_status');
export const cancelDownloads=()=>native<DownloadStatus>('native_download_cancel');
export const verifyAuthToken=(providerId:string)=>native<AuthVerification>('native_auth_verify',{providerId});
export const readAuthStatus=()=>native<AuthMetadata[]>('native_auth_status');
export const setAuthToken=(providerId:string,token:string,persist=false)=>native<AuthMetadata>('native_auth_set',{providerId,token,persist});
export const restoreAuthToken=(providerId:string)=>native<AuthMetadata>('native_auth_restore',{providerId});
export const removeAuthToken=(providerId:string)=>native<AuthMetadata>('native_auth_remove',{providerId});
/** Where a ComfyUI category lives inside a managed DEAS environment. */
/** Workflows live in the ComfyUI user folder; model categories follow the configured models folder when set. */
export const comfyFolder=(installTarget:string,category:string,modelsDir?:string)=>category==='workflows'?`${installTarget}/ComfyUI/user/default/workflows`:`${modelsDir??`${installTarget}/ComfyUI/models`}/${category==='dials'?'loras/dials':category}`;
export const openTokenPage=(providerId:string)=>invoke<void>('native_open_token_page',{providerId});
/** Human-readable sizes for download statistics: bytes only below 1 KiB, one decimal above. */
export function formatBytes(bytes:number):string {
 if(!Number.isFinite(bytes)||bytes<0)return '—';
 const units=['B','KB','MB','GB','TB'];
 let value=bytes,unit=0;
 while(value>=1024&&unit<units.length-1){value/=1024;unit++;}
 return `${unit?value.toFixed(1).replace(/\.0$/,''):value} ${units[unit]}`;
}
/** Integer completion percent, or null when the total size is unknown. */
export function percentOf(placed:number,total:number):number|null {
 if(!total||total<=0)return null;
 return Math.min(100,Math.round((placed/total)*100));
}
