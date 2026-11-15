import { useLayoutEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { readCurrentWorkbench, readH3Session, runWorkbenchJob, waitForWorkbenchJob, stopWorkbenchJob, type JobStatus, type H3Clip } from '../../lib/jobs';
import { inspectVideoPost, uploadVideoPostSource } from '../../lib/videoPost';
import { useI18n } from '../../i18n/I18nProvider';
import { isH3Video, type VideoIntentV1, type H3JoinIntentV1 } from '../../lib/videoIntent';

export interface ContinuityJoinProps { onBusyChange?:(busy:boolean)=>void; captureTransition?:()=>{intent:VideoIntentV1;admissionEpoch:number;prepare?:()=>Promise<VideoIntentV1>}; endpoint?: string; session: string; running: boolean; disabled: boolean }
interface Preflight { ok: boolean; issues: string[]; seconds: number; mode: string }
interface JoinFile { filename: string; label: string; duration: number | null; trimStart: string; trimEnd: string }
type JoinNotice = 'load-failed' | 'file-blocked' | 'add-failed' | 'preflight-blocked' | 'preflight-failed' | 'preparation-failed' | 'admission-failed' | 'execution-failed' | 'correlation-failed' | 'missing-bridge' | 'cancelled' | 'cancel-failed';
const logNotice = (reason: JoinNotice, job?: JobStatus) => {
  const jobId = job?.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(job.id) ? job.id : null;
  if (isTauri()) void invoke('native_logs_continuity_join_notice', { reason, jobId }).catch(() => {});
};
const secondsOrNull = (value: string) => (value.trim() === '' ? null : Number(value));

/** Director-parity Join clips: assemble one session's saved segments, or chosen video files, into one video without loading a model. */
export function ContinuityJoin({ endpoint, session, running, disabled, captureTransition, onBusyChange }: ContinuityJoinProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'segments' | 'files'>('segments');
  const [clips, setClips] = useState<H3Clip[]>([]);
  const [files, setFiles] = useState<JoinFile[]>([]);
  const [failed, setFailed] = useState(false);
  const [chain, setChain] = useState<string[] | null>(null);
  const [copy, setCopy] = useState(false);
  const [smoothAudioSeams, setSmoothAudioSeams] = useState(false);
  const preflightRequest = useRef(0);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transitions, setTransitions] = useState(false);
  const [contextFrames, setContextFrames] = useState(22);
  const [transitionFrames, setTransitionFrames] = useState(29);
  const [prompt, setPrompt] = useState('');
  const [progress, setProgress] = useState('');
  const [bridges, setBridges] = useState<string[]>([]);
  const sequence = useRef<{cancelled:boolean;cancellationFailed:boolean;job?:JobStatus} | null>(null);
  const request = useRef(0);
  const cancelJob = async (job:JobStatus, owned: {cancellationFailed:boolean}) => {
    try {
      const stopped = await stopWorkbenchJob(job);
      // A pending delete can reconcile a just-started job without interrupting it.
      const result = job.state === 'queued' && stopped.state === 'running' ? await stopWorkbenchJob(stopped) : stopped;
      if (['queued','running','unknown'].includes(result.state)) throw new Error(t('studio.run.cont.join.cancelFailed'));
    } catch (e) { owned.cancellationFailed = true; logNotice('cancel-failed', job); throw e; }
  };
  const cancel = () => {
    const owned = sequence.current;
    if (!owned || owned.cancelled) return;
    owned.cancelled = true;
    if (owned.job && ['queued','running'].includes(owned.job.state)) void cancelJob(owned.job, owned).catch(() => setError(t('studio.run.cont.join.cancelFailed')));
  };
  useLayoutEffect(() => () => { request.current++; cancel(); }, [endpoint, session]);
  useLayoutEffect(() => {
    const reveal = () => { if (!sequence.current && mode !== 'files') { setMode('files'); setPreflight(null); setResult(null); } };
    window.addEventListener('deas:reveal-join', reveal);
    return () => window.removeEventListener('deas:reveal-join', reveal);
  }, [mode]);
  const useTransitions = mode === 'files' && transitions && !!captureTransition;
  const validTransition = Number.isInteger(contextFrames) && contextFrames >= 5 && contextFrames % 17 === 5 && Number.isInteger(transitionFrames) && transitionFrames >= 12 && (2 * contextFrames + transitionFrames) % 17 === 5 && 2 * contextFrames + transitionFrames <= 3600;
  const locked = running || busy;
  useLayoutEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy,onBusyChange]);
  useLayoutEffect(() => {
    const id = ++request.current;
    setClips([]); setChain(null); setPreflight(null); setResult(null); setError(null); setFailed(false);
    if (!isTauri() || !endpoint) return;
    readH3Session(endpoint, session)
      .then(value => { if (request.current === id) setClips(Array.isArray(value?.clips) ? value.clips : []); })
      .catch(() => { if (request.current === id) { setFailed(true); logNotice('load-failed'); } });
  }, [endpoint, session]);
  // Select chain to here: the ordered parent chain ending at this clip; ordering and
  // export coverage stay authoritative in the pack's preflight, not guessed here.
  const selectChain = (clipId: string) => {
    const byId = new Map(clips.map(c => [c.clipId, c]));
    const ids: string[] = [];
    let current: string | null = clipId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) { seen.add(current); ids.unshift(current); current = byId.get(current)?.parent ?? null; }
    setChain(ids); setPreflight(null); setResult(null);
  };
  // Files are copied into the backend Input folder on pick, so preflight sees the real rows.
  const addVideo = async () => {
    if (!endpoint) return;
    setError(null);
    try {
      const inspected = await inspectVideoPost(t('studio.videoPost.dialog'));
      if (!inspected?.sourceId) return;
      if (inspected.blockers.length) { logNotice('file-blocked'); setError(t('studio.run.cont.join.fileBlocked')); return; }
      const filename = await uploadVideoPostSource(endpoint, inspected.sourceId);
      if (files.some(f => f.filename === filename)) return;
      setFiles([...files, { filename, label: inspected.name, duration: inspected.durationSeconds, trimStart: '', trimEnd: '' }]);
      setPreflight(null); setResult(null);
    } catch { logNotice('add-failed'); setError(t('studio.run.cont.join.addFailed')); }
  };
  const editFile = (filename: string, patch: Partial<JoinFile>) => { setFiles(files.map(f => f.filename === filename ? { ...f, ...patch } : f)); setPreflight(null); };
  const moveFile = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= files.length) return;
    const next = [...files];
    [next[index], next[to]] = [next[to], next[index]];
    setFiles(next); setPreflight(null);
  };
  const rows = () => mode === 'segments'
    ? (chain ?? []).map(clip_id => ({ kind: 'checkpoint' as const, session, clip_id }))
    : files.map(f => ({ kind: 'media' as const, filename: f.filename, trim_start: secondsOrNull(f.trimStart) ?? 0, trim_end: secondsOrNull(f.trimEnd) }));
  const ready = mode === 'segments' ? !!chain : files.length > 0;
  const runPreflight = async () => {
    const id = request.current;
    const preflightId = ++preflightRequest.current;
    setPreflight(null); setError(null);
    try {
      const reply = await fetch(`${endpoint}/df_h3_continuity/assembly/preflight`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, rows: rows(), repair_transitions: false, audio_policy: smoothAudioSeams ? 'smooth-seams' : 'preserve', copy_video: copy }) });
      const value = await reply.json();
      if (request.current !== id || preflightRequest.current !== preflightId) return;
      if (value.ok !== true) logNotice('preflight-blocked');
      setPreflight({ ok: value.ok === true, issues: Array.isArray(value.issues) ? value.issues.map(String) : [], seconds: Number(value.seconds), mode: String(value.mode ?? '') });
    } catch { if (request.current === id && preflightRequest.current === preflightId) { logNotice('preflight-failed'); setError(t('studio.run.cont.join.preflightFailed')); } }
  };
  const run = async () => {
    if (!endpoint || !ready || sequence.current || (useTransitions && (!validTransition || files.length < 2))) return;
    const owned = {cancelled:false,cancellationFailed:false} as {cancelled:boolean;cancellationFailed:boolean;job?:JobStatus};
    sequence.current = owned;
    const active = () => !owned.cancelled && sequence.current === owned;
    setBusy(true); setError(null); setResult(null); setBridges([]); setProgress('');
    let notice: JoinNotice = 'preparation-failed';
    try {
      // Capture before the first await; Stop must never grant this sequence a fresh epoch.
      const captured = useTransitions ? captureTransition!() : null;
      let draft = captured ? structuredClone(captured.intent) : null;
      notice = 'admission-failed';
      const snapshot = await readCurrentWorkbench();
      const epoch = captured?.admissionEpoch ?? snapshot.admissionEpoch;
      const checkAdmission = async () => {
        notice = 'admission-failed';
        const current = await readCurrentWorkbench();
        if (!active() || current.stopping || current.admissionEpoch !== epoch) { notice = 'cancelled'; throw new Error(t('studio.run.cont.join.cancelled')); }
      };
      if (!active() || snapshot.stopping || snapshot.admissionEpoch !== epoch) { notice = 'cancelled'; throw new Error(t('studio.run.cont.join.cancelled')); }
      const submit = async (intent: VideoIntentV1 | H3JoinIntentV1) => {
        await checkAdmission();
        notice = 'execution-failed';
        owned.job = undefined;
        // The public overloads require narrowing the join/video union before dispatch.
        let job: JobStatus;
        if (intent.recipeId === 'h3-join') job = await runWorkbenchJob(endpoint, intent, epoch);
        else job = await runWorkbenchJob(endpoint, intent, epoch);
        owned.job = job;
        if (!active()) {
          if (['queued','running'].includes(job.state)) await cancelJob(job, owned);
          throw new Error(t('studio.run.cont.join.cancelled'));
        }
        const done = await waitForWorkbenchJob(job, active);
        if (!active()) notice = 'cancelled';
        else if (done.id !== job.id) notice = 'correlation-failed';
        else if (done.state === 'cancelled') notice = 'cancelled';
        if (!active() || done.id !== job.id || done.state !== 'succeeded') throw new Error(t('studio.run.cont.join.failed'));
        owned.job = done;
        return done;
      };
      if (captured?.prepare) { notice = 'preparation-failed'; draft = await captured.prepare(); await checkAdmission(); }
      const selected = files.map(f => ({ filename:f.filename, ...(secondsOrNull(f.trimStart) ? {trimStart:Number(f.trimStart)} : {}), ...(secondsOrNull(f.trimEnd) !== null ? {trimEnd:Number(f.trimEnd)} : {}) }));
      const assembled:typeof selected = [];
      if (draft) {
        notice = 'preparation-failed';
        if (!isH3Video(draft.family) || !('h3' in draft)) throw new Error(t('studio.run.cont.join.failed'));
        // Transitions replace source conditioning, not the captured model/sampler/Director settings.
        const {latentUpscale, videoPost, faceRefine, audioEnhance, firstFrame, lastFrame, sourceVideo, ...generation} = draft;
        void latentUpscale; void videoPost; void faceRefine; void audioEnhance; void firstFrame; void lastFrame; void sourceVideo;
        const {continuity, transition, ...director} = draft.h3;
        void continuity; void transition;
        for (let i = 0; i < selected.length - 1; i++) {
          setProgress(t('studio.run.cont.join.progress', {cut:String(i+1),total:String(selected.length-1)}));
          assembled.push(selected[i]);
          const done = await submit({...generation, h3:{...director, transition:{files:[selected[i],selected[i+1]],contextFrames,transitionFrames,...(prompt.trim()?{prompt:prompt.trim()}:{})}}} as VideoIntentV1);
          if (!done.transition) { notice = 'missing-bridge'; throw new Error(t('studio.run.cont.join.missingBridge')); }
          assembled.push({filename:done.transition});
          setBridges(previous => [...previous,done.transition!]);
        }
        assembled.push(selected[selected.length-1]);
      }
      const join = mode === 'segments'
        ? { kind:'segments' as const, session, chain:chain!, ...(copy?{copyVideo:true}:{}) }
        : { kind:'files' as const, files:draft?assembled:selected, ...(copy?{copyVideo:true}:{}) };
      setProgress(t('studio.run.cont.join.run'));
      const done = await submit({recipeId:'h3-join',version:1,h3:{join:{...join,...(smoothAudioSeams?{smoothAudioSeams:true}:{})}}});
      setResult(done.outputs[0]?.filename ?? done.id);
    } catch (e) { if(e instanceof Error && 'jobState' in e && e.jobState==='cancelled' && 'jobId' in e && e.jobId===owned.job?.id) notice='cancelled'; if (!owned.cancellationFailed) logNotice(owned.cancelled ? 'cancelled' : notice, owned.job); setError(owned.cancellationFailed ? t('studio.run.cont.join.cancelFailed') : owned.cancelled ? t('studio.run.cont.join.cancelled') : `${t('studio.run.cont.join.failed')}: ${e instanceof Error ? e.message : String(e)}`); }
    finally { if (sequence.current === owned) { sequence.current = null; setBusy(false); setProgress(''); } }
  };
  return <div className="wb-cont-join" data-cont-join>
    <span className="wb-cont-join-title">{t('studio.run.cont.join.title')}</span>
    <label className="wb-option-row"><span>{t('studio.run.cont.join.mode')}</span><select data-cont-join-mode aria-label={t('studio.run.cont.join.mode')} disabled={locked} value={mode} onChange={e => { setMode(e.target.value as 'segments' | 'files'); setPreflight(null); setResult(null); }}>
      <option value="segments">{t('studio.run.cont.join.modeSegments')}</option>
      <option value="files">{t('studio.run.cont.join.modeFiles')}</option>
    </select></label>
    <p className="media-help">{t('studio.run.cont.join.hint')}</p>
    {mode === 'segments' && <>
      {failed && <p role="alert">{t('studio.run.cont.join.loadFailed')}</p>}
      <ul className="wb-cont-join-clips">{clips.map(c => <li key={c.clipId} data-cont-join-clip={c.clipId}>
        <code>{c.clipId.slice(0, 12)}</code>
        {c.frames !== null && <span>{`${(c.frames / 24).toFixed(1)} s`}</span>}
        <button type="button" className="wb-dock-action" data-cont-join-chain={c.clipId} disabled={locked} onClick={() => selectChain(c.clipId)}>{t('studio.run.cont.join.chainToHere')}</button>
      </li>)}</ul>
      {chain && <p data-cont-join-chain-count>{t('studio.run.cont.join.chain')}: {chain.length}</p>}
    </>}
    {mode === 'files' && <>
      <ul className="wb-cont-join-files">{files.map((f, i) => <li key={f.filename} data-cont-join-file={f.filename}>
        <code>{f.label}</code>
        <label><span>{t('studio.run.cont.join.trimStart')}</span><input type="number" aria-label={`${f.label}: ${t('studio.run.cont.join.trimStart')}`} data-cont-join-trim-start={f.filename} min={0} step={0.5} disabled={locked} value={f.trimStart} onChange={e => editFile(f.filename, { trimStart: e.target.value })} /></label>
        <label><span>{t('studio.run.cont.join.trimEnd')}</span><input type="number" aria-label={`${f.label}: ${t('studio.run.cont.join.trimEnd')}`} data-cont-join-trim-end={f.filename} min={0} step={0.5} disabled={locked} value={f.trimEnd} onChange={e => editFile(f.filename, { trimEnd: e.target.value })} /></label>
        <button type="button" aria-label={t('studio.run.cont.join.moveUp')} disabled={locked || i === 0} onClick={() => moveFile(i, -1)}>↑</button>
        <button type="button" aria-label={t('studio.run.cont.join.moveDown')} disabled={locked || i === files.length - 1} onClick={() => moveFile(i, 1)}>↓</button>
        <button type="button" aria-label={t('studio.run.cont.join.remove')} disabled={locked} onClick={() => { setFiles(files.filter(x => x.filename !== f.filename)); setPreflight(null); }}>✕</button>
      </li>)}</ul>
      <button type="button" className="wb-dock-action" data-cont-join-add disabled={locked || !endpoint} onClick={() => void addVideo()}>{t('studio.run.cont.join.addVideo')}</button>
    </>}
    {mode === 'files' && captureTransition && <fieldset disabled={locked} data-cont-join-transitions>
      <label><input type="checkbox" data-cont-join-transition checked={transitions} onChange={e=>setTransitions(e.target.checked)}/>{t('studio.run.cont.join.transitions')}</label>
      <fieldset disabled={!transitions}>
        <label>{t('studio.run.cont.join.context')}<input data-cont-join-context aria-label={t('studio.run.cont.join.context')} type="number" min={5} step={17} value={contextFrames} onChange={e=>setContextFrames(Number(e.target.value))}/></label>
        <label>{t('studio.run.cont.join.length')}<input data-cont-join-length aria-label={t('studio.run.cont.join.length')} type="number" min={12} step={17} value={transitionFrames} onChange={e=>setTransitionFrames(Number(e.target.value))}/></label>
        <label>{t('studio.run.cont.join.description')}<textarea data-cont-join-description maxLength={4000} value={prompt} onChange={e=>setPrompt(e.target.value)}/></label>
        {!validTransition && <p role="alert">{t('studio.run.cont.join.grid')}</p>}
      </fieldset>
    </fieldset>}
    <label className="wb-option-row"><input type="checkbox" data-cont-join-copy checked={copy} disabled={locked} onChange={e => { setCopy(e.target.checked); setPreflight(null); }} />{t('studio.run.cont.join.copyVideo')}</label>
    <label className="wb-option-row"><input type="checkbox" name="smoothAudioSeams" data-cont-join-smooth-audio checked={smoothAudioSeams} disabled={locked} onChange={e => { setSmoothAudioSeams(e.target.checked); preflightRequest.current++; setPreflight(null); setResult(null); }} />{t('studio.run.cont.join.smoothAudioSeams')}</label>
    <p className="media-help">{t('studio.run.cont.join.smoothAudioSeamsHint')}</p>
    <button type="button" className="wb-dock-action" data-cont-join-preflight disabled={locked || !ready} onClick={() => void runPreflight()}>{t('studio.run.cont.join.preflight')}</button>
    {preflight && <p data-cont-join-preflight-result role={preflight.ok ? 'status' : 'alert'}>{preflight.ok
      ? `${preflight.mode} · ${preflight.seconds.toFixed(1)} s`
      : (preflight.issues.join('; ') || t('studio.run.cont.join.preflightFailed'))}</p>}
    <button type="button" className="wb-dock-action" data-cont-join-run disabled={disabled || locked || !preflight?.ok || (useTransitions && (!validTransition || files.length < 2))} onClick={() => void run()}>{t('studio.run.cont.join.run')}</button>
    {busy && <><p role="status">{progress}</p><button type="button" data-cont-join-cancel onClick={cancel}>{t('studio.run.cont.join.cancel')}</button></>}
    {bridges.length > 0 && <div data-cont-join-bridges><span>{t('studio.run.cont.join.retained')}</span><ul>{bridges.map(b=><li key={b}><code>{b}</code></li>)}</ul></div>}
    {result && <p data-cont-join-result>{t('studio.run.cont.join.done')}: <code>{result}</code></p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
