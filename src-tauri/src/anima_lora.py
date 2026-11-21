"""Per-job Anima LoRA compatibility using ComfyUI's regular Safetensors loader."""

import inspect
import logging
import os
import re

# The 40-block layout preserves the order of the 28 base blocks and inserts
# new blocks at these positions.
_INSERTED = {2, 5, 8, 11, 14, 17, 21, 24, 27, 30, 33, 36}
_EXPANDED = tuple(index for index in range(40) if index not in _INSERTED)
_MODEL_BLOCK = re.compile(r"^diffusion_model\.blocks\.([0-9]+)\.")
_LORA_BLOCK = re.compile(r"^(lora_unet_blocks_|(?:diffusion_model\.)?blocks\.)([0-9]+)([._])")
_LOG = logging.getLogger(__name__)


def remap_anima_lora(tensors, model_keys):
    """Return a new key table only for the known 28-to-40 block layout."""
    model_blocks = {int(match[1]) for key in model_keys if (match := _MODEL_BLOCK.match(key))}
    if model_blocks != set(range(40)) or not any(
        key.startswith("diffusion_model.llm_adapter.") for key in model_keys
    ):
        return tensors

    matches = {key: match for key in tensors if (match := _LORA_BLOCK.match(key))}
    if {int(match[2]) for match in matches.values()} != set(range(len(_EXPANDED))):
        return tensors

    remapped = {}
    for key, value in tensors.items():
        match = matches.get(key)
        if match:
            prefix = "diffusion_model.blocks." if match[1] == "blocks." else match[1]
            key = f"{prefix}{_EXPANDED[int(match[2])]}{match[3]}{key[match.end():]}"
        if key in remapped:
            raise ValueError("Anima LoRA contains overlapping block aliases")
        remapped[key] = value
    return remapped


class AnimaLoraLoader:
    """Load a LoRA normally, with an explicit compatibility node for Anima."""

    RETURN_TYPES = ("MODEL", "CLIP")
    FUNCTION = "load_lora"
    CATEGORY = "DEAS/model"

    def __init__(self):
        self.loaded = None

    @classmethod
    def INPUT_TYPES(cls):
        import folder_paths

        strength = {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.05}
        return {"required": {
            "model": ("MODEL",),
            "clip": ("CLIP",),
            "lora_name": ([name for name in folder_paths.get_filename_list("loras")
                           if name.lower().endswith(".safetensors")],),
            "strength_model": ("FLOAT", strength),
            "strength_clip": ("FLOAT", strength),
        }}

    def load_lora(self, model, clip, lora_name, strength_model, strength_clip):
        import comfy.sd
        import comfy.utils
        import folder_paths

        if strength_model == 0 and strength_clip == 0:
            return (model, clip)
        path = folder_paths.get_full_path_or_raise("loras", lora_name)
        if not path.lower().endswith(".safetensors"):
            raise ValueError("Anima LoRA compatibility requires Safetensors")
        stat = os.stat(path)
        stamp = (path, stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
        if self.loaded is None or self.loaded[0] != stamp:
            self.loaded = None
            supports_metadata = (
                "return_metadata" in inspect.signature(comfy.utils.load_torch_file).parameters
                and "lora_metadata" in inspect.signature(comfy.sd.load_lora_for_models).parameters
            )
            if supports_metadata:
                weights, metadata = comfy.utils.load_torch_file(path, safe_load=True, return_metadata=True)
            else:
                weights = comfy.utils.load_torch_file(path, safe_load=True)
                metadata = None
            self.loaded = (stamp, weights, metadata)
        _, weights, metadata = self.loaded
        adjusted = remap_anima_lora(weights, model.model.state_dict().keys())
        if adjusted is not weights:
            _LOG.info("DEAS Anima LoRA loader remapped 28 base blocks onto the 40-block Anima layout")
        kwargs = {"lora_metadata": metadata} if metadata is not None else {}
        return comfy.sd.load_lora_for_models(model, clip, adjusted, strength_model, strength_clip, **kwargs)


NODE_CLASS_MAPPINGS = {"DEAS_AnimaLoraLoader": AnimaLoraLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"DEAS_AnimaLoraLoader": "Anima 2.9B LoRA Compatibility (DEAS)"}
