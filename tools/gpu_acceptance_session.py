#!/usr/bin/env python3
"""One-shot, logged GPU acceptance session for DEAS plan items that need the local GPU (test GPU).

Run it when the GPU is free:

    python3 tools/gpu_acceptance_session.py --list            # show the gate manifest
    python3 tools/gpu_acceptance_session.py --precheck        # compile-only, no GPU, safe any time
    python3 tools/gpu_acceptance_session.py --all             # the full batch (needs free GPU + models)
    python3 tools/gpu_acceptance_session.py --only V-12,V-14  # a subset

What it does:
  1. Refuses to start while something is actually computing on the GPU: utilization above
     --max-util, or a non-desktop process holding >= --max-app-mib VRAM. The compositor,
     browsers, Sunshine and Discord always hold VRAM here and are ignored, so total
     memory.used is deliberately NOT the signal. Tuning flags: --max-util, --max-app-mib,
     --samples, --force. Chosen port is never one another session is already listening on.
  2. Starts ONE throwaway backend from the DEAS-owned env on a free port with scratch
     input/output/temp dirs and the real model paths config.
  3. Compiles every gate intent with the CURRENT Rust compiler (temporary #[ignore] marker test,
     auto-removed afterwards) before submitting anything — a stale intent contract fails fast
     and cheaply instead of burning a GPU hour.
  4. Runs gates in dependency order through the skill's gpu_intent_driver
     (submit -> poll -> VRAM/RAM peaks -> files -> results.jsonl).
  5. Always tears the backend down (trap), prints a PASS/FAIL/SKIP summary table and writes:
       artifacts/verification/gpu-acceptance-<UTC timestamp>/
           session.log        everything printed (tee)
           results.jsonl      per-gate measurements (driver format)
           summary.md         human table to paste into docs/VERIFICATION.md
  6. Deletes its own deas-probe-* artifacts and scratch inputs at the end.

Honesty rule: gates marked draft:true carry intent shapes reconstructed from the compiler
tests and the plan text; check them against the PLAN item + UI builder before trusting a
FAIL, and never treat this script's PASS as native/Windows acceptance.
"""
import argparse
import datetime as dt
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ENV = Path(os.environ.get('DEAS_ENV') or os.path.expanduser('~/dev/deas-environment'))
COMFY = ENV / 'ComfyUI'
VENV_PY = ENV / 'venv/bin/python'
MODELS_YAML = ENV / 'deas-models.yaml'
RESOURCES = Path(os.environ.get('DEAS_RESOURCES') or os.path.expanduser('~/dev/AI-Ressources'))
SRC_TAURI = REPO / 'src-tauri'
OUT_ROOT = REPO / 'artifacts/verification'
MARKER = '// DEAS-GPU-ACCEPTANCE-TMP-TEST'
DRIVER_SRC = Path.home() / '.agents/skills/deas-development/scripts/gpu_intent_driver.py'

# Model ids follow the owner's recorded working setup (docs + VERIFICATION).
H3_MODEL = 'MiniMaxH3/dasiwa_minimax_h3_ref2va_v5xs_pruned_graviton_turbo_int8_row-wise_convrot_runtime_mixed.safetensors'
H3_TEXT_ENCODER = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
H3_VAE = 'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors'
H3_AUDIO_VAE = 'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors'
H3_LATENT_UPSCALER = 'minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors'
REGENERATE_LORA = 'MiniMaxH3/open_h3_regenerate_2k_native_svd_e0999_comfyui.safetensors'
IMAGE_CKPT = 'Illustrious/DasiwaIllustriousAnime_epitaphecstasy.safetensors'
SPANDREL_UPSCALE = '2x-AnimeSharpV4_RCAN.safetensors'
LTX_MODEL = 'LTX2/ltx.safetensors'
SAM3 = 'SAM3/sam3.1_multiplex_fp16.safetensors'

PROBE_IMAGE = 'deas-inputs/acceptance-a.png'   # staged by the session from /input sources
PROBE_IMAGE2 = 'deas-inputs/acceptance-b.png'  # second reference for multi-reference gates


