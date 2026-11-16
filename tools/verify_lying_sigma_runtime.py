"""Exercise the bundled sampler with real ComfyUI KSAMPLER and tiny CPU tensors.

Run with the selected environment's Python, passing its ComfyUI directory.
No listener, custom-node-pack import, model load or image generation.
"""
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace

comfy = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(comfy))
sys.argv = ['main.py', '--cpu']
import torch
from comfy.samplers import KSAMPLER

source = Path(__file__).resolve().parents[1] / 'src-tauri/src/lying_sigma.py'
spec = importlib.util.spec_from_file_location('deas_lying_sigma_runtime_probe', source)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
sampling = SimpleNamespace(percent_to_sigma=lambda percent: 10 * (1 - percent))
x = torch.zeros((1, 4, 2, 2), device='cpu')
schedule = torch.tensor([9, 7.5, 5, 1, 0.5], device='cpu')
unchanged = schedule.clone()
observed = []
extra_args = {'seed': 42, 'denoise_mask': object()}
callback = object()


class Model:
    inner_model = SimpleNamespace(inner_model=SimpleNamespace(model_sampling=sampling))
    sigmas = schedule
    def __call__(self, latent, sigma, **kwargs):
        assert latent is x and kwargs['sentinel'] is extra_args
        observed.append(float(sigma))
        return latent


model = Model()


def selected(model_wrapper, latent, sigmas, **kwargs):
    assert model_wrapper.inner_model is model.inner_model
    assert model_wrapper.sigmas is schedule
    assert latent is x and sigmas is schedule
    assert kwargs == {'extra_args': extra_args, 'callback': callback, 'disable': True, 'eta': 0.75}
    for sigma in sigmas:
        model_wrapper(x, sigma, sentinel=extra_args)
    return latent


original = KSAMPLER(selected, extra_options={'eta': 0.75}, inpaint_options={'random': True})
assert adapter.LyingSigmaSampler.wrap(original, 0)[0] is original
for factor, expected in [(-0.1, [9, 6.75, 4.5, 0.9, 0.5]), (0.1, [9, 8.25, 5.5, 1.1, 0.5])]:
    observed.clear()
    wrapped, = adapter.LyingSigmaSampler.wrap(original, factor)
    assert isinstance(wrapped, KSAMPLER)
    assert wrapped.inpaint_options is original.inpaint_options
    result = wrapped.sampler_function(model, x, schedule, extra_args=extra_args,
        callback=callback, disable=True, **wrapped.extra_options)
    assert result is x and torch.equal(schedule, unchanged)
    torch.testing.assert_close(torch.tensor(observed), torch.tensor(expected))
assert original.extra_options == {'eta': 0.75}
assert 'matplotlib' not in sys.modules
assert not any('detail_daemon' in name for name in sys.modules)
print(json.dumps({'status': 'PASS', 'node': list(adapter.NODE_CLASS_MAPPINGS),
    'torch': torch.__version__, 'coreSampler': KSAMPLER.__module__, 'device': 'cpu',
    'neutralIdentity': True, 'inpaintOptions': 'preserved', 'schedule': 'unchanged',
    'customPacksImported': False, 'generation': False}))
