"""ComfyUI-GGUF layers inside Core's fused `linear_input_act` (Wan, LTX, MiniMax H3, Qwen Image 2.1...).

With fp16 accumulation on, Core casts the weight through the module-level `cast_bias_weight` and
hands it to comfy_kitchen's fp16 GEMM. ComfyUI-GGUF layers dequantize in their own
`cast_bias_weight` method, so the packed GGML tensor reached the GEMM and sampling failed with
`cutlass_fp16_linear: K mismatch`. For a layer that owns its cast, this sets Core's own
`comfy_force_forward` flag for the call, so Core takes its eager branch through the layer's
forward. Other layers are untouched; nothing is patched if Core has no `linear_input_act`.
"""
import comfy.ops

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

_UNSET = object()


def owns_cast(linear):
    return callable(getattr(type(linear), "cast_bias_weight", None))


def wrap(core):
    if core is None or getattr(core, "_deas_gguf_compat", False):
        return core

    def linear_input_act(linear, x, input_act, *args, **kwargs):
        if not owns_cast(linear):
            return core(linear, x, input_act, *args, **kwargs)
        previous = linear.__dict__.get("comfy_force_forward", _UNSET)
        linear.comfy_force_forward = True
        try:
            return core(linear, x, input_act, *args, **kwargs)
        finally:
            if previous is _UNSET:
                del linear.comfy_force_forward
            else:
                linear.comfy_force_forward = previous

    linear_input_act._deas_gguf_compat = True
    linear_input_act.__wrapped__ = core
    return linear_input_act


comfy.ops.linear_input_act = wrap(getattr(comfy.ops, "linear_input_act", None))