def h3_base():
    """H3 intent per the recorded owner setup: 832x480, 124 frames, 8 steps euler/simple, shift 10/3."""
    return {
        'recipeId': 'video-generation', 'version': 1, 'family': 'minimax-h3',
        'positivePrompt': 'a calm harbor at dawn, slow camera push-in',
        'negativePrompt': 'text and subtitles',
        'model': H3_MODEL, 'textEncoder': H3_TEXT_ENCODER, 'vae': H3_VAE,
        'seed': 1234, 'width': 832, 'height': 480, 'frames': 124, 'frameRate': 24,
        'steps': 8, 'cfg': 1.0, 'sampler': 'euler', 'scheduler': 'simple',
        'outputPrefix': 'video/acceptance/session',
        'output': {'codec': 'Auto', 'container': 'Auto', 'bitDepth': 'Auto', 'quality': 20,
                   'audioCodec': 'Auto', 'audioBitrate': '192k',
                   'saveFirstFrame': True, 'saveLastFrame': False},
        'h3': {'mode': 'REF2VA', 'audioVae': H3_AUDIO_VAE, 'shiftVideo': 10, 'shiftAudio': 3,
               'references': [], 'media': [{'type': 'image', 'file': PROBE_IMAGE, 'slot': 0}]},
    }


def h3_block(**over):
    """h3 block with optional key removal via remove=[...] (media belongs exactly to REF2VA)."""
    h = dict(h3_base()['h3'])
    for k in over.pop('remove', []):
        h.pop(k, None)
    h.update(over)
    return h


MODEL_KEYS = ('model', 'textEncoder', 'vae', 'audioVae', 'checkpoint', 'lowModel', 'upscaleModel',
              'samCheckpoint', 'lora', 'textProjection')
MODELS_ROOT = RESOURCES / 'models'


def model_index():
    return {f.name: f for f in MODELS_ROOT.rglob('*') if f.is_file() and f.suffix in ('.safetensors', '.sft', '.gguf')}


def missing_models(intent, index):
    """Every model id the intent names must exist on disk (folder-prefixed ids are matched by basename)."""
    out = []

    def walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k in MODEL_KEYS and isinstance(v, str) and Path(v).name not in index:
                    out.append(v)
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
    walk(intent)
    return sorted(set(out))


def face_block():
    return {'samCheckpoint': SAM3, 'prompt': 'a detailed face', 'threshold': 0.5,
            'maxObjects': 4, 'detectInterval': 1, 'denoise': 0.35, 'cropFactor': 2.5, 'feather': 6}


