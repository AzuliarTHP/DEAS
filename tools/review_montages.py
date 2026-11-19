"""Frame-accurate A/B montages for the owner's visual calls.

Note: `-ss` before `-i` is keyframe-accurate only, so two different AV1 files land on different
frames. Everything here selects by frame number after a full decode instead.
"""
from pathlib import Path
import subprocess, tempfile, os
from PIL import Image, ImageDraw

import sys

SESSION = Path(sys.argv[1] if len(sys.argv) > 1 else
               'artifacts/verification/gpu-acceptance-20261119T103208Z').resolve()
BASE = SESSION / 'scratch/output/video/acceptance'
OUT = SESSION / 'review'
OUT.mkdir(parents=True, exist_ok=True)
FPS = 24


def frame(video, n):
    tmp = tempfile.mkdtemp()
    out = os.path.join(tmp, 'f.png')
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(BASE / video),
                    '-vf', f'select=eq(n\\,{n})', '-fps_mode', 'passthrough', '-update', '1',
                    '-frames:v', '1', out],
                   check=True)
    return Image.open(out).convert('RGB')


def canvas(panels, labels, cols):
    w, h = max(p.width for p in panels), max(p.height for p in panels)
    rows = (len(panels) + cols - 1) // cols
    pad, lab = 8, 24
    sheet = Image.new('RGB', (cols * w + (cols + 1) * pad, rows * (h + lab) + (rows + 1) * pad), (24, 24, 28))
    draw = ImageDraw.Draw(sheet)
    for i, (p, l) in enumerate(zip(panels, labels)):
        r, c = divmod(i, cols)
        x, y = pad + c * (w + pad), pad + r * (h + lab + pad)
        sheet.paste(p, (x, y + lab))
        draw.text((x + 2, y + 4), l, fill=(235, 235, 235))
    return sheet


def save(name, sheet, note=None):
    path = OUT / name
    if note:
        bar = Image.new('RGB', (sheet.width, 46), (18, 18, 22))
        merged = Image.new('RGB', (sheet.width, sheet.height + 46), (18, 18, 22))
        merged.paste(bar, (0, 0))
        ImageDraw.Draw(merged).text((10, 14), note, fill=(250, 220, 120))
        merged.paste(sheet, (0, 46))
        sheet = merged
    sheet.save(path)
    print(f'{name}: {sheet.size}')


PAIRS = [
    ('p03-face-refine-zoom.png',
     ('session_original_00006_audio.mp4', 'session_00012_audio.mp4'),
     ('baseline (no face refine)', 'H3 face refine (auto, whole video)'),
     (40, 72, 108),
     (296, 121, 832, 480), 2,
     'P-03 zoomed to the measured change region; only 1.61% of pixels differ, region sharpness 340.9 vs 340.5'),
    ('p04-derope-ab.png',
     ('session_original_00005_audio.mp4', 'session_00011_audio.mp4'),
     ('baseline (no de-rope)', 'de-rope balanced, inject 0.48'),
     (12, 60, 115), None, 1,
     'P-04 same seed: PSNR 27.8 vs baseline, temporal diff 8.23 vs 8.04, whole-frame sharpness 201 vs 249 (softer)'),
    ('v13-dials-vs-control.png',
     ('session_00001_audio.mp4', 'session_00005_audio.mp4'),
     ('V-12 control, no dial', 'V-13 dial h3_evil_cold at strength 1.5'),
     (12, 60, 115), None, 1,
     'V-13 same seed and prompt: PSNR 17.9 / SSIM 0.67, so the dial changes the result'),
    ('v17-auto-vs-fill-crop.png',
     ('session_00003_audio.mp4', 'session_00004_audio.mp4'),
     ('V-17 input scaling: Auto', 'V-17 input scaling: Fill and crop'),
     (0, 60, 115), None, 1,
     'V-17 same seed: PSNR 14.5 / SSIM 0.56, Auto showed no padding bars (outer-ring luma 57.8)'),
]
for name, (a, b), (la, lb), numbers, box, scale, note in PAIRS:
    panels, labels = [], []
    for n in numbers:                      # frame numbers, not seconds: seeks must be exact
        for video, label in ((a, la), (b, lb)):
            im = frame(video, n)
            if box:
                im = im.crop(box)
                im = im.resize((im.width * scale, im.height * scale), Image.LANCZOS)
            panels.append(im)
            labels.append(f'{label} — frame {n}')
    save(name, canvas(panels, labels, 2), note)

# single-frame comparison pairs (same frame index in both files)
SINGLES = [
    ('v14-latent-upscale-vs-lanczos.png', 'session_00007_audio.mp4', 'session_original_00001_audio.mp4',
     (1664, 960), 60,
     'V-14 learned 3D-conv latent upscale (sharpness 84.1) vs LANCZOS enlargement of the same baseline (24.4)',
     'processed: latent upscale', 'control: baseline LANCZOS -> 1664x960'),
    ('v16-regenerate-2k-vs-lanczos.png', 'session_00008_audio.mp4', 'session_original_00002_audio.mp4',
     (2560, 1440), 60,
     'V-16 Hi-Res Regenerate 2K, tiled path (sharpness 162.6) vs LANCZOS enlargement (5.6)',
     'processed: regenerate 2K (tiled)', 'control: baseline LANCZOS -> 2560x1440'),
]
for name, processed, baseline, size, n, note, lp, lc in SINGLES:
    proc = frame(processed, n)
    ctrl = frame(baseline, n).resize(size, Image.LANCZOS)
    save(name, canvas([proc, ctrl], [f'{lp} — frame {n}', f'{lc} — frame {n}'], 1), note)

# V-11 seam: first and last frame of the looped output (already frame-accurate)
save('v11-loop-seam.png',
     canvas([frame('session_00009_audio.mp4', 0), frame('session_00009_audio.mp4', 108),
             frame('session_original_00003_audio.mp4', 0), frame('session_original_00003_audio.mp4', 123)],
            ['loop output n=0', 'loop output n=108 (seam)', 'baseline n=0', 'baseline n=123'], 2),
     'V-11 seam PSNR first vs last: loop 34.2 dB, unlooped baseline 17.7 dB (124 -> 109 frames)')
