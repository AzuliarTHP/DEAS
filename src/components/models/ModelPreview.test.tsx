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
