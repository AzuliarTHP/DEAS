"""Owned-backend adapter: clean saver suffixes only for marked DEAS submissions."""
import copy
import functools
import json
import os
from pathlib import Path
import re

import folder_paths
import nodes
from server import PromptServer

# `prefix_00001_.png` (image savers), `prefix_00001_audio.webm` and its `-first-frame.png` (video combine).
SAVED = re.compile(r"(.+)_(\d{5,})_?(audio)?(.*)\.(\w+)")
# Windows rename is atomic and refuses an existing destination, including on exFAT.
_USE_RENAME = os.name == "nt"
SAVERS = ("SaveImage", "DaSiWa_MetadataImageSaver", "DaSiWa_EnhancedVideoCombine")


def publish(files):
    """Publish a save group without clobbering existing files; roll back partial groups."""
    counter = int(files[0][1].group(2))
    while True:
        done = []
        try:
            for source, match in files:
                prefix, _, audio, rest, extension = match.groups()
                target = source.with_name(f"{prefix}-{counter:05}{'-audio' if audio else ''}{rest}.{extension}")
                if _USE_RENAME:
                    # Unlike POSIX rename, Windows rename fails if target already exists.
                    # This supports exFAT, which cannot publish through hard links.
                    os.rename(source, target)
                else:
                    os.link(source, target)
                done.append((source, target))
            break
        except BaseException as error:
            rollback_failed = False
            for source, target in done:
                try:
                    if _USE_RENAME:
                        os.rename(target, source)
                    else:
                        target.unlink()
                except OSError as cleanup_error:
                    error.add_note(f"DEAS output naming rollback failed for {target}: {cleanup_error}")
                    rollback_failed = True
            if not isinstance(error, FileExistsError) or rollback_failed:
                raise
            counter += 1
    if not _USE_RENAME:
        for source, _ in files:
            source.unlink()
    return {source.name: target.name for source, target in done}


def wrap_save(save):
    @functools.wraps(save)
    def run(self, *args, **kwargs):
        marked = (kwargs.get("extra_pnginfo") or {}).get("deas_output_naming")
        if marked:
            # Comfy adds NaN cache fingerprints during execution; these are not generation settings.
            kwargs = dict(kwargs)
            if isinstance(kwargs.get("prompt"), dict):
                prompt = copy.deepcopy(kwargs["prompt"])
                for node in prompt.values():
                    if isinstance(node, dict):
                        node.pop("is_changed", None)
                kwargs["prompt"] = prompt
            kwargs["extra_pnginfo"] = copy.deepcopy(kwargs["extra_pnginfo"])
            # Refuse any remaining non-finite setting before a saver can publish non-standard JSON.
            json.dumps({key: kwargs.get(key) for key in ("prompt", "extra_pnginfo")}, allow_nan=False)
        result = save(self, *args, **kwargs)
        if not marked:
            return result
        ui = result.get("ui", {})
        assets = [a for key in ("images", "gifs") for a in ui.get(key, []) if a["type"] == "output"]
        groups = {}
        for asset in assets:
            match = SAVED.fullmatch(asset["filename"])
            if match:
                path = Path(folder_paths.get_output_directory()) / asset["subfolder"] / asset["filename"]
                groups.setdefault((asset["subfolder"], match.group(1), match.group(2)), {})[path] = match
        renamed = {}
        for group in groups.values():
            published = publish(list(group.items()))
            renamed.update((path, published[path.name]) for path in group)
        for asset in assets:
            path = Path(folder_paths.get_output_directory()) / asset["subfolder"] / asset["filename"]
            asset["filename"] = renamed.get(path, asset["filename"])
        if "result" in result:
            # The video combine also returns its saved path (read by the continuity publisher).
            result["result"] = tuple(
                str(Path(v).with_name(renamed[Path(v)]))
                if isinstance(v, str) and Path(v) in renamed else v
                for v in result["result"]
            )
        return result
    return run


def prepare(data):
    if data.get("extra_data", {}).get("extra_pnginfo", {}).get("deas_output_naming"):
        for name in SAVERS:
            cls = nodes.NODE_CLASS_MAPPINGS.get(name)
            function = getattr(cls, "FUNCTION", None)
            save = getattr(cls, function, None) if isinstance(function, str) else None
            if callable(save) and not getattr(save, "_deas_naming", False):
                wrapped = wrap_save(save)
                wrapped._deas_naming = True
                setattr(cls, cls.FUNCTION, wrapped)
    return data


PromptServer.instance.add_on_prompt_handler(prepare)
NODE_CLASS_MAPPINGS = {}
