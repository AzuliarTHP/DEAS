export type HiddenModelFolders=Record<string,string[]>;
export const validHiddenModelFolders=(value:unknown):value is HiddenModelFolders=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.entries(value).length<=500&&Object.entries(value).every(([key,paths])=>key.length<=32768&&Array.isArray(paths)&&paths.length<=10000&&paths.every(path=>typeof path==='string'&&path.length<=32768));
/** Visibility affects browsing only; never changes a model ID, file or active selection. */
export function modelFolderHidden(name:string,hidden:readonly string[]) {
 const folder=name.replace(/\\/g,'/').split('/').slice(0,-1).join('/');
 return hidden.some(path=>path===''||folder===path||folder.startsWith(`${path}/`));
}