# --------------------------------------------------------------------------- manifest
# name, plan id, draft?, check(note), intent builder. Intents may be (base, mutate) pairs.
GATES = [
    dict(name='V-12-h3', item='V-12', intent=h3_base,
         note='real H3 recipe run; check exact 832x480, 124 frames, fps, audio track', draft=False),
    dict(name='V-02-multiref-autoaspect', item='V-02', intent=lambda: {
        **h3_base(), 'width': 736, 'height': 928,
        'h3': {**h3_base()['h3'],
               'media': [{'type': 'image', 'file': PROBE_IMAGE, 'slot': 0},
                         {'type': 'image', 'file': PROBE_IMAGE2, 'slot': 1}]},
    }, note='multi-reference Auto aspect (portrait first picture): ffprobe W/H/frames must equal the '
            'compiled canvas exactly; compare against the Director auto preset for the same source',
         draft=False),
    dict(name='V-17-i2v-auto', item='V-17', intent=lambda: {
        **h3_base(),
        'h3': h3_block(mode='I2VA', inputScaling='Auto',
                       references=[{'slot': 0, 'image': PROBE_IMAGE}], remove=['media'])},
        note='I2VA input scaling Auto: canvas/first-frame handling, no silent crop or pad', draft=False),
    dict(name='V-17-fill-and-crop', item='V-17', intent=lambda: {
        **h3_base(),
        'h3': h3_block(mode='I2VA', inputScaling='Fill and crop',
                       references=[{'slot': 0, 'image': PROBE_IMAGE}], remove=['media'])},
        note='same seed/settings as V-17-i2v-auto; the pair is the Auto vs Fill-and-crop real-run check',
        draft=False),
    dict(name='V-13-dials', item='V-13', intent=lambda: {
        **h3_base(),
        'dials': [{'dial': 'dials/h3_evil_cold.safetensors', 'strength': 1.5, 'on': True}]},
        note='Dial Rack real run; V-12-h3 is the same-seed control (video_metrics PSNR must be far apart)',
        draft=False),
    dict(name='V-03-enhanced-preview', item='V-03', intent=lambda: {
        **h3_base(), 'enhancedPreview': {'decoder': 'tiny', 'model': 'MiniMaxH3/taeh3.safetensors'}},
        note='animated live previews: preview artifacts must appear DURING sampling, not only at the end '
             '(watch backend.log / preview observer); visual quality judgement stays OWNER', draft=False),
    dict(name='MD-08-gguf', item='MD-08', intent=lambda: {
        **h3_base(), 'family': 'minimax-h3-hyperflow',
        'model': 'MiniMaxH3/minimax_h3_ref2va_hyperflow_flash_14b-Q8_0.gguf',
        'h3': {**h3_base()['h3'], 'mode': 'REF2VA'}},
        note='GGUF real inference (HyperFlow Flash Q8_0): SKIPs until that file is in the library', draft=False),
    dict(name='V-14-learned-latent-upscale', item='V-14', intent=lambda: {
        **h3_base(), 'latentUpscale': {'model': H3_LATENT_UPSCALER, 'scale': 2, 'steps': 3, 'denoise': 0.25}},
        note='learned 3D-conv latent upscale; sharpness/flicker via video_metrics.py vs classic control', draft=False),
    dict(name='V-16-regenerate-2k-untiled', item='V-16', intent=lambda: {
        **h3_base(),
        'latentUpscale': {'model': H3_LATENT_UPSCALER,
                          'regenerate': {'lora': REGENERATE_LORA, 'target': '2K'}}},
        note='Hi-Res Regenerate 2K untiled (spatialTiling:false): expect ~18.5 min, VRAM fill, sharper than tiled control',
        draft=False, timeout=3600),
    dict(name='V-11-seamless-loop', item='V-11', intent=lambda: {
        **h3_base(), 'videoPost': {'loop': {'backend': 'rtx', 'audio': 'crossfade'}}},
        note='real RIFE/RTX loop + tempo detection on real audio (0.2 confidence threshold)', draft=False),
    dict(name='P-05-pp1-paired-ordering', item='P-05/P-06', intent=lambda: {
        **h3_base(), 'videoPost': {'upscaleModel': SPANDREL_UPSCALE}},
        note='paired Original/Processed products, baseline-first ordering; expect two files with Original '
             'published first, plus a separate mid-run Stop check keeping the _original', draft=False),
    dict(name='P-04-derope', item='P-04', intent=lambda: {
        **h3_base(), 'videoPost': {'derope': {'preset': 'balanced', 'inject': 0.48}}},
        note='de-rope second pass behind baseline gate; A/B with video_metrics.py vs no-derope control', draft=False),
    dict(name='P-03-face-refine', item='P-03', intent=lambda: {
        **h3_base(), 'faceRefine': face_block()},
        note='automatic whole-video face refine; crop montage + Laplacian variance vs baseline', draft=False),
    dict(name='P-02-stream-362f', item='P-02', intent=lambda: {
        **{**h3_base(), 'width': 736, 'height': 928, 'frames': 362},
        'streamDecode': True,
        'latentUpscale': {'model': H3_LATENT_UPSCALER,
                          'regenerate': {'lora': REGENERATE_LORA, 'target': '2K'}}},
        note="owner's OOM case: 362f 736x928 + 3D upscale + 2K target with streamDecode ON; "
             'RAM/swap/VRAM peaks are the acceptance measurement (compare the 48.1 GB incident)',
        draft=True, timeout=7200),
    dict(name='MD-01-lying-sigma', item='MD-01', intent=lambda: {
        'recipeId': 'checkpoint-text-to-image-diagnostic', 'version': 1,
        'positivePrompt': 'a lighthouse in a storm, painterly', 'negativePrompt': 'text',
        'checkpoint': IMAGE_CKPT, 'seed': 4242, 'width': 1024, 'height': 1024, 'steps': 28, 'cfg': 3.5,
        'sampler': 'euler', 'scheduler': 'normal', 'outputPrefix': 'image/acceptance/session',
        'lyingSigma': {'factor': 0.5, 'startPercent': 0.2, 'endPercent': 0.6}},
        note='real-model lying-sigma A/B: same seed/settings at factor 0.0 vs 0.5 must measurably differ',
        draft=False),
]


# --------------------------------------------------------------------------- helpers
def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def log(lines, msg):
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%H:%M:%S')
    line = f'[{stamp}] {msg}'
    print(line, flush=True)
    lines.append(line)


