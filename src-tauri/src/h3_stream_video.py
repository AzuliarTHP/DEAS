"""DEAS-owned synchronous H3 pixel decode/export; importable without Core or torch."""
import contextlib
import errno
import json
import math
import os
from pathlib import Path
import shutil
import sys
import tempfile
from fractions import Fraction


class CodecFailure(RuntimeError):
    """Only failures originating in codec operations may trigger a fresh decode."""


class ValidationFailure(ValueError):
    """A finished encode failed DEAS's own readback checks.

    Container tags are written and read back differently per codec/container combination, so
    this class of failure is retryable with the next candidate rather than fatal: a decode of
    hundreds of frames must never end with no product at all.
    """

    def __init__(self, message, *, diagnosis=None, stage=None):
        super().__init__(message)
        self.diagnosis = diagnosis if diagnosis is not None else {}
        self.stage = str(stage) if stage else None


def _codec(call, *args, configuration=False, **kwargs):
    import av
    try:
        return call(*args, **kwargs)
    except av.FFmpegError as error:
        resource_error = any(text in str(error).casefold() for text in
                             ('out of memory', 'cannot allocate memory', 'not enough memory',
                              'no space left', 'disk quota', 'input/output error'))
        if resource_error or abs(error.errno or 0) in {errno.ENOMEM, errno.ENOSPC, errno.EDQUOT, errno.EIO, errno.EINTR, errno.EACCES}:
            raise
        raise CodecFailure(str(error)) from error
    except ValueError as error:
        # PyAV rejects unsupported container/codec pairs before FFmpeg is called.
        if not configuration:
            raise
        raise CodecFailure(str(error)) from error


