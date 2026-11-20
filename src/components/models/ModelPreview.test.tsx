import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ModelPreview } from './ModelPreview';
import type { LocalModel } from '../../lib/models';
vi.mock('@tauri-apps/api/core',()=>({convertFileSrc:(path:string)=>'asset://'+path,isTauri:()=>true,invoke:vi.fn(async()=>{})}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const model:LocalModel={category:'loras',name:'a.safetensors',path:'/models/a',size:1,localPreview:'/previews/a.jpg',info:{sha256:'',size:1,fetchedAt:1,civitai:{modelId:1,versionId:1,name:'A',version:'1',modelType:'LORA',category:'loras',nsfw:false,trainedWords:[],preview:'https://example.invalid/a.png'}}};
it('uses indexed JPG previews, falls back on failure and logs only the operation',()=>{
 const view=render(<ModelPreview model={model} fallback={<span>No preview</span>}/>);
 expect(view.container.querySelector('img')).toHaveProperty('src','asset:///previews/a.jpg');
 fireEvent.error(view.container.querySelector('img')!);expect(view.container.querySelector('img')).toHaveProperty('src','https://example.invalid/a.png');
 fireEvent.error(view.container.querySelector('img')!);expect(screen.getByText('No preview')).toBeTruthy();
 expect(vi.mocked(invoke).mock.calls).toEqual([['native_logs_library_error',{operation:'preview'}],['native_logs_library_error',{operation:'preview'}]]);
 view.rerender(<ModelPreview model={{...model,localPreview:'/previews/b.webp'}} fallback={<span>No preview</span>}/>);
 expect(view.container.querySelector('img')).toHaveProperty('src','asset:///previews/b.webp');
});
it('retries a previously failed cover after explicit refresh without changing provider URLs',()=>{
 const view=render(<ModelPreview model={model} fallback={<span>No preview</span>}/>);
 fireEvent.error(view.container.querySelector('img')!);fireEvent.error(view.container.querySelector('img')!);
 expect(screen.getByText('No preview')).toBeTruthy();
 view.rerender(<ModelPreview model={{...model,previewRevision:123}} fallback={<span>No preview</span>}/>);
 expect(view.container.querySelector('img')).toHaveProperty('src','asset:///previews/a.jpg?deas_preview=123');
 fireEvent.error(view.container.querySelector('img')!);expect(view.container.querySelector('img')).toHaveProperty('src','https://example.invalid/a.png');
});
it('prefers the local MP4 and falls back to a provider video with playback controls',()=>{
 const clip={...model,localPreview:'/previews/a.MP4',info:{...model.info!,civitai:{...model.info!.civitai!,preview:'https://image.civitai.com/layout-fixture/video',previewKind:'video' as const}}};
 const view=render(<ModelPreview model={clip} videoControls fallback={<span>No preview</span>}/>);
 const video=()=>view.container.querySelector('video')!;
 expect(video().getAttribute('src')).toBe('asset:///previews/a.MP4');
 expect(video().controls).toBe(true);
 expect(video().muted).toBe(true);
 fireEvent.error(video());
 expect(video().getAttribute('src')).toBe('https://image.civitai.com/layout-fixture/video');
});