# Processes that permanently hold VRAM on this desktop (compositor, browsers, capture, chat).
# They never mean "someone is generating": a DEAS run coexists with them fine.
DESKTOP_GPU_OWNERS = (
    'kwin_wayland', 'kwin_x11', 'Xwayland', 'Xorg', 'weston', 'gnome-shell', 'plasmashell',
    'xfwm4', 'sunway', 'brave', 'chrome', 'chromium', 'msedge', 'firefox', 'vivaldi',
    'discord', 'spotify', 'pipewire', 'pulseaudio', 'sunshine', 'mangohud', 'gamemoderun',
    'wayland', 'xfdesktop', 'kdeconnect', 'obs', 'waybar', 'hyprland', 'sway',
)


def gpu_state():
    """(util_percent, mem_used_mib, [(pid, name, mib), ...]) or None when nvidia-smi is unusable."""
    q = sh(['nvidia-smi', '--query-gpu=utilization.gpu,memory.used',
            '--format=csv,noheader,nounits'])
    apps = sh(['nvidia-smi', '--query-compute-apps=pid,process_name,used_memory',
               '--format=csv,noheader,nounits'])
    first = [l for l in q.stdout.splitlines() if l.strip()]
    if not first:
        return None
    parts = [x.strip() for x in first[0].split(',')]
    if len(parts) < 2:
        return None
    try:
        util, mem = int(float(parts[0])), int(float(parts[1]))
    except ValueError:
        return None
    holders = []
    for line in apps.stdout.splitlines():
        if not line.strip():
            continue
        cols = [c.strip() for c in line.split(',')]
        if len(cols) < 3:
            continue
        try:
            mib = int(float(cols[-1]))
        except ValueError:
            continue
        raw = cols[1] if len(cols) > 1 else '?'
        holders.append((cols[0], raw.strip().split()[0].split('/')[-1], mib))
    return util, mem, holders


def gpu_blockers(max_util=25, max_app_mib=1024, samples=3):
    """Why the GPU counts as busy: [] means it is free enough to start a throwaway backend.

    The desktop (compositor/browser/capture) permanently reserves VRAM here, so total
    memory.used is NOT a usable signal; what matters is whether any non-desktop process
    holds a generation-sized block of VRAM, and whether the GPU is actually computing.
    """
    reasons = []
    readings = []
    for i in range(samples):
        st = gpu_state()
        if st is None:
            return ['nvidia-smi returned no GPU data (driver or GPU missing?)']
        readings.append(st)
        if i < samples - 1:
            time.sleep(1.5)
    util = max(r[0] for r in readings)
    mem = max(r[1] for r in readings)
    holders = readings[-1][2]
    if util > max_util:
        reasons.append(f'GPU utilization {util}% (limit {max_util}%)')
    for pid, name, mib in holders:
        if mib >= max_app_mib and not any(k in name.lower() for k in DESKTOP_GPU_OWNERS):
            reasons.append(f'pid {pid} {name} holds {mib} MiB (limit {max_app_mib} MiB)')
    if not reasons and not holders and mem > 24000:
        reasons.append(f'memory.used {mem} MiB but nvidia-smi named no compute process; '
                       'the card looks reserved (pass --force to run anyway)')
    return reasons


def pick_port():
    listening = set()
    for line in sh(['ss', '-ltn']).stdout.splitlines():
        m = re.search(r'[:.](\d+)\s', line)
        if m:
            listening.add(int(m.group(1)))
    for port in (8197, 8196, 8195, 8194, 8193, 8192):
        if port not in listening and port != 8199:
            with socket.socket() as s:
                try:
                    s.bind(('127.0.0.1', port))
                    return port
                except OSError:
                    continue
    raise SystemExit('no free throwaway port; is another session running? (never kill foreign backends)')


def install_marker_test():
    """Temporary ignored Rust test that prints compile(&DEAS_INTENT). Auto-removed in cleanup."""
    path = SRC_TAURI / 'src' / 'jobs_video_tests.rs'
    body = f'''
{MARKER}
#[ignore]
#[test]
fn print_compiled_intent() {{
    let raw = std::env::var("DEAS_INTENT").expect("DEAS_INTENT");
    let intent: serde_json::Value = serde_json::from_str(&raw).expect("intent json");
    let graph = crate::jobs::compile(&intent).expect("compile");
    println!("COMPILED_INTENT_MARKER {{}}", serde_json::to_string(&graph).unwrap());
}}
'''
    orig = path.read_text()
    if 'print_compiled_intent' not in orig:
        path.write_text(orig + body)
    return path, orig