def available_memory():
    import psutil
    available = psutil.virtual_memory().available
    # Both the current cgroup and its parents can impose the effective limit.
    try:
        line = next(line for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
        group = Path('/sys/fs/cgroup') / line.split('::', 1)[1].lstrip('/')
        while group.is_relative_to('/sys/fs/cgroup'):
            maximum = (group / 'memory.max').read_text().strip()
            if maximum != 'max':
                available = min(available, max(0, int(maximum) - int((group / 'memory.current').read_text())))
            if group == Path('/sys/fs/cgroup'):
                break
            group = group.parent
    except (OSError, StopIteration, ValueError):
        pass
    return int(available)


def _admit(shape, directory, audio, bit_depth, endpoints):
    frame = shape[3] * shape[4] * 3
    audio_bytes = 0 if audio is None else audio[0].nbytes
    # Decoder activations are Core-owned; reserve frame conversion and codec queues here.
    memory = frame * 4 * 40 + audio_bytes * 2 + endpoints * frame * 4
    if memory > available_memory() * .75:
        raise MemoryError('Insufficient available RAM for bounded H3 export buffers')
    required_disk = frame * shape[2] * (2 if bit_depth == 10 else 1) + audio_bytes * 2 + endpoints * frame * 4
    if required_disk > shutil.disk_usage(directory).free * .75:
        raise OSError(errno.ENOSPC, 'Insufficient free disk for private H3 export')


# Matroska-family containers silently drop metadata keys that are not ALL UPPERCASE: measured
# against the shipped ffmpeg (libavformat matroska muxer), writing 'prompt'/'workflow' into MKV
# or WebM yields no user tags at all, while 'PROMPT' and 'DEAS' survive at 260 KB. DEAS writes
# lowercase provenance keys, so an Auto-codec H3 export (AV1 -> Matroska) used to fail its own
# readback check after a full generation. Provenance therefore goes into one uppercase envelope
# tag for those containers; MP4 keeps the per-key tags that already work.
MATROSKA_FAMILY = ('MKV', 'WebM')
ENVELOPE_TAG = 'DEAS'


def _container_tags(container_name, metadata):
    """The tag dictionary this container can actually carry."""
    if not metadata:
        return None
    if container_name in MATROSKA_FAMILY:
        return {ENVELOPE_TAG: metadata}
    return metadata


def _validate_video(path, shape, count, rate, audio, audio_encoder, metadata, interrupt,
                    metadata_strict=True, container_name=None):
    """Verify the encoded file; returns metadata problems when metadata_strict is False."""
    problems = []
    import av
    with av.open(str(path)) as media:
        if len(media.streams.video) != 1:
            raise ValueError('Export must contain one video stream')
        stream = media.streams.video[0]
        if (stream.width, stream.height) != (shape[4], shape[3]):
            raise ValueError('Encoded video dimensions differ')
        seen = 0
        for frame in media.decode(video=0):
            interrupt()
            if frame.pts is None or abs(Fraction(frame.pts) * frame.time_base - Fraction(seen, 1) / rate) > max(Fraction(1, 1000), Fraction(1, 1) / rate / 100):
                raise ValueError('Encoded video timing differs')
            seen += 1
        if seen != count:
            raise ValueError('Encoded video frame count differs')
        tags = dict(media.metadata)
        for key, value in (_container_tags(container_name, metadata) or {}).items():
            name = str(key)
            written = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
            read = next((v for k, v in tags.items() if k.casefold() == name.casefold()), None)
            problem = None
            if read is None:
                problem = (f"metadata key {name!r} is absent after readback ({len(written)} "
                           f"characters were written; the container reported "
                           f"{sorted(tags) or 'no user tags'})")
            else:
                try:
                    parsed = json.loads(read)
                except ValueError as error:
                    problem = (f"metadata key {name!r} read back as invalid JSON ({error}); read "
                               f"starts with {read[:60]!r}")
                else:
                    # ComfyUI prompt graphs carry `is_changed: [NaN]`, and NaN never equals
                    # itself, so object equality rejects provenance that came back byte for byte
                    # (measured 2026-11-19: all seven encoder candidates were rejected this way
                    # and only the last, lenient one published). Canonical re-serialization is
                    # the honest comparison: the bytes are what the container is expected to keep.
                    if read == written or json.dumps(parsed, separators=(",", ":"),
                                                     ensure_ascii=False) == written:
                        continue
                    offset = next((i for i, (a, b) in enumerate(zip(written, read)) if a != b),
                                  min(len(written), len(read)))
                    window = slice(max(0, offset - 24), offset + 24)
                    problem = (f"metadata key {name!r} differs after readback ({len(read)} "
                               f"characters read against {len(written)} written; first difference "
                               f"at character {offset}; wrote {written[window]!r}, read "
                               f"{read[window]!r})")
            if metadata_strict:
                raise ValidationFailure(f'Encoded {problem}',
                                        diagnosis={'key': name,
                                                   'container': container_name,
                                                   'written_characters': len(written),
                                                   'read_characters': None if read is None else len(read),
                                                   'container_tags': sorted(tags)},
                                        stage=path)
            problems.append(problem)
    if audio is not None and audio_encoder:
        with av.open(str(path)) as media:
            if len(media.streams.audio) != 1:
                raise ValueError('Encoded audio missing')
            stream = media.streams.audio[0]
            samples = 0
            start = previous_end = None
            for frame in media.decode(audio=0):
                interrupt()
                if frame.pts is None:
                    raise ValueError('Encoded audio has no timestamp')
                timestamp = frame.pts * frame.time_base
                if start is None:
                    start = timestamp
                if previous_end is not None and abs(timestamp - previous_end) > Fraction(1, 1000):
                    raise ValueError('Encoded audio timeline has a gap')
                previous_end = timestamp + Fraction(frame.samples, frame.sample_rate)
                samples += frame.samples
            wanted = round(Fraction(audio[0].shape[1] * stream.rate, audio[1]))
            padding = {'aac': 1024, 'libopus': 960, 'libmp3lame': 1152}.get(audio_encoder, 1)
            declared = None if stream.duration is None else stream.duration * stream.time_base * stream.rate
            if start is None or abs(start) > Fraction(1, 1000) or not wanted <= samples < wanted + padding:
                raise ValueError('Encoded audio sample coverage differs')
            if declared is not None and abs(declared - wanted) > 1:
                raise ValueError('Encoded audio presentation duration differs')
    return problems


def encode_stream(decode, shape, output_path, helper, *, container_name, encoder,
                  frame_rate, bit_depth, quality, audio=None, audio_encoder=None,
                  audio_bitrate='192k', metadata=None, interrupt=lambda: None,
                  crop_to_audio=False, save_first_frame=False, save_last_frame=False,
                  metadata_strict=True, on_warning=None):
    """Decode anew for this attempt; publish only validated output, never overwrite.

    With metadata_strict False a metadata-tag round-trip problem is reported through
    on_warning and the file is still published; every other check stays fatal. Set
    DEAS_H3_KEEP_FAILED=1 to keep a rejected stage file next to the intended output for
    diagnosis (off by default: that file can be gigabytes).
    """
    import av
    import torch
    from PIL import Image
    target = Path(output_path)
    if target.exists():
        raise FileExistsError(target)
    shape = tuple(shape)
    FrameSink(shape, lambda frame: None, interrupt)
    rate = helper._rate(frame_rate)
    if rate <= 0 or bit_depth not in (8, 10):
        raise ValueError('Invalid video rate or bit depth')
    count = shape[2]
    if crop_to_audio and audio is not None:
        count = min(count, math.ceil(Fraction(audio[0].shape[1], audio[1]) * rate))
    if count <= 0:
        raise ValueError('Video has no frames')
    _admit(shape, target.parent, audio, bit_depth, int(save_first_frame) + int(save_last_frame))
    published = []
    interrupt()
    with tempfile.TemporaryDirectory(prefix='.deas-h3-', dir=target.parent) as directory:
        stage = Path(directory) / target.name
        output = None
        exports = []
        try:
            options = {'movflags': '+faststart+use_metadata_tags', 'movie_timescale': '48000'} if container_name == 'MP4' else {'loop': '0'} if container_name == 'Animated WebP' else {}
            output = _codec(av.open, str(stage), 'w', format=helper.FORMAT_NAMES[container_name], options=options)
            helper._metadata(output, _container_tags(container_name, metadata))
            video = _codec(helper._configure_video_stream, output, encoder, shape[4], shape[3], frame_rate, bit_depth, quality, configuration=True)
            video.codec_context.thread_count = 1
            audio_stream = None
            if audio is not None and audio_encoder:
                audio_stream, audio_rate = _codec(helper._configure_audio_stream, output, audio_encoder, audio[1], audio[0].shape[0], audio_bitrate, configuration=True)
            encoded = 0
            def consume(frame):
                nonlocal encoded
                interrupt()
                if encoded >= count:
                    return
                if shutil.disk_usage(directory).free <= frame.numel() * 4:
                    raise OSError(errno.ENOSPC, 'Disk exhausted during H3 export')
                if bit_depth == 10:
                    array = torch.round(frame * 1023).to(torch.int32).mul_(64).to(torch.uint16).numpy()
                else:
                    array = torch.round(frame * 255).to(torch.uint8).numpy()
                for packet in _codec(video.encode, _codec(helper._video_frame, array, encoded, rate, bit_depth)):
                    _codec(output.mux, packet)
                for suffix, enabled in (('first', save_first_frame and encoded == 0), ('last', save_last_frame and encoded == count - 1)):
                    if enabled:
                        endpoint = Path(directory) / f'{target.stem}-{suffix}-frame.png'
                        pixels = torch.round(frame * 255).to(torch.uint8).numpy()
                        Image.fromarray(pixels).save(endpoint, 'PNG')
                        exports.append(endpoint)
                encoded += 1
            sink = FrameSink(shape, consume, interrupt)
            decode(sink)
            sink.finish()
            if encoded != count:
                raise ValueError('H3 export ended early')
            interrupt()
            for packet in _codec(video.encode, None):
                interrupt()
                _codec(output.mux, packet)
            if audio_stream is not None:
                _codec(helper._encode_audio, _InterruptMux(output, interrupt), audio_stream, audio, audio_rate)
            interrupt()
            _codec(output.close)
            output = None
            try:
                problems = _validate_video(stage, shape, count, rate, audio, audio_encoder,
                                          metadata, interrupt, metadata_strict=metadata_strict,
                                          container_name=container_name)
            except ValidationFailure as error:
                if os.environ.get('DEAS_H3_KEEP_FAILED'):
                    keep = target.parent / f'{target.stem}.validation-failed-{encoder}{target.suffix}'
                    if keep.exists():
                        keep.unlink()
                    stage.rename(keep)
                    error.stage, error.diagnosis['retained'] = str(keep), str(keep)
                raise
            for problem in problems or ():
                if on_warning is not None:
                    on_warning(f'{container_name}/{encoder}: {problem}')
            for endpoint in exports:
                with Image.open(endpoint) as check:
                    check.verify()
            interrupt()
            for source in [*exports, stage]:
                destination = target.parent / source.name
                # Windows rename and POSIX links atomically refuse existing destinations.
                if os.name == 'nt':
                    os.rename(source, destination)
                else:
                    os.link(source, destination)
                published.append(destination)
            return [str(path) for path in published[:-1]]
        except BaseException:
            for path in published:
                path.unlink()
            raise
        finally:
            if output is not None:
                with contextlib.suppress(Exception):
                    output.close()


class _InterruptMux:
    def __init__(self, output, interrupt):
        self.output, self.interrupt = output, interrupt

    def mux(self, packet):
        self.interrupt()
        return self.output.mux(packet)



def _pack():
    import folder_paths
    expected = (Path(folder_paths.base_path) / 'custom_nodes/ComfyUI-DaSiWa-Nodes/nodes/nodes_enhanced_video_combine.py').resolve()
    for module in tuple(sys.modules.values()):
        path = getattr(module, '__file__', None)
        if path and Path(path).resolve() == expected and hasattr(module, 'DaSiWa_EnhancedVideoCombine'):
            return module
    raise RuntimeError('Installed DaSiWa Enhanced Video Combine must be loaded before H3 streaming export')


def validate_h3(vae, video):
    import ast
    import hashlib
    import inspect
    import textwrap
    import torch
    from comfy.ldm.minimax.vae import MiniMaxH3VideoVAE
    model = vae.first_stage_model
    if type(model) is not MiniMaxH3VideoVAE or model.noncausal:
        raise ValueError('Streaming requires the stock causal MiniMaxH3VideoVAE; Sol and image VAEs are unsupported')
    if not isinstance(video, torch.Tensor) or video.is_nested or video.ndim != 5 or tuple(video.shape[:2]) != (1, 24) or min(video.shape) <= 0 or not video.is_floating_point():
        raise ValueError('Expected one H3 video latent with shape [1,24,T,H,W]')
    names = ('_finalize_pixels', 'decode_output_shape', 'blend', '_decode_temporal_pad_frames',
             '_decode_temporal_frame_plan', '_decode_temporal_chunks', 'decode_temporal', 'decode')
    dumps = []
    for name in names:
        method = getattr(model, name)
        if getattr(method, '__func__', None) is not getattr(MiniMaxH3VideoVAE, name):
            raise ValueError('Patched H3 decoder entry points are unsupported')
        dumps.append(ast.dump(ast.parse(textwrap.dedent(inspect.getsource(method))).body[0], include_attributes=False))
    # Pin the private sink protocol, normalization and raw-blend/pad/trim algorithm together.
    if hashlib.sha256('\n'.join(dumps).encode()).hexdigest() != 'bc97cd6159eae9537a32df3220e262b8ecdc8f653b3cbb1168c0efb61187f124':
        raise ValueError('Core H3 decode contract changed; revalidate streaming before use')
    probe = torch.tensor([-1., .25, 2.])
    if vae.process_output(probe) is not probe or not torch.equal(probe, torch.tensor([-1., .25, 2.])) or vae.vae_output_dtype() != torch.float32:
        raise ValueError('Streaming requires native H3 identity float32 output processing')
    shape = tuple(model.decode_output_shape(tuple(video.shape)))
    FrameSink(shape, lambda frame: None, lambda: None)
    return shape


class DEAS_H3StreamVideoSave:
    @classmethod
    def INPUT_TYPES(cls):
        import copy
        schema = copy.deepcopy(_pack().DaSiWa_EnhancedVideoCombine.INPUT_TYPES())
        required = schema['required']
        for name in ('images', 'pingpong', 'pass_frames'):
            required.pop(name)
        schema['required'] = {'samples': ('LATENT', {'lazy': True}), 'vae': ('VAE',), 'audio_vae': ('VAE',), **required}
        schema['optional'].pop('audio')
        schema['optional']['baseline'] = ('STRING', {'default': '', 'forceInput': True})
        return schema

    RETURN_TYPES = ('IMAGE', 'STRING')
    RETURN_NAMES = ('frames', 'filename')
    FUNCTION = 'combine'
    OUTPUT_NODE = True
    CATEGORY = 'DEAS/Video'

    def check_lazy_status(self, samples=None, baseline='', **kwargs):
        if baseline is None:
            return ['baseline']
        if not isinstance(baseline, str) or (baseline and not Path(baseline).is_file()):
            raise ValueError('Baseline must be a completed eager filename before streaming samples')
        return ['samples'] if samples is None else []

    def combine(self, samples, vae, audio_vae, frame_rate, codec, container, bit_depth,
                quality, save_metadata, filename_prefix, save_output, crop_to_audio=False,
                audio_codec='Auto', audio_bitrate='192k', log_level='Standard',
                save_first_frame=False, save_last_frame=False, seed=None, prompt=None,
                extra_pnginfo=None, free_memory_if_needed=False, baseline=''):
        import torch
        import folder_paths
        import comfy.model_management as mm
        from comfy_extras.nodes_audio import vae_decode_audio
        self.check_lazy_status(samples=samples, baseline=baseline)
        house = _pack()
        if not isinstance(samples, dict) or 'samples' not in samples:
            raise ValueError('Expected a Core LATENT dictionary')
        packed = samples['samples']
        if getattr(packed, 'is_nested', False):
            parts = packed.unbind()
            if len(parts) != 2 or parts[-1].shape[0] != 1:
                raise ValueError('Expected single-batch nested H3 video/audio latent')
            video = parts[0]
        else:
            video = packed
        shape = validate_h3(vae, video)
        interrupt = mm.throw_exception_if_processing_interrupted
        import time
        last_reclaim = 0.
        def check_export():
            nonlocal last_reclaim
            interrupt()
            now = time.monotonic()
            if free_memory_if_needed and now - last_reclaim >= 5:
                audio_bytes = 0 if audio is None else audio[0].nbytes
                house._reclaim_encode_ram(shape[3] * shape[4] * 3 * 4 * 40 + audio_bytes * 2)
                last_reclaim = now
        interrupt()
        # Audio remains the exact Core full-timeline decode/normalization, not a second eager input.
        audio_value = vae_decode_audio(audio_vae, samples) if getattr(packed, 'is_nested', False) else None
        audio, _ = house._audio_file(audio_value)
        check_export()
        def decode(sink):
            interrupt()
            vae.throw_exception_if_invalid()
            vae.prepare_decode(tuple(video.shape))
            with torch.inference_mode(), mm.cuda_device_context(vae.device):
                latent = video.to(device=vae.device, dtype=vae.vae_dtype)
                result = vae.first_stage_model.decode(latent, output_buffer=sink)
                if result is not sink:
                    raise ValueError('H3 decode did not honor its output sink')
            sink.finish()
        depth = {'8-bit': 8, '10-bit': 10}.get(bit_depth)
        if depth is None:
            if codec == 'Auto':
                depth = 8
            else:
                # House Auto-depth samples at most 250k RGB values: collect only that grid.
                total = math.prod(shape)
                step = max(1, (total + 249_999) // 250_000)
                values = torch.empty((total + step - 1) // step)
                offset = written = 0
                def sample(frame):
                    nonlocal offset, written
                    flat = frame.reshape(-1)
                    first = (-offset) % step
                    selected = flat[first::step]
                    values[written:written + selected.numel()] = selected
                    offset += flat.numel()
                    written += selected.numel()
                probe = FrameSink(shape, sample, interrupt)
                _admit(shape, folder_paths.get_temp_directory(), audio, 10, 0)
                decode(probe)
                depth = house.detect_bit_depth(values)
                del values
        output_dir = folder_paths.get_output_directory() if save_output else folder_paths.get_temp_directory()
        prefix = house._format_filename_prefix(filename_prefix, seed=seed)
        directory, name, counter, subfolder, _ = folder_paths.get_save_image_path(prefix, output_dir, shape[4], shape[3])
        metadata = house._metadata_file(prompt, extra_pnginfo) if save_metadata else None
        available = house._available_encoders()
        errors = []
        animated = house._animated_image_settings(container)
        candidates = []
        if animated:
            for encoder in house._animated_image_encoder_candidates(container):
                candidates.append((container, container, encoder, None))
        else:
            pairs = [(selected, target) for selected in house._codec_candidates(codec)
                     for target in (house._auto_container_candidates(selected, container) if codec == 'Auto' else house._container_candidates(selected, container))]
            if ('H.264', 'MP4') not in pairs:
                pairs.append(('H.264', 'MP4'))
            for selected, target in pairs:
                for encoder in house._ENCODER_NAMES[selected]:
                    for audio_encoder in house._audio_encoder_candidates(audio_codec, target) if audio is not None else (None,):
                        candidates.append((selected, target, encoder, audio_encoder))
        for attempt, (selected, target, encoder, audio_encoder) in enumerate(candidates):
            if encoder not in available or (audio_encoder is not None and audio_encoder not in available):
                continue
            # The final candidate publishes even when only the metadata round-trip failed: after
            # an expensive decode a file without container provenance still beats no file, and
            # the warning names exactly what is missing.
            lenient_metadata = attempt == len(candidates) - 1
            active_audio = None if animated else audio
            active_depth = 8 if target == 'Animated WebP' else depth
            extension = animated[0] if animated else house._CONTAINER_EXTENSIONS[target]
            path = Path(directory) / house._output_filename(name, counter, extension, active_audio is not None)
            try:
                exports = encode_stream(decode, shape, path, house.helper_pyav_video,
                    container_name=target, encoder=encoder, frame_rate=frame_rate,
                    bit_depth=active_depth, quality=quality, audio=active_audio,
                    audio_encoder=audio_encoder, audio_bitrate=audio_bitrate,
                    metadata=None if animated else metadata, interrupt=check_export,
                    crop_to_audio=False if animated else crop_to_audio,
                    save_first_frame=save_first_frame, save_last_frame=save_last_frame,
                    metadata_strict=not lenient_metadata or bool(animated),
                    on_warning=lambda note: print(f'[DEAS H3 Streaming Video Save] WARN published '
                                                  f'without full container provenance: {note}',
                                                  flush=True))
            except (CodecFailure, ValidationFailure) as error:
                reason = f'{selected}/{target}/{encoder}/{audio_encoder}: {error}'
                if isinstance(error, ValidationFailure):
                    print(f'[DEAS H3 Streaming Video Save] readback check rejected this candidate, '
                          f'trying the next one: {reason} (stage: {error.stage}, diagnosis: '
                          f'{error.diagnosis})', flush=True)
                errors.append(reason)
                continue
            output_type = 'output' if save_output else 'temp'
            mime = animated[2] if animated else {'MP4': 'video/mp4', 'WebM': 'video/webm', 'MKV': 'video/x-matroska'}[target]
            asset = {'filename': path.name, 'subfolder': subfolder, 'type': output_type,
                     'format': mime, 'codec': selected, 'bit_depth': active_depth,
                     'container': target, 'width': shape[4], 'height': shape[3], 'fps': frame_rate}
            ui = {'images': [{'filename': Path(endpoint).name, 'subfolder': subfolder,
                  'type': output_type, 'format': 'image/png', 'width': shape[4], 'height': shape[3]}
                  for endpoint in exports]}
            if animated:
                ui['images'].insert(0, asset)
            else:
                ui['gifs'] = [asset]
            return {'ui': ui, 'result': (torch.empty((0, shape[3], shape[4], 3)), str(path))}
        raise RuntimeError('No usable H3 streaming encoder: ' + ' | '.join(errors))

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float('nan')


NODE_CLASS_MAPPINGS = {'DEAS_H3StreamVideoSave': DEAS_H3StreamVideoSave}
NODE_DISPLAY_NAME_MAPPINGS = {'DEAS_H3StreamVideoSave': 'DEAS H3 Streaming Video Save'}


class FrameSink:
    """Accept only Core's finalized, contiguous BCTHW writes; own at most one frame."""

    def __init__(self, shape, consume, interrupt):
        if len(shape) != 5 or shape[0] != 1 or shape[1] != 3 or any(type(x) is not int or x <= 0 for x in shape):
            raise ValueError('Expected positive single-batch RGB BCTHW output')
        self.shape = tuple(shape)
        self.consume = consume
        self.interrupt = interrupt
        self.position = 0
        self.outstanding = self.peak_outstanding = 0

    def __getitem__(self, key):
        if not isinstance(key, tuple) or len(key) != 5:
            raise ValueError('Unsupported H3 sink indexing')
        if any(key[i] != slice(None) for i in (0, 1, 3, 4)):
            raise ValueError('H3 sink requires full batch/channel/spatial writes')
        span = key[2]
        if not isinstance(span, slice) or span.step is not None or span.start != self.position or not isinstance(span.stop, int) or not self.position < span.stop <= self.shape[2]:
            raise ValueError('Noncontiguous H3 frame write')
        return _Write(self, span.stop)

    def copy_(self, part):
        return _Write(self, self.shape[2]).copy_(part)

    def finish(self):
        self.interrupt()
        if self.position != self.shape[2]:
            raise ValueError('H3 decoder did not write the exact frame count')


class _Write:
    def __init__(self, sink, stop):
        self.sink, self.stop = sink, stop

    def copy_(self, part):
        import torch
        sink = self.sink
        expected = (1, 3, self.stop - sink.position, *sink.shape[3:])
        if not isinstance(part, torch.Tensor) or tuple(part.shape) != expected or part.dtype != torch.float32:
            raise ValueError('H3 finalized write shape/dtype changed')
        for index in range(part.shape[2]):
            sink.interrupt()
            frame = part[0, :, index].detach().to(device='cpu').permute(1, 2, 0).contiguous()
            if not torch.isfinite(frame).all() or frame.min() < 0 or frame.max() > 1:
                raise ValueError('H3 sink requires finalized [0,1] pixels')
            sink.outstanding += 1
            sink.peak_outstanding = max(sink.peak_outstanding, sink.outstanding)
            try:
                sink.consume(frame)
            finally:
                sink.outstanding -= 1
            del frame
            sink.position += 1
        return self
