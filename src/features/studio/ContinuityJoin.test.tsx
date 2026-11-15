import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import { ContinuityJoin } from './ContinuityJoin';
import { invoke } from '@tauri-apps/api/core';
import type { VideoIntentV1 } from '../../lib/videoIntent';
import { revealTarget } from '../../lib/search';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('../../lib/videoPost', () => ({ inspectVideoPost: vi.fn(), uploadVideoPostSource: vi.fn() }));
vi.mock('../../lib/jobs', () => ({
  stopWorkbenchJob: vi.fn(async job => ({...job,state:"cancelled"})),
  readH3Session: vi.fn(),
  readCurrentWorkbench: vi.fn(async () => ({ admissionEpoch: 4 })),
  runWorkbenchJob: vi.fn(async () => ({ id: 'j1', baseUrl: 'http://127.0.0.1:7801', promptId: 'p', state: 'queued', outputs: [], error: null, generationReady: false })),
  waitForWorkbenchJob: vi.fn(async (job: unknown) => ({ ...(job as object), state: 'succeeded', outputs: [{ filename: 'H3_Joined_ab.mp4', subfolder: '', type: 'output' }] })),
}));
import { readH3Session, readCurrentWorkbench, stopWorkbenchJob, runWorkbenchJob, waitForWorkbenchJob, type JobStatus } from '../../lib/jobs';
import { inspectVideoPost, uploadVideoPostSource } from '../../lib/videoPost';

const clips = [
  { clipId: 'root', parent: null, frames: 120, completed: 1, export: null },
  { clipId: 'c1', parent: 'root', frames: 239, completed: 1, export: { filename: 'a.mp4', subfolder: '', type: 'output' } },
  { clipId: 'c2', parent: 'c1', frames: 358, completed: 1, export: { filename: 'b.mp4', subfolder: '', type: 'output' } },
];
const settled = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const mount = (running = false) => {
  localStorage.setItem('deas.locale.v1', 'en');
  return render(<I18nProvider><ContinuityJoin endpoint="http://127.0.0.1:7801" session="s" running={running} disabled={false} /></I18nProvider>);
};
beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(null);
  vi.mocked(readH3Session).mockClear().mockResolvedValue({ latestId: 'c2', clips } as never);
  vi.mocked(readCurrentWorkbench).mockReset().mockResolvedValue({admissionEpoch:4} as never);
  vi.mocked(stopWorkbenchJob).mockClear();
  vi.mocked(runWorkbenchJob).mockReset().mockImplementation(async () => ({id:'j'+vi.mocked(runWorkbenchJob).mock.calls.length,baseUrl:'http://127.0.0.1:7801',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false}));
  vi.mocked(waitForWorkbenchJob).mockReset().mockImplementation(async job => ({...job,state:'succeeded',transition:'h3_transitions/'+job.id+'.mp4',outputs:[{filename:'H3_Joined_ab.mp4',subfolder:'',type:'output'}]}));
  globalThis.fetch = vi.fn(async () => ({ json: async () => ({ ok: true, issues: [], seconds: 14.916, mode: 'copy' }) })) as never;
  vi.mocked(inspectVideoPost).mockClear().mockResolvedValue({ sourceId: '11111111-2222-3333-4444-555555555555', name: 'take a', blockers: [], durationSeconds: 20 } as never);
  vi.mocked(uploadVideoPostSource).mockClear().mockResolvedValue('take_a.mp4');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('chain to here walks parents, preflight gates Join, Join submits the pinned h3-join intent and shows the file', async () => {
  const { container } = mount();
  await settled();
  const rows = [...container.querySelectorAll('[data-cont-join-chain]')];
  expect(rows).toHaveLength(3);
  fireEvent.click(rows[2]); // c2 → chain root→c1→c2
  expect(screen.getByText(/Chain: 3$/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Join now' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Check preflight' }));
  await settled();
  expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:7801/df_h3_continuity/assembly/preflight',
    expect.objectContaining({ method: 'POST' }));
  expect(screen.getByText('copy · 14.9 s')).toBeTruthy();
  const run = screen.getByRole('button', { name: 'Join now' }) as HTMLButtonElement;
  expect(run.disabled).toBe(false);
  fireEvent.click(run);
  await settled();
  expect(runWorkbenchJob).toHaveBeenCalledWith('http://127.0.0.1:7801',
    { recipeId: 'h3-join', version: 1, h3: { join: { kind: 'segments', session: 's', chain: ['root', 'c1', 'c2'] } } }, 4);
  expect(screen.getByText(/H3_Joined_ab\.mp4/)).toBeTruthy();
});