def remove_marker_test(path, orig):
    if path.read_text() != orig:
        path.write_text(orig)


def compile_intent(intent, logbuf):
    env = {**os.environ, 'DEAS_INTENT': json.dumps(intent)}
    out = sh(['cargo', 'test', '--lib', 'print_compiled_intent', '--', '--ignored', '--nocapture'],
             cwd=SRC_TAURI, env=env)
    for line in out.stdout.splitlines():
        if line.startswith('COMPILED_INTENT_MARKER '):
            return json.loads(line[len('COMPILED_INTENT_MARKER '):])
    tail = (out.stdout + out.stderr).strip().splitlines()[-4:]
    raise RuntimeError('compile failed: ' + ' | '.join(tail))


def http_json(base, path, body=None, timeout=60):
    req = urllib.request.Request(base + path,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=timeout))


# --------------------------------------------------------------------------- session
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--only', help='comma list of gate names or plan ids, e.g. V-14,P-02-stream-362f')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--precheck', action='store_true', help='compile-only, does not touch the GPU')
    ap.add_argument('--keep-backend', action='store_true', help='leave the throwaway backend up for manual follow-ups')
    ap.add_argument('--max-util', type=int, default=25,
                    help='GPU utilization %% ceiling for the idle check (default 25)')
    ap.add_argument('--max-app-mib', type=int, default=1024,
                    help='a non-desktop process holding more than this many MiB blocks the run '
                         '(default 1024; the compositor/browsers are always ignored)')
    ap.add_argument('--samples', type=int, default=3, help='utilization samples for the idle check')
    ap.add_argument('--force', action='store_true', help='start even if the GPU looks busy')
    args = ap.parse_args()

    if args.list:
        for g in GATES:
            print(f"{g['name']:32} item={g['item']:10} draft={g['draft']}  {g['note']}")
        return

    if not args.all and not args.only and not args.precheck:
        ap.error('choose --all, --only <gates>, --precheck or --list')

    wanted = set()
    if args.all or args.precheck:
        wanted = {g['name'] for g in GATES}
    if args.only:
        for tok in args.only.split(','):
            tok = tok.strip()
            want = {g['name'] for g in GATES if g['name'] == tok or g['item'].split('/')[0] == tok or g['item'] == tok}
            if not want:
                raise SystemExit(f'unknown gate: {tok} (see --list)')
            wanted |= want

    ts = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    outdir = OUT_ROOT / f'gpu-acceptance-{ts}'
    outdir.mkdir(parents=True, exist_ok=True)
    logbuf = []
    log(logbuf, f'session dir: {outdir}')

    # GPU gate (skipped for --precheck)
    backend = None
    base = None
    if not args.precheck:
        st = gpu_state()
        if st is None:
            raise SystemExit('nvidia-smi gave no GPU data; is the NVIDIA driver up? Nothing was started.')
        blockers = gpu_blockers(args.max_util, args.max_app_mib, samples=args.samples)
        holders = ', '.join(f'{h[1]}={h[2]}MiB' for h in st[2]) or 'none'
        detail = f'util={st[0]}% used={st[1]} MiB; holders: {holders}'
        if blockers:
            if args.force:
                log(logbuf, f'GPU busy but --force given: {"; ".join(blockers)}')
            else:
                log(logbuf, 'GPU busy: ' + '; '.join(blockers))
                log(logbuf, 'context: ' + detail)
                raise SystemExit('Nothing was started. Close the listed process (never kill foreign '
                                 'backends for you), or re-run when free. Flags: --max-util, '
                                 '--max-app-mib, --force (run anyway).')
        log(logbuf, f'GPU free enough: {detail}')
        port = pick_port()
        scratch = outdir / 'scratch'
        for sub in ('input', 'output', 'temp'):
            (scratch / sub).mkdir(parents=True, exist_ok=True)
        # stage a probe picture from the owner's input pool (copy, never move)
        pool = sorted((RESOURCES / 'input').glob('*.png')) or sorted((RESOURCES / 'input').glob('*.jpg'))
        if not pool:
            raise SystemExit(f'no probe images in {RESOURCES / "input"}')
        shutil.copy2(pool[0], scratch / 'input' / 'acceptance-a.png')
        log(logbuf, f'probe image: {pool[0].name} -> scratch/input/acceptance-a.png')
        backend = subprocess.Popen(
            [str(VENV_PY), '-u', 'main.py', '--port', str(port), '--listen', '127.0.0.1',
             '--extra-model-paths-config', str(MODELS_YAML),
             '--input-directory', str(scratch / 'input'),
             '--output-directory', str(scratch / 'output'),
             '--temp-directory', str(scratch / 'temp')],
            cwd=COMFY, stdout=open(outdir / 'backend.log', 'w'), stderr=subprocess.STDOUT)
        base = f'http://127.0.0.1:{port}'
        for _ in range(90):
            try:
                http_json(base, '/system_stats'); break
            except Exception:
                time.sleep(2)
        else:
            backend.terminate()
            raise SystemExit('throwaway backend never became ready; see backend.log')
        log(logbuf, f'throwaway backend ready on :{port} (pid {backend.pid})')

    marker_path, marker_orig = install_marker_test()
    results = []
    try:
        # phase 1: compile all selected intents against the current compiler
        index = model_index()
        compiled = {}
        for g in GATES:
            if g['name'] not in wanted:
                continue
            intent = g['intent']()
            miss = missing_models(intent, index)
            if miss:
                log(logbuf, f"SKIP {g['name']}: missing model files: {', '.join(miss)}")
                results.append(dict(name=g['name'], item=g['item'], status='skip_missing_model',
                                    error='; '.join(miss)))
                continue
            try:
                compiled[g['name']] = compile_intent(intent, logbuf)
                log(logbuf, f"COMPILE OK   {g['name']}")
            except Exception as e:
                log(logbuf, f"COMPILE FAIL {g['name']}: {e}")
                results.append(dict(name=g['name'], item=g['item'], status='compile_fail', error=str(e)[:400]))
        if args.precheck:
            log(logbuf, 'precheck finished (no GPU work submitted)')
        else:
            # phase 2: real runs, dependency order (cheapest first, P-02 monster last)
            sys.path.insert(0, str(DRIVER_SRC.parent))
            from gpu_intent_driver import Driver  # skill driver
            drv = Driver(base, str(SRC_TAURI), str(outdir / 'results.jsonl'))
            for g in GATES:
                if g['name'] not in wanted or g['name'] not in compiled:
                    continue
                log(logbuf, f"RUN  {g['name']} ({g['item']}) — {g['note']}")
                try:
                    r = drv.run(g['name'], g['intent'](), timeout=g.get('timeout', 7200))
                    results.append(r)
                    status = 'pass' if r.get('status') == 'success' and r.get('files') else 'check'
                    log(logbuf, f"DONE {g['name']}: status={r.get('status')} {r['seconds']}s "
                                f"vram={r['vram_peak_mib']}MiB ram={r['ram_peak_gib']}GiB files={len(r['files'])}")
                except Exception as e:
                    log(logbuf, f"RUN FAIL {g['name']}: {e}")
                    results.append(dict(name=g['name'], item=g['item'], status='run_fail', error=str(e)[:400]))
    finally:
        remove_marker_test(marker_path, marker_orig)
        sh(['cargo', 'fmt', '--quiet', str(marker_path)])
        if backend and not args.keep_backend:
            backend.terminate()
            try:
                backend.wait(10)
            except subprocess.TimeoutExpired:
                backend.kill()
            log(logbuf, 'throwaway backend stopped')
        # cleanup probe artifacts the Director may leave in the refmods root
        refmods = RESOURCES / 'models/refmods'
        if refmods.is_dir():
            for f in refmods.glob('deas-probe-*'):
                f.unlink(missing_ok=True)
                log(logbuf, f'cleaned {f.name}')
        summary = ['| gate | item | status | seconds | VRAM peak | RAM peak | files |', '|---|---|---|---|---|---|---|']
        for r in results:
            summary.append(f"| {r.get('name')} | {r.get('item','')} | {r.get('status')} | {r.get('seconds','')} "
                           f"| {r.get('vram_peak_mib','')} | {r.get('ram_peak_gib','')} | {len(r.get('files',[]))} |")
        summary.append('\nDraft-gated items (check the intent shape against the PLAN item before trusting): '
                       + ', '.join(g['name'] for g in GATES if g['draft'] and g['name'] in wanted))
        (outdir / 'summary.md').write_text('\n'.join(summary) + '\n')
        (outdir / 'session.log').write_text('\n'.join(logbuf) + '\n')
        print('\n'.join(summary))
        print(f'\nEvidence: {outdir}')


if __name__ == '__main__':
    main()
