import { invoke, isTauri } from '@tauri-apps/api/core';
/** Fixed operation only: filenames, notes, URLs and clipboard contents never enter logs. */
export function reportLibraryError(operation:'clipboard'|'listing'|'preview'|'selection'|'organization'|'family') {
 if(isTauri())void invoke('native_logs_library_error',{operation}).catch(()=>{});
}