test('copy option rides the preflight body and the intent; failing preflight keeps Join disabled', async () => {
  const { container } = mount();
  await settled();
  fireEvent.click([...container.querySelectorAll('[data-cont-join-chain]')][1]);
  const copy = screen.getByRole('checkbox') as HTMLInputElement;
  fireEvent.click(copy);
  let preflightBody = '';
  globalThis.fetch = vi.fn(async (_u: unknown, init: { body: string }) => { preflightBody = init.body; return { json: async () => ({ ok: false, issues: ['Incomplete export coverage; select the missing prefix/segments.'] }) }; }) as never;
  fireEvent.click(screen.getByRole('button', { name: 'Check preflight' }));
  await settled();
  expect(JSON.parse(preflightBody)).toMatchObject({ copy_video: true, rows: [{ clip_id: 'root' }, { clip_id: 'c1' }] });
  expect(screen.getByRole('alert').textContent).toContain('Incomplete export coverage');
  expect((screen.getByRole('button', { name: 'Join now' }) as HTMLButtonElement).disabled).toBe(true);
  expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('running locks chain selection and Join; a rejected session read reports instead of offering an empty list', async () => {
  const { container } = mount(true);
  await settled();
  for (const button of container.querySelectorAll('[data-cont-join-chain]'))
    expect((button as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  vi.mocked(readH3Session).mockRejectedValueOnce(new Error('gone'));
  mount();
  await settled();
  expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
  expect(container.querySelectorAll('[data-cont-join-chain]')).toHaveLength(0);
});

test('files mode: pick copies into Input, trims and order ride preflight rows and the h3-join files intent', async () => {
  mount();
  await settled();
  fireEvent.change(screen.getByRole('combobox', { name: 'Source' }), { target: { value: 'files' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add video…' }));
  await settled();
  expect(uploadVideoPostSource).toHaveBeenCalledWith('http://127.0.0.1:7801', '11111111-2222-3333-4444-555555555555');
  vi.mocked(inspectVideoPost).mockResolvedValueOnce({ sourceId: '66666666-7777-8888-9999-000000000000', name: 'take b', blockers: [], durationSeconds: 30 } as never);
  vi.mocked(uploadVideoPostSource).mockResolvedValueOnce('take_b.mp4');
  fireEvent.click(screen.getByRole('button', { name: 'Add video…' }));
  await settled();
  fireEvent.change(screen.getByRole('spinbutton', { name: 'take a: End (s)' }), { target: { value: '10' } });
  let preflightBody = '';
  globalThis.fetch = vi.fn(async (_u: unknown, init: { body: string }) => { preflightBody = init.body; return { json: async () => ({ ok: true, issues: [], seconds: 27.5, mode: 're-encode' }) }; }) as never;
  fireEvent.click(screen.getByRole('button', { name: 'Check preflight' }));
  await settled();
  expect(JSON.parse(preflightBody)).toMatchObject({ rows: [
    { kind: 'media', filename: 'take_a.mp4', trim_start: 0, trim_end: 10 },
    { kind: 'media', filename: 'take_b.mp4', trim_start: 0, trim_end: null },
  ] });
  fireEvent.click(screen.getByRole('button', { name: 'Join now' }));
  await settled();
  expect(runWorkbenchJob).toHaveBeenCalledWith('http://127.0.0.1:7801',
    { recipeId: 'h3-join', version: 1, h3: { join: { kind: 'files', files: [{ filename: 'take_a.mp4', trimEnd: 10 }, { filename: 'take_b.mp4' }] } } }, 4);
});

test('files mode: a blocked pick reports without adding a row', async () => {
  mount();
  await settled();
  vi.mocked(inspectVideoPost).mockResolvedValueOnce({ sourceId: '11111111-2222-3333-4444-555555555555', name: 'broken', blockers: ['no-decodable-video'], durationSeconds: null } as never);
  fireEvent.change(screen.getByRole('combobox', { name: 'Source' }), { target: { value: 'files' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add video…' }));
  await settled();
  expect(uploadVideoPostSource).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('blocking issues');
});

const h3Draft = () => ({recipeId:'video-generation',version:1,family:'minimax-h3',positivePrompt:'captured',negativePrompt:'negative',model:'H3.safetensors',textEncoder:'clip',vae:'vae',seed:42,width:768,height:512,frames:124,frameRate:24,steps:12,cfg:3,sampler:'euler',scheduler:'simple',outputPrefix:'test',output:{},h3:{mode:'T2VA',audioVae:'av',shiftVideo:3,shiftAudio:2,references:[]}} as unknown as VideoIntentV1);
async function transitionFiles(count=3, enabled=true, draft=h3Draft()) {
  localStorage.setItem('deas.locale.v1','en');
  const capture=vi.fn(()=>({intent:draft,admissionEpoch:4}));
  const view=render(<I18nProvider><ContinuityJoin endpoint="http://127.0.0.1:7801" session="s" running={false} disabled={false} captureTransition={capture}/></I18nProvider>);
  await settled();
  fireEvent.change(screen.getByRole('combobox',{name:'Source'}),{target:{value:'files'}});
  for(let i=0;i<count;i++){
    vi.mocked(uploadVideoPostSource).mockResolvedValueOnce(`clip${i}.mp4`);
    fireEvent.click(screen.getByRole('button',{name:'Add video…'}));await settled();
  }
  if(enabled)fireEvent.click(view.container.querySelector('[data-cont-join-transition]')!);
  fireEvent.click(screen.getByRole('button',{name:'Check preflight'}));await settled();
  return {...view,draft,capture,run:()=>fireEvent.click(screen.getByRole('button',{name:'Join now'}))};
}

test('three clips: exact sequential cut IDs then interleaved join, captured settings and trims are immutable',async()=>{
  const draft: VideoIntentV1 = {...h3Draft(), audioEnhance:{mode:'clean',profile:'speech',device:'cpu'}};
  const view=await transitionFiles(3,true,draft);
  fireEvent.change(screen.getByRole('spinbutton',{name:'Context per side (frames)'}),{target:{value:'22'}});
  const original=structuredClone(view.draft);
  let finish!:(job:JobStatus)=>void;
  vi.mocked(waitForWorkbenchJob).mockImplementationOnce(job=>new Promise(resolve=>{finish=()=>resolve({...job,state:'succeeded',transition:'h3_transitions/first.mp4'});}));
  view.run();await settled();
  expect(view.capture).toHaveBeenCalledTimes(1);
  expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Transition 1 of 2')).toBeTruthy();
  (view.draft as {model:string}).model='changed';
  await act(async()=>{finish({} as JobStatus);});await settled();
  expect(runWorkbenchJob).toHaveBeenCalledTimes(3);
  const calls=vi.mocked(runWorkbenchJob).mock.calls;
  expect(original.audioEnhance).toBeDefined();
  for (const call of calls) expect(call[1]).not.toHaveProperty('audioEnhance');
  for(const call of calls.slice(0,2))expect(call).toEqual(['http://127.0.0.1:7801',expect.objectContaining({model:original.model,seed:42,steps:12,sampler:'euler',h3:expect.objectContaining({shiftVideo:3,transition:expect.objectContaining({contextFrames:22,transitionFrames:29})})}),4]);
  expect((calls[0][1] as unknown as VideoIntentV1 & {h3:{transition:unknown}}).h3.transition).toMatchObject({files:[{filename:'clip0.mp4'},{filename:'clip1.mp4'}]});
  expect(calls[2][1]).toMatchObject({recipeId:'h3-join',h3:{join:{files:[{filename:'clip0.mp4'},{filename:'h3_transitions/first.mp4'},{filename:'clip1.mp4'},{filename:'h3_transitions/j2.mp4'},{filename:'clip2.mp4'}]}}});
  expect(vi.mocked(waitForWorkbenchJob).mock.calls.map(c=>c[0].id)).toEqual(['j1','j2','j3']);
});

test.each(['failed','cancelled','unknown','missing','lost'])('second cut %s stops future submissions and retains first bridge',async(state)=>{
  const view=await transitionFiles(4);
  vi.mocked(waitForWorkbenchJob).mockImplementationOnce(async job=>({...job,state:'succeeded',transition:'h3_transitions/kept.mp4'})).mockImplementationOnce(async job=>{
    if(state==='lost')throw new Error('no longer retained');
    return {...job,state:state==='missing'?'succeeded':state as JobStatus['state'],transition:undefined};
  });
  view.run();await settled();await settled();
  expect(runWorkbenchJob).toHaveBeenCalledTimes(2);
  expect(screen.getByText('h3_transitions/kept.mp4')).toBeTruthy();
  expect(screen.getByRole('alert')).toBeTruthy();
});

test('cancel exact owned job while waiting; no further cuts or join',async()=>{
  const view=await transitionFiles();let finish!:()=>void;
  vi.mocked(waitForWorkbenchJob).mockImplementationOnce(job=>new Promise(resolve=>{finish=()=>resolve({...job,state:'succeeded',transition:'h3_transitions/late.mp4'});}));
  view.run();await settled();
  fireEvent.click(screen.getByRole('button',{name:'Cancel join sequence'}));
  await act(async()=>finish());await settled();
  expect(stopWorkbenchJob).toHaveBeenCalledWith(expect.objectContaining({id:'j1'}));
  expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith('native_logs_continuity_join_notice', {reason:'cancelled',jobId:null});
});

test.each(['cancel','unmount'])('delayed native admission after %s cancels returned exact job, no follow-ups',async(action)=>{
  const view=await transitionFiles();let admit!:(job:JobStatus)=>void;
  vi.mocked(runWorkbenchJob).mockImplementationOnce(()=>new Promise(resolve=>{admit=resolve;}));
  view.run();await settled();
  if(action==='unmount')view.unmount();else fireEvent.click(screen.getByRole('button',{name:'Cancel join sequence'}));
  await act(async()=>admit({id:'late',state:'queued',outputs:[]} as unknown as JobStatus));await settled();
  expect(stopWorkbenchJob).toHaveBeenCalledWith(expect.objectContaining({id:'late'}));
  expect(runWorkbenchJob).toHaveBeenCalledTimes(1);expect(waitForWorkbenchJob).not.toHaveBeenCalled();
});

test('queued cancellation that reconciles running uses scoped interrupt once, never global Stop',async()=>{
 const view=await transitionFiles();let finish!:()=>void;
 vi.mocked(waitForWorkbenchJob).mockImplementationOnce(job=>new Promise(resolve=>{finish=()=>resolve({...job,state:'cancelled'});}));
 vi.mocked(stopWorkbenchJob).mockResolvedValueOnce({id:'j1',state:'running'} as JobStatus).mockResolvedValueOnce({id:'j1',state:'cancelled'} as JobStatus);
 view.run();await settled();fireEvent.click(screen.getByRole('button',{name:'Cancel join sequence'}));await settled();
 expect(stopWorkbenchJob).toHaveBeenCalledTimes(2);expect(vi.mocked(stopWorkbenchJob).mock.calls[1][0]).toMatchObject({id:'j1',state:'running'});
 await act(async()=>finish());await settled();expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
});

test('Stop during initial snapshot does not refresh the captured admission fence',async()=>{
  const view=await transitionFiles();let snapshot!:(value:never)=>void;
  vi.mocked(readCurrentWorkbench).mockImplementationOnce(()=>new Promise(resolve=>{snapshot=resolve;}));
  view.run();await settled();
  await act(async()=>snapshot({admissionEpoch:5} as never));await settled();
  expect(runWorkbenchJob).not.toHaveBeenCalled();expect(view.capture).toHaveBeenCalledTimes(1);
});

test('Stop between cuts blocks follow-up with the original epoch',async()=>{
  const view=await transitionFiles();
  vi.mocked(waitForWorkbenchJob).mockImplementationOnce(async job=>{vi.mocked(readCurrentWorkbench).mockResolvedValue({admissionEpoch:5} as never);return {...job,state:'succeeded',transition:'h3_transitions/kept.mp4'};});
  view.run();await settled();await settled();
  expect(runWorkbenchJob).toHaveBeenCalledTimes(1);expect(screen.getByText('h3_transitions/kept.mp4')).toBeTruthy();
});

test('transition windows preserve captured Director references and forward trimmed neighbours and optional prompt',async()=>{
 const draft=h3Draft();if(!('h3' in draft))throw new Error('H3 fixture');
 draft.h3.media=[{type:'image',file:'identity.png',slot:1}];
 const view=await transitionFiles(2,true,draft);
 fireEvent.change(view.container.querySelector('[data-cont-join-trim-start="clip0.mp4"]')!,{target:{value:'2'}});
 fireEvent.change(view.container.querySelector('[data-cont-join-trim-end="clip0.mp4"]')!,{target:{value:'10'}});
 fireEvent.change(view.container.querySelector('[data-cont-join-description]')!,{target:{value:' move the camera '}});
 fireEvent.click(screen.getByRole('button',{name:'Check preflight'}));await settled();view.run();await settled();await settled();
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({h3:{media:[{type:'image',file:'identity.png',slot:1}],transition:{files:[{filename:'clip0.mp4',trimStart:2,trimEnd:10},{filename:'clip1.mp4'}],prompt:'move the camera'}}});
 expect(vi.mocked(runWorkbenchJob).mock.calls[1][1]).toMatchObject({h3:{join:{files:[{filename:'clip0.mp4',trimStart:2,trimEnd:10},{filename:'h3_transitions/j1.mp4'},{filename:'clip1.mp4'}]}}});
});

test('OFF remains model-free; no capture, and controls absent without H3 Workbench context',async()=>{
  const view=await transitionFiles(3,false);view.run();await settled();await settled();
  expect(view.capture).not.toHaveBeenCalled();expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({recipeId:'h3-join',h3:{join:{files:[{filename:'clip0.mp4'},{filename:'clip1.mp4'},{filename:'clip2.mp4'}]}}});
  view.unmount();const other=mount();await settled();
  fireEvent.change(screen.getByRole('combobox',{name:'Source'}),{target:{value:'files'}});
  expect(other.container.querySelector('[data-cont-join-transitions]')).toBeNull();
});

test('search reveals files controls without enabling transitions; invalid grid blocks Run',async()=>{
  const view=await transitionFiles(2,false);
  act(()=>{expect(revealTarget('[data-cont-join-context]').state).toBe('disabled');});
  expect((view.container.querySelector('[data-cont-join-transition]') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(view.container.querySelector('[data-cont-join-transition]')!);
  fireEvent.change(screen.getByRole('spinbutton',{name:'Context per side (frames)'}),{target:{value:'23'}});
  expect((screen.getByRole('button',{name:'Join now'}) as HTMLButtonElement).disabled).toBe(true);
});

test.each([
  ['missing-bridge', 'missing'],
  ['correlation-failed', 'correlation'],
  ['execution-failed', 'failed'],
  ['execution-failed', 'transport'],
] as const)('shared logs receive sanitized %s for %s; logging failure retains the UI error', async (reason, outcome) => {
  const view = await transitionFiles(2);
  const id = '11111111-2222-4333-8444-555555555555';
  vi.mocked(runWorkbenchJob).mockResolvedValueOnce({id,state:'queued',outputs:[]} as unknown as JobStatus);
  vi.mocked(waitForWorkbenchJob).mockImplementationOnce(async job => {
    if (outcome === 'transport') throw new Error('/private/movie.mp4 token=secret');
    return {...job,id:outcome==='correlation'?'other':job.id,state:outcome==='failed'?'failed':'succeeded',transition:undefined};
  });
  vi.mocked(invoke).mockRejectedValue(new Error('logging unavailable'));
  view.run(); await settled(); await settled();
  expect(screen.getByRole('alert').textContent).toContain('failed');
  expect(invoke).toHaveBeenCalledExactlyOnceWith('native_logs_continuity_join_notice', {reason,jobId:id});
});

test('preflight transport and validation outcomes reach shared logs without forwarding server details', async () => {
  const view = await transitionFiles(2);
  vi.mocked(fetch).mockRejectedValueOnce(new Error('/private/movie.mp4 token=secret'));
  fireEvent.click(screen.getByRole('button', {name:'Check preflight'})); await settled();
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith('native_logs_continuity_join_notice', {reason:'preflight-failed',jobId:null});
  vi.mocked(fetch).mockResolvedValueOnce({json:async()=>({ok:false,issues:['blocked']})} as Response);
  fireEvent.click(screen.getByRole('button', {name:'Check preflight'})); await settled();
  expect(invoke).toHaveBeenCalledWith('native_logs_continuity_join_notice', {reason:'preflight-blocked',jobId:null});
  expect(view.container.querySelector('[data-cont-join-run]')).toHaveProperty('disabled',true);
});

test('preparation failure is logged without hiding the original error when logging fails', async () => {
  const view = await transitionFiles(2);
  view.capture.mockImplementationOnce(() => { throw new Error('preparation unavailable'); });
  vi.mocked(invoke).mockRejectedValue(new Error('logging unavailable'));
  view.run(); await settled();
  expect(screen.getByRole('alert').textContent).toContain('preparation unavailable');
  expect(invoke).toHaveBeenCalledExactlyOnceWith('native_logs_continuity_join_notice', {reason:'preparation-failed',jobId:null});
});

test.each(['before', 'after'] as const)('cancel failure %s waiter completion retains the final warning and exact private-safe log', async ordering => {
  const view = await transitionFiles(2);
  const id = '11111111-2222-4333-8444-555555555555';
  vi.mocked(runWorkbenchJob).mockResolvedValueOnce({id,state:'queued',outputs:[]} as unknown as JobStatus);
  let finish!:()=>void;
  let failCancellation!:()=>void;
  vi.mocked(waitForWorkbenchJob).mockImplementationOnce((_job, active)=>new Promise((_resolve,reject)=>{finish=()=>{
    expect(active()).toBe(false);
    reject(new Error('SAM selection cancelled.'));
  };}));
  vi.mocked(stopWorkbenchJob).mockImplementationOnce(()=>new Promise((_resolve,reject)=>{failCancellation=()=>reject(new Error('/private/movie.mp4 token=secret'));}));
  vi.mocked(invoke).mockRejectedValue(new Error('logging unavailable'));
  view.run(); await settled();
  fireEvent.click(screen.getByRole('button',{name:'Cancel join sequence'})); await settled();
  if (ordering === 'before') {
    await act(async()=>failCancellation()); await settled();
    expect(screen.getByRole('alert').textContent).toContain('could not be confirmed');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('native_logs_continuity_join_notice', {reason:'cancel-failed',jobId:id});
  }
  await act(async()=>finish()); await settled();
  expect(screen.queryByRole('button',{name:'Cancel join sequence'})).toBeNull();
  if (ordering === 'after') { await act(async()=>failCancellation()); await settled(); }
  expect(screen.getByRole('alert').textContent).toContain('could not be confirmed');
  expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
  expect(stopWorkbenchJob).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({id}));
  expect(view.container.querySelector('[data-cont-join-result]')).toBeNull();
  expect(invoke).toHaveBeenCalledWith('native_logs_continuity_join_notice', {reason:'cancel-failed',jobId:id});
  if (ordering === 'before') expect(invoke).toHaveBeenCalledExactlyOnceWith('native_logs_continuity_join_notice', {reason:'cancel-failed',jobId:id});
  for (const [command, payload] of vi.mocked(invoke).mock.calls) {
    expect(command).toBe('native_logs_continuity_join_notice');
    expect(payload).toEqual({jobId:id,reason:expect.stringMatching(/^(cancelled|cancel-failed)$/)});
  }
});


test.each(['cancelled','failed','unknown'] as const)('real waiter terminal %s metadata chooses the correct central-log outcome',async state=>{
 const view=await transitionFiles();
 vi.mocked(waitForWorkbenchJob).mockImplementationOnce(async job=>{throw Object.assign(new Error('native outcome'),{jobState:state,jobId:job.id});});
 view.run();await settled();await settled();
 expect(invoke).toHaveBeenCalledWith('native_logs_continuity_join_notice',expect.objectContaining({reason:state==='cancelled'?'cancelled':'execution-failed'}));
 expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
});
