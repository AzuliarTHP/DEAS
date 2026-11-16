# Lying Sigma for image generation

[Studio](STUDIO.md) · [Backend](BACKEND.md) · [Verification](VERIFICATION.md)

The advanced Image settings put **Lying Sigma** directly below Sampler/Scheduler
and above Seed. Its default is **0 = Off**, shown beside the Lying Sigma label.
Zero omits the modifier from submitted
intents and leaves the original execution graph and dependencies unchanged.

## Setup

The sampler is included in DEAS as a small backend adapter. The full
ComfyUI-Detail-Daemon pack and Matplotlib are **not required**, and there is no
extra installation or upgrade choice.

For a **DEAS-managed backend**, the existing backend-start flow copies the
bundled `deas_lying_sigma.py` adapter into its own ComfyUI `custom_nodes` folder
before launching the child. This works for new and existing managed environments
on Linux and Windows without changing the installation plan or Python packages.
After updating DEAS, start/restart the owned backend using its normal controls
and reload Studio capabilities. A running backend uses the adapter it loaded at
startup. Existing work/ownership guards still apply.

For an **external backend**, its owner can copy
[`lying_sigma.py`](../src-tauri/src/lying_sigma.py) to that backend's
`custom_nodes/deas_lying_sigma.py` and restart it through its own controls. No
additional Python requirements are introduced. DEAS does not modify or restart
external services.

The adapter registers only **`DEAS_LyingSigmaSampler`**. It does not replace the
original Detail Daemon registrations and can coexist with that pack. Its algorithm
is adapted from the MIT-licensed Lying Sigma implementation at revision
`3394e44afea04ed0188fb37b21f0d9952469766b`, credited there to blepping; the source
retains the license and attribution. ComfyUI's public `KSAMPLER` API performs the
sampling. The port preserves the selected sampler's options, inpaint options,
callback, input latent and sigma schedule; only the sigma reported to the model
inside the chosen interval changes.

If the adapter cannot be installed or its consumed ABI is unavailable, shared
Logs explain the error and nonzero Lying Sigma is blocked. Strength 0 and unrelated
pipelines remain available. No generation is queued by installation/discovery.

## Controls

| Control | Default | Meaning |
| --- | --- | --- |
| Lying Sigma | 0 | Signed dishonesty factor. The stepper changes it by 0.01, from -0.99 to 1; precise typed/restored values down to -0.999 remain supported. Zero disables it. Negative values can increase visible detail; positive values can soften it. |
| Start (%) | 25 | Beginning of the model sampling interval in which the sigma reported to the model is adjusted. |
| End (%) | 90 | End of that interval. Start must be less than End; both stay within 0–100%. |

New and reset settings use 25%–90%; previously saved timings retain their values.
The timing controls appear when strength is nonzero. They are model sampling
percentages, not literal step indices. With a partial-denoise image edit, the
chosen interval can lie outside the sigmas actually sampled and have little or
no effect.

The extension computes `reported_sigma = sigma * (1 + factor)` in the chosen
interval. A factor of -0.05 reports 95% of the current sigma to the model. It
does not directly inject fresh random noise. Fine texture may increase, but
excessive settings can produce grain or an oversharpened result; quality depends
on the model, sampler and input.

Changing the controls edits a draft. It never queues generation. Run captures the
exact factor and timing, together with the existing model, seed, conditioning,
LoRAs, mask, denoise and scheduler settings.

## Scope and limitations

- The modifier affects the main image sampling pass, including image-to-image
  and inpaint. Automatic second-pass refinement and standalone Refine/Upscale
  actions retain their existing sampling settings.
- Ordinary KSampler paths use core `RandomNoise`, `CFGGuider`, `KSamplerSelect`,
  `BasicScheduler` and `SamplerCustomAdvanced` with the selected sampler wrapped
  by `DEAS_LyingSigmaSampler`. Existing explicit/family sigma schedules retain their
  original noise, guider and sigma links.
- `dpm_2`, `dpm_2_ancestral`, `uni_pc` and `uni_pc_bh2` have special KSampler
  schedule handling. Nonzero Lying Sigma requires an explicit sigma schedule for
  those samplers, or selection of another sampler. DEAS does not silently alter
  the sampler or substitute a different schedule.
- A derived BasicScheduler schedule above 10,000 steps is rejected. Increase
  denoise or reduce steps when a very low image-to-image denoise triggers this.
- Preferences, model-session drafts and presets retain the controls. Recent-job
  history and Run Plan retain exact submitted values. Restoring an older job
  without the modifier resets it to 0. Recognized embedded ComfyUI graphs can
  restore a directly linked wrapper's exact values and sampler; malformed or
  unsupported wrapper metadata remains a disclosed partial restore.
- The existing basic image-project draft format does not persist this advanced
  setting. Opening a project resets it to 0; use a preset or recent-job settings
  to restore an explicit value.
- Graph fixtures cover checkpoint and Anima split-loader/inpaint paths and
  explicit schedules. Real model quality, timing/performance and native
  Linux/Windows interaction remain separate acceptance gates; this feature does
  not promise improvement for every architecture or sampling combination.

## Troubleshooting

**Missing node:** check the selected backend's environment, extension import
errors and central Logs, start the updated backend through its owner, and reload
capabilities. A node installed in another ComfyUI folder is insufficient.

**No visible change:** check strength, the sampling window and actual denoise
range. Compare the same prompt, model, seed and other settings with 0 versus one
explicit nonzero factor. Generation and any GPU quality comparison remain user
actions.

**Too much texture:** move the factor toward 0 or narrow the window. Returning to
0 restores the original recipe.
