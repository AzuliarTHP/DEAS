"""DEAS's image sampler adapter; no Detail Daemon or Matplotlib installation required.

Lying Sigma algorithm adapted from Jonseed/ComfyUI-Detail-Daemon,
revision 3394e44afea04ed0188fb37b21f0d9952469766b (credited there to blepping).

MIT License
Copyright (c) 2024 Jonseed

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""
import math


def lying_sigma_sampler(model, x, sigmas, *, lss_wrapped_sampler,
                        lss_dishonesty_factor, lss_startend_percent, **kwargs):
    start_percent, end_percent = lss_startend_percent
    sampling = model.inner_model.inner_model.model_sampling
    start_sigma = round(sampling.percent_to_sigma(start_percent), 4)
    end_sigma = round(sampling.percent_to_sigma(end_percent), 4)

    def model_wrapper(x, sigma, **extra_args):
        current = float(sigma.max().detach().cpu())
        if end_sigma <= current <= start_sigma:
            sigma = sigma * (1.0 + lss_dishonesty_factor)
        return model(x, sigma, **extra_args)

    # The selected core sampler may inspect these attributes during sampling.
    for name in ("inner_model", "sigmas"):
        if hasattr(model, name):
            setattr(model_wrapper, name, getattr(model, name))
    return lss_wrapped_sampler.sampler_function(
        model_wrapper, x, sigmas, **kwargs, **lss_wrapped_sampler.extra_options,
    )


class LyingSigmaSampler:
    CATEGORY = "DEAS/internal"
    RETURN_TYPES = ("SAMPLER",)
    FUNCTION = "wrap"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "sampler": ("SAMPLER",),
            "dishonesty_factor": ("FLOAT", {"default": 0.0, "min": -0.999, "max": 1.0, "step": 0.01}),
        }, "optional": {
            "start_percent": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 1.0, "step": 0.01}),
            "end_percent": ("FLOAT", {"default": 0.9, "min": 0.0, "max": 1.0, "step": 0.01}),
        }}

    @classmethod
    def wrap(cls, sampler, dishonesty_factor, *, start_percent=0.25, end_percent=0.9):
        if not (all(math.isfinite(v) for v in (dishonesty_factor, start_percent, end_percent))
                and -0.999 <= dishonesty_factor <= 1.0 and 0 <= start_percent < end_percent <= 1):
            raise ValueError("DEAS Lying Sigma requires factor -0.999..1 and 0 <= Start < End <= 1")
        if dishonesty_factor == 0:
            return (sampler,)
        # Core ComfyUI owns sampling. Import only when this capability executes.
        from comfy.samplers import KSAMPLER
        return (KSAMPLER(lying_sigma_sampler, extra_options={
            "lss_wrapped_sampler": sampler,
            "lss_dishonesty_factor": dishonesty_factor,
            "lss_startend_percent": (start_percent, end_percent),
        }, inpaint_options=sampler.inpaint_options),)


NODE_CLASS_MAPPINGS = {"DEAS_LyingSigmaSampler": LyingSigmaSampler}
