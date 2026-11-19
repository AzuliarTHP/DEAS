"""CPU-only contract tests; no learned decoder or GPU inference is exercised."""
import ast
import importlib.util
import json
import math
import os
from pathlib import Path
import tempfile
import types
import unittest

HERE = Path(__file__).parent
CORE = Path(os.path.expanduser(os.environ.get('DEAS_TEST_COMFY_ROOT', '~/dev/deas-environment/ComfyUI')))


def owned():
    spec = importlib.util.spec_from_file_location('h3_stream_video', HERE / 'h3_stream_video.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HAS_TORCH = importlib.util.find_spec('torch') is not None
HAS_AV = importlib.util.find_spec('av') is not None


@unittest.skipUnless(HAS_TORCH, 'optional torch absent')
class SinkTests(unittest.TestCase):
    def test_stock_temporal_tensor_equals_sink(self):
        self.assertTrue((HERE / 'h3_stream_video.py').exists(), 'streaming sink is not implemented')
        import torch
        source = CORE / 'comfy/ldm/minimax/vae.py'
        if not source.exists():
            self.skipTest('optional stock Core source absent')
        tree = ast.parse(source.read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'MiniMaxH3VideoVAE')
        names = {'decode', 'decode_temporal', 'decode_output_shape', '_decode_temporal_pad_frames',
                 '_decode_temporal_frame_plan', '_decode_temporal_chunks', '_finalize_pixels', 'blend'}
        methods = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in names]
        namespace = {'torch': torch, 'math': math}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name='Stock', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])), str(source), 'exec'), namespace)
        model = namespace['Stock']()
        model.noncausal = False
        model.still_frame = None
        model.clip_length = 17
        model.token_drop = 3
        model.vae_ratio_t = 4
        model.vae_ratio = 1
        model.frame_pre_padding = 3
        model.tokens_chunk_size = 5
        model.token_overlap = 2
        model.frame_overlap = 5
        model.decoder = types.SimpleNamespace(out_channels=3)
        model.latents_mean = torch.zeros(24)
        model.latents_std = torch.ones(24)
        model.pixel_std = torch.tensor([.229, .224, .225]).reshape(1, 3, 1, 1, 1)
        model.pixel_mean = torch.tensor([.485, .456, .406]).reshape(1, 3, 1, 1, 1)
        def adaptive(z, frames=slice(None)):
            # Deliberately out-of-range raw pixels with different overlap predictions.
            raw = torch.sin(z[:, :3].repeat_interleave(4, dim=2) * 17
                            + torch.arange(z.shape[2] * 4).reshape(1, 1, -1, 1, 1) * .7) * 6
            return raw[:, :, frames]
        model._adaptive_decode = adaptive
        for length in (1, 2, 4, 5, 7, 11, 12, 18, 27):
            with self.subTest(length=length):
                z = torch.linspace(-2, 2, 24 * length * 4).reshape(1, 24, length, 2, 2)
                shape = model.decode_output_shape(z.shape)
                expected = torch.empty(shape)
                model.decode(z, output_buffer=expected)
                collected = []
                sink = owned().FrameSink(shape, lambda frame: collected.append(frame.clone()), lambda: None)
                self.assertIs(model.decode(z, output_buffer=sink), sink)
                sink.finish()
                actual = torch.stack(collected).permute(3, 0, 1, 2).unsqueeze(0)
                self.assertTrue(torch.equal(expected, actual))
                self.assertTrue(((expected > 0) & (expected < 1)).any())
                self.assertTrue(((expected == 0) | (expected == 1)).any())
                if length >= 11:
                    import copy
                    wrong = copy.copy(model)
                    def preclamped(z, frames=slice(None)):
                        raw = adaptive(z, frames)
                        return ((raw * model.pixel_std + model.pixel_mean).clamp(0, 1) - model.pixel_mean) / model.pixel_std
                    wrong._adaptive_decode = preclamped
                    before_blend_clamped = torch.empty(shape)
                    wrong.decode(z, output_buffer=before_blend_clamped)
                    self.assertFalse(torch.allclose(expected, before_blend_clamped, atol=1e-6),
                                     'fixture must distinguish raw blend from prematurely clamped blend')
                self.assertEqual(sink.outstanding, 0)
                self.assertEqual(sink.peak_outstanding, 1)


@unittest.skipUnless(HAS_TORCH and HAS_AV, 'optional torch/PyAV absent')
class ExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import av
        cls.av = av
        path = Path(os.path.expanduser(os.environ.get('DEAS_TEST_DASIWA_ROOT', '~/dev/ComfyUI-DaSiWa-Nodes'))) / 'nodes/helper_pyav_video.py'
        if not path.exists():
            raise unittest.SkipTest('optional installed pack absent')
        spec = importlib.util.spec_from_file_location('pack_pyav_test', path)
        cls.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.helper)

    def frames(self):
        import torch
        def decode(sink):
            for start in (0, 3):
                sink[:, :, start:start + 3, :, :].copy_(torch.full((1, 3, 3, 16, 16), .4))
        return decode

    def audio(self):
        import numpy as np
        return (np.sin(np.arange(12000)[None, :] * .05).astype('float32') * .1, 48000)

    def export(self, target, interrupt=lambda: None, module=None, **overrides):
        kwargs = dict(container_name='MP4', encoder='libx264', frame_rate=24, bit_depth=8,
                      quality=20, audio=self.audio(), audio_encoder='aac', audio_bitrate='192k',
                      metadata={'prompt': {'test': 'stream'}}, interrupt=interrupt,
                      save_first_frame=True, save_last_frame=True)
        kwargs.update(overrides)
        return (module or owned()).encode_stream(self.frames(), (1, 3, 6, 16, 16), target,
                                                 self.helper, **kwargs)

    def test_metadata_readback_failure_names_the_key_and_stays_retryable(self):
        module = owned()
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            target = Path(directory) / 'result.mp4'
            self.export(target, module=module)
            for metadata, fragment in (({'prompt': {'test': 'other'}}, 'differs after readback'),
                                       ({'workflow': {'x': 1}}, 'absent after readback')):
                with self.subTest(metadata=sorted(metadata)):
                    with self.assertRaises(module.ValidationFailure) as caught:
                        module._validate_video(target, (1, 3, 6, 16, 16), 6, self.helper._rate(24),
                                               None, None, metadata, lambda: None)
                    self.assertIn(sorted(metadata)[0], str(caught.exception))
                    self.assertIn(fragment, str(caught.exception))
                    self.assertEqual(caught.exception.diagnosis['key'], sorted(metadata)[0])
                    self.assertTrue(caught.exception.stage.endswith('result.mp4'))
            # only the final candidate may publish despite this, and then it must be reported
            problems = module._validate_video(target, (1, 3, 6, 16, 16), 6, self.helper._rate(24),
                                              None, None, {'prompt': {'test': 'other'}},
                                              lambda: None, metadata_strict=False)
            self.assertEqual(len(problems), 1)
            self.assertIn('prompt', problems[0])
            # every other check stays fatal even in the lenient mode
            with self.assertRaises(ValueError) as caught:
                module._validate_video(target, (1, 3, 6, 16, 16), 5, self.helper._rate(24), None,
                                       None, None, lambda: None, metadata_strict=False)
            self.assertIn('frame count', str(caught.exception))

    def test_nan_bearing_graph_provenance_round_trips_and_passes_strict(self):
        """ComfyUI graphs carry is_changed:[NaN]; NaN != NaN must not reject identical bytes."""
        module = owned()
        nan = float('nan')
        metadata = {'prompt': {'7': {'class_type': 'DEAS_H3StreamVideoSave', 'is_changed': [nan]}},
                    'workflow': {'nodes': [{'id': '7', 'is_changed': [nan]}]}}
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            target = Path(directory) / 'result.mp4'
            self.export(target, module=module, metadata=metadata)
            with self.av.open(str(target)) as media:
                back = json.loads(media.metadata['prompt'])
                # (comparing NaN with == is the very trap this test guards: [nan] != [nan])
                self.assertEqual(json.dumps(back, separators=(',', ':')),
                                 json.dumps(metadata['prompt'], separators=(',', ':')))
            module._validate_video(target, (1, 3, 6, 16, 16), 6, self.helper._rate(24), None, None,
                                   metadata, lambda: None, container_name='MP4')
            self.assertEqual(module._validate_video(target, (1, 3, 6, 16, 16), 6,
                                                    self.helper._rate(24), None, None, metadata,
                                                    lambda: None, metadata_strict=False,
                                                    container_name='MP4'), [])
            # a genuinely different payload is still caught, with NaN in it
            with self.assertRaises(module.ValidationFailure) as caught:
                module._validate_video(target, (1, 3, 6, 16, 16), 6, self.helper._rate(24), None,
                                       None, {'prompt': {'7': {'is_changed': [nan, nan]}}},
                                       lambda: None, container_name='MP4')
            self.assertIn('differs after readback', str(caught.exception))

    def test_matroska_family_carries_provenance_in_the_uppercase_envelope(self):
        """The matroska muxer drops non-uppercase tags, so DEAS must not demand what cannot return."""
        module = owned()
        self.assertEqual(module._container_tags('MKV', {'prompt': {'a': 1}}),
                         {'DEAS': {'prompt': {'a': 1}}})
        self.assertEqual(module._container_tags('WebM', {'prompt': {'a': 1}}),
                         {'DEAS': {'prompt': {'a': 1}}})
        self.assertEqual(module._container_tags('MP4', {'prompt': {'a': 1}}), {'prompt': {'a': 1}})
        metadata = {'prompt': {'test': 'stream'}, 'workflow': {'nodes': 'x' * 4000}}
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            target = Path(directory) / 'result.mkv'
            self.export(target, module=module, container_name='MKV', encoder='libx264',
                        metadata=metadata)
            with self.av.open(str(target)) as media:
                tags = dict(media.metadata)
            self.assertNotIn('prompt', {key.casefold() for key in tags})
            self.assertEqual(json.loads(tags['DEAS']), metadata)
            # the strict first candidate now succeeds instead of burning the encoder chain
            module._validate_video(target, (1, 3, 6, 16, 16), 6, self.helper._rate(24), None, None,
                                   metadata, lambda: None, container_name='MKV')
            # a stage file that lost the envelope stays a named, retryable failure
            with self.assertRaises(module.ValidationFailure) as caught:
                module._validate_video(target, (1, 3, 6, 16, 16), 6, self.helper._rate(24), None,
                                       None, {'prompt': metadata['prompt']}, lambda: None)
            self.assertIn('prompt', str(caught.exception))
            self.assertIn('DEAS', caught.exception.diagnosis['container_tags'])

    def test_lenient_metadata_policy_publishes_and_reports_the_problem(self):
        """The real-world shape: the muxer kept no tags, so readback cannot match."""
        from unittest.mock import patch
        module = owned()
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            target = Path(directory) / 'result.mp4'
            seen = []
            with patch.object(self.helper, '_metadata', lambda container, metadata: None):
                self.export(target, module=module, metadata_strict=False, on_warning=seen.append)
                self.assertEqual(len(seen), 1)
                self.assertIn('prompt', seen[0])
            self.assertTrue(target.is_file(), 'the final candidate must still produce a file')
            with self.av.open(str(target)) as media:
                self.assertNotIn('prompt', {key.casefold() for key in media.metadata})
            seen.clear()
            with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as strict_dir:
                with patch.object(self.helper, '_metadata', lambda container, metadata: None):
                    with self.assertRaises(module.ValidationFailure):
                        self.export(Path(strict_dir) / 'strict.mp4', module=module,
                                    on_warning=seen.append)
            self.assertEqual(seen, [], 'a strict candidate never reports a warning')

    def test_rejected_stage_file_is_retained_only_when_the_owner_asks(self):
        from unittest.mock import patch
        module = owned()

        def reject(path, *args, **kwargs):
            raise module.ValidationFailure("Encoded metadata key 'prompt' differs after readback",
                                           diagnosis={'key': 'prompt'}, stage=path)

        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            with patch.object(module, '_validate_video', reject):
                with self.assertRaises(module.ValidationFailure):
                    self.export(Path(directory) / 'strict.mp4', module=module)
            self.assertEqual(list(Path(directory).iterdir()), [],
                             'a rejected encode leaves nothing behind unless asked')
            with patch.object(module, '_validate_video', reject):
                with patch.dict(os.environ, {'DEAS_H3_KEEP_FAILED': '1'}):
                    with self.assertRaises(module.ValidationFailure) as caught:
                        self.export(Path(directory) / 'kept.mp4', module=module)
            retained = sorted(path.name for path in Path(directory).iterdir())
            self.assertEqual(retained, ['kept.validation-failed-libx264.mp4'])
            self.assertEqual(caught.exception.diagnosis['retained'],
                             str(Path(directory) / retained[0]))
            self.assertTrue((Path(directory) / retained[0]).stat().st_size > 0)

    @unittest.skipUnless(CORE.is_dir(), 'optional Core absent')
    def test_complete_node_audio_retry_and_house_schema(self):
        self.assertTrue(hasattr(owned().DEAS_H3StreamVideoSave, 'combine'), 'node execution missing')
        import torch
        import datetime
        import re
        from unittest.mock import patch
        import sys
        if str(CORE) not in sys.path:
            sys.path.insert(0, str(CORE))
        import comfy.options
        comfy.options.enable_args_parsing()
        previous = sys.argv
        try:
            sys.argv = ['test', '--cpu']
            from comfy.ldm.minimax.vae import MiniMaxH3VideoVAE
            from comfy.nested_tensor import NestedTensor
        finally:
            sys.argv = previous
        source = Path(os.path.expanduser(os.environ.get('DEAS_TEST_DASIWA_ROOT', '~/dev/ComfyUI-DaSiWa-Nodes'))) / 'nodes/nodes_enhanced_video_combine.py'
        namespace = dict(torch=torch, os=os, datetime=datetime, re=re, helper_pyav_video=self.helper)
        parsed = ast.parse(source.read_text())
        selected = [n for n in parsed.body if isinstance(n, (ast.FunctionDef, ast.ClassDef, ast.Assign))]
        exec(compile(ast.Module(body=selected, type_ignores=[]), str(source), 'exec'), namespace)
        house = types.SimpleNamespace(**namespace)
        house._available_encoders = lambda: {'libx264', 'aac'}
        reclaimed = []
        house._reclaim_encode_ram = lambda target: reclaimed.append(target)
        model = MiniMaxH3VideoVAE(encoder=False, decoder=False)
        model.decoder = types.SimpleNamespace(out_channels=3)
        model._adaptive_decode = lambda z, frames=slice(None): torch.zeros(1, 3, z.shape[2] * 4, 16, 16)[:, :, frames]
        prepared = []
        vae = types.SimpleNamespace(first_stage_model=model, device=torch.device('cpu'), vae_dtype=torch.float32,
            vae_output_dtype=lambda: torch.float32, process_output=lambda x: x,
            throw_exception_if_invalid=lambda: None, prepare_decode=lambda shape: prepared.append(shape))
        audio_vae = types.SimpleNamespace(audio_sample_rate=48000,
            decode=lambda z: torch.sin(torch.arange(12000).reshape(1, -1, 1) * .05) * .4)
        latent = {'samples': NestedTensor([torch.zeros(1, 24, 1, 1, 1), torch.zeros(1, 8, 2)])}
        module = owned()
        original_frame = self.helper._video_frame
        frame_calls = 0
        def fail_once(*args, **kwargs):
            nonlocal frame_calls
            frame_calls += 1
            if frame_calls == 1:
                raise self.av.error.InvalidDataError(22, 'deliberate codec failure')
            return original_frame(*args, **kwargs)
        # A duplicate codec candidate forces retry after a real sink write, without GPU encoders.
        house._ENCODER_NAMES = {'H.264': ('libx264', 'libx264')}
        audio_tree = ast.parse((CORE / 'comfy_extras/nodes_audio.py').read_text())
        audio_function = next(n for n in audio_tree.body if isinstance(n, ast.FunctionDef) and n.name == 'vae_decode_audio')
        audio_namespace = {'torch': torch}
        exec(compile(ast.Module(body=[audio_function], type_ignores=[]), 'stock_nodes_audio.py', 'exec'), audio_namespace)
        audio_module = types.SimpleNamespace(vae_decode_audio=audio_namespace['vae_decode_audio'])
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            folder = types.SimpleNamespace(get_output_directory=lambda: directory,
                get_temp_directory=lambda: directory,
                get_save_image_path=lambda *args: (directory, 'stream', 1, '', None))
            original = Path(directory) / 'Original.mp4'
            original.write_bytes(b'published baseline')
            with patch.object(module, '_pack', return_value=house), patch.dict(sys.modules, {'folder_paths': folder, 'comfy_extras.nodes_audio': audio_module}), patch.object(self.helper, '_video_frame', side_effect=fail_once):
                schema = module.DEAS_H3StreamVideoSave.INPUT_TYPES()
                self.assertEqual(set(schema['required']), {'samples', 'vae', 'audio_vae', 'frame_rate', 'codec', 'container', 'bit_depth', 'quality', 'log_level', 'save_metadata', 'filename_prefix', 'save_output', 'crop_to_audio', 'audio_codec', 'audio_bitrate', 'save_first_frame', 'save_last_frame'})
                result = module.DEAS_H3StreamVideoSave().combine(latent, vae, audio_vae,
                    frame_rate=24, codec='H.264', container='MP4', bit_depth='8-bit', quality=20,
                    filename_prefix='stream', save_output=True, save_metadata=True,
                    baseline=str(original), prompt={'fake_decoder': True}, save_first_frame=True,
                    free_memory_if_needed=True)
            self.assertTrue(reclaimed, 'house memory cleanup option must not be silently ignored')
            self.assertEqual(len(prepared), 2, 'codec retry must re-decode the latent')
            self.assertEqual(result['result'][0].shape, (0, 16, 16, 3))
            self.assertTrue(Path(result['result'][1]).is_file())
            self.assertEqual(result['ui']['gifs'][0]['filename'], Path(result['result'][1]).name)
            self.assertEqual(original.read_bytes(), b'published baseline')

    def test_webm_explicit_audio_falls_back_to_opus(self):
        import datetime
        import re
        import sys
        import numpy as np
        import torch
        from unittest.mock import patch
        source = Path(os.path.expanduser(os.environ.get('DEAS_TEST_DASIWA_ROOT', '~/dev/ComfyUI-DaSiWa-Nodes'))) / 'nodes/nodes_enhanced_video_combine.py'
        namespace = dict(torch=torch, os=os, datetime=datetime, re=re, helper_pyav_video=self.helper)
        parsed = ast.parse(source.read_text())
        selected = [n for n in parsed.body if isinstance(n, (ast.FunctionDef, ast.ClassDef, ast.Assign))]
        exec(compile(ast.Module(body=selected, type_ignores=[]), str(source), 'exec'), namespace)
        house = types.SimpleNamespace(**namespace)
        house._available_encoders = lambda: {'libvpx-vp9', 'aac', 'libmp3lame', 'libopus'}
        house._audio_file = lambda value: ((np.zeros((1, 12000), dtype='float32'), 48000), .25)
        shape = (1, 3, 6, 16, 16)
        prepared = []
        def decode(latent, output_buffer):
            output_buffer.copy_(torch.full(shape, .4))
            return output_buffer
        model = types.SimpleNamespace(decode=decode)
        vae = types.SimpleNamespace(first_stage_model=model, device=torch.device('cpu'), vae_dtype=torch.float32,
            throw_exception_if_invalid=lambda: None, prepare_decode=lambda shape: prepared.append(shape))
        mm = types.ModuleType('comfy.model_management')
        mm.throw_exception_if_processing_interrupted = lambda: None
        mm.cuda_device_context = lambda device: __import__('contextlib').nullcontext()
        comfy = types.ModuleType('comfy')
        comfy.model_management = mm
        for requested, rejected in (('AAC', 'aac'), ('MP3', 'libmp3lame')):
            with self.subTest(audio=requested), tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
                prepared.clear()
                module = owned()
                folder = types.SimpleNamespace(get_output_directory=lambda: directory,
                    get_temp_directory=lambda: directory,
                    get_save_image_path=lambda *args: (directory, 'stream', 1, '', None))
                modules = {'folder_paths': folder, 'comfy': comfy, 'comfy.model_management': mm,
                    'comfy_extras.nodes_audio': types.SimpleNamespace(vae_decode_audio=lambda *args: None)}
                with patch.dict(sys.modules, modules), patch.object(module, '_pack', return_value=house), \
                     patch.object(module, 'validate_h3', return_value=shape), \
                     patch.object(self.helper, '_configure_audio_stream', wraps=self.helper._configure_audio_stream) as configure:
                    result = module.DEAS_H3StreamVideoSave().combine({'samples': torch.zeros(1)}, vae, None,
                        frame_rate=24, codec='VP9', container='WebM', bit_depth='8-bit', quality=20,
                        filename_prefix='stream', save_output=True, save_metadata=False, audio_codec=requested)
                self.assertEqual([call.args[1] for call in configure.call_args_list], [rejected, 'libopus'])
                self.assertEqual(len(prepared), 1, 'configuration rejection must happen before decode')
                path = Path(result['result'][1])
                self.assertEqual(result['ui']['gifs'][0]['container'], 'WebM')
                with self.av.open(str(path)) as media:
                    self.assertEqual(media.streams.audio[0].codec_context.name, 'opus')
                    self.assertEqual(len(list(media.decode(video=0))), 6)
                self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_nonconfiguration_value_errors_do_not_become_codec_failures(self):
        import torch
        from unittest.mock import patch
        for phase in ('decoder', 'validation', 'publication'):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
                module = owned()
                error = ValueError(phase)
                def fail(*args, **kwargs):
                    raise error
                def decode(sink):
                    if phase == 'decoder':
                        fail()
                    sink.copy_(torch.full((1, 3, 6, 16, 16), .4))
                with patch.object(module, '_validate_video', side_effect=fail if phase == 'validation' else module._validate_video), \
                     patch.object(module.os, 'link', side_effect=fail if phase == 'publication' else os.link), \
                     patch.object(module.os, 'rename', side_effect=fail if phase == 'publication' else os.rename):
                    with self.assertRaises(ValueError) as caught:
                        module.encode_stream(decode, (1, 3, 6, 16, 16), Path(directory) / 'result.mp4', self.helper,
                            container_name='MP4', encoder='libx264', frame_rate=24, bit_depth=8, quality=20)
                self.assertIs(caught.exception, error)
                self.assertEqual(list(Path(directory).iterdir()), [])

    def test_resource_errors_never_become_codec_retries(self):
        module = owned()
        import errno
        for number, message in ((errno.ENOMEM, 'allocation failed'), (errno.ENOSPC, 'disk full'),
                                (123456, 'Cannot allocate memory'), (123456, 'Disk quota exceeded')):
            with self.subTest(message=message):
                error = self.av.error.ExternalError(number, message)
                def fail():
                    raise error
                for configuration in (False, True):
                    with self.assertRaises(self.av.FFmpegError):
                        module._codec(fail, configuration=configuration)

    def test_cpu_container_codec_readback_matrix(self):
        import torch
        import numpy as np
        module = owned()
        cases = [('MP4', 'libx264', 'aac', 8), ('WebM', 'libvpx-vp9', 'libopus', 8),
                 ('MKV', 'libx264', 'libopus', 8), ('MP4', 'libx264', 'aac', 10)]
        for container, encoder, audio_encoder, depth in cases:
            with self.subTest(container=container, depth=depth), tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
                shape = (1, 3, 6, 16, 16)
                def decode(sink):
                    sink.copy_(torch.full(shape, .4))
                audio = (np.zeros((1, 8000), dtype='float32'), 32000)
                path = Path(directory) / 'result.video'
                module.encode_stream(decode, shape, path, self.helper, container_name=container,
                    encoder=encoder, frame_rate=24, bit_depth=depth, quality=20,
                    audio=audio, audio_encoder=audio_encoder, metadata={'prompt': {'matrix': True}})
                self.assertTrue(path.is_file())

    def test_failures_inside_write_flush_and_publication_leave_no_output(self):
        import torch
        from unittest.mock import patch
        for phase in ('frame', 'flush', 'publish', 'disk-write', 'endpoint-collision', 'allocation'):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
                target = Path(directory) / 'processed.mp4'
                original = Path(directory) / 'Original.mp4'
                original.write_bytes(b'baseline survives')
                module = owned()
                class Cancelled(Exception):
                    pass
                after_decode = False
                calls = 0
                def interrupt():
                    nonlocal calls
                    calls += 1
                    if (phase == 'frame' and calls == 3) or (phase == 'flush' and after_decode):
                        raise Cancelled(phase)
                def decode(sink):
                    nonlocal after_decode
                    if phase == 'allocation':
                        raise MemoryError('decoder allocation failed')
                    sink.copy_(torch.zeros(1, 3, 6, 16, 16))
                    after_decode = True
                original_validate = module._validate_video
                def validated(*args, **kwargs):
                    original_validate(*args, **kwargs)
                    if phase == 'publish':
                        raise Cancelled('just before publication')
                disk_calls = 0
                real_usage = __import__('shutil').disk_usage
                def disk_usage(path):
                    nonlocal disk_calls
                    disk_calls += 1
                    return types.SimpleNamespace(free=0) if phase == 'disk-write' and disk_calls > 2 else real_usage(path)
                collision = Path(directory) / 'processed-last-frame.png'
                if phase == 'endpoint-collision':
                    collision.write_bytes(b'existing endpoint')
                error_type = MemoryError if phase == 'allocation' else OSError if phase in ('disk-write', 'endpoint-collision') else Cancelled
                with patch.object(module, '_validate_video', side_effect=validated), patch('shutil.disk_usage', side_effect=disk_usage):
                    with self.assertRaises(error_type):
                        module.encode_stream(decode, (1, 3, 6, 16, 16), target, self.helper,
                            container_name='MP4', encoder='libx264', frame_rate=24, bit_depth=8,
                            quality=20, interrupt=interrupt, save_first_frame=True, save_last_frame=True)
                self.assertEqual(original.read_bytes(), b'baseline survives')
                self.assertEqual(set(Path(directory).iterdir()), {original, collision} if phase == 'endpoint-collision' else {original})

    def test_platform_publication_no_clobber_and_group_rollback(self):
        import torch
        from unittest.mock import Mock, patch
        for platform in ('nt', 'posix'):
            for phase in ('success', 'endpoint-collision', 'video-collision', 'publish-failure'):
                with self.subTest(platform=platform, phase=phase), tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
                    module = owned()
                    target = Path(directory) / 'result.mp4'
                    original = Path(directory) / 'Original.mp4'
                    original.write_bytes(b'baseline')
                    collision = target if phase == 'video-collision' else target.with_name('result-last-frame.png')
                    validate = module._validate_video
                    def validated(*args, **kwargs):
                        validate(*args, **kwargs)
                        if phase.endswith('collision'):
                            collision.write_bytes(b'concurrent original')
                    def publish(source, destination, move=False):
                        if phase == 'publish-failure' and destination == target:
                            raise OSError('publication failed')
                        # Simulate Windows rename's no-replace contract on this Linux host.
                        if move:
                            if destination.exists():
                                raise FileExistsError(destination)
                            return os.rename(source, destination)
                        return os.link(source, destination)
                    link = Mock(side_effect=publish)
                    rename = Mock(side_effect=lambda source, destination: publish(source, destination, move=True))
                    system = types.SimpleNamespace(name=platform, link=link, rename=rename)
                    def decode(sink):
                        sink.copy_(torch.full((1, 3, 6, 16, 16), .4))
                    with patch.object(module, 'os', system), patch.object(module, '_validate_video', side_effect=validated):
                        def export():
                            return module.encode_stream(decode, (1, 3, 6, 16, 16), target, self.helper,
                                container_name='MP4', encoder='libx264', frame_rate=24, bit_depth=8,
                                quality=20, save_first_frame=True, save_last_frame=True)
                        if phase == 'success':
                            endpoints = export()
                            self.assertEqual(len(endpoints), 2)
                            expected = {original, target, *(Path(path) for path in endpoints)}
                        else:
                            with self.assertRaises(FileExistsError if phase.endswith('collision') else OSError):
                                export()
                            expected = {original, collision} if phase.endswith('collision') else {original}
                    self.assertEqual(original.read_bytes(), b'baseline')
                    self.assertEqual(set(Path(directory).iterdir()), expected)
                    if phase.endswith('collision'):
                        self.assertEqual(collision.read_bytes(), b'concurrent original')
                    active, unused = (rename, link) if platform == 'nt' else (link, rename)
                    self.assertGreaterEqual(active.call_count, 2)
                    unused.assert_not_called()

    def test_real_cpu_codec_audio_metadata_and_endpoints(self):
        self.assertTrue(hasattr(owned(), 'encode_stream'), 'fused writer is not implemented')
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            target = Path(directory) / 'result.mp4'
            endpoints = self.export(target)
            self.assertEqual(len(endpoints), 2)
            self.assertTrue(all(Path(p).is_file() for p in endpoints))
            with self.av.open(str(target)) as media:
                self.assertEqual(len(list(media.decode(video=0))), 6)
                self.assertIn('stream', media.metadata['prompt'])
            with self.av.open(str(target)) as media:
                self.assertGreaterEqual(sum(f.samples for f in media.decode(audio=0)), 12000)
            self.assertEqual(sorted(p.name for p in Path(directory).iterdir()), ['result-first-frame.png', 'result-last-frame.png', 'result.mp4'])

    def test_cancel_disk_and_no_clobber_preserve_original(self):
        self.assertTrue(hasattr(owned(), 'encode_stream'), 'fused writer is not implemented')
        from unittest.mock import patch
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            original = Path(directory) / 'Original.mp4'
            original.write_bytes(b'owner original untouched')
            with self.assertRaises(FileExistsError):
                self.export(original)
            target = Path(directory) / 'processed.mp4'
            class Cancelled(Exception):
                pass
            calls = 0
            def interrupt():
                nonlocal calls
                calls += 1
                if calls >= 5:
                    raise Cancelled('scoped stop')
            with self.assertRaises(Cancelled):
                self.export(target, interrupt)
            with patch('shutil.disk_usage', return_value=types.SimpleNamespace(free=0)):
                with self.assertRaises(OSError):
                    self.export(target)
            self.assertEqual(original.read_bytes(), b'owner original untouched')
            self.assertEqual(list(Path(directory).iterdir()), [original])


class NodeTests(unittest.TestCase):
    def test_streaming_node_retries_readback_failures_and_relaxes_only_on_the_last_candidate(self):
        source = (HERE / 'h3_stream_video.py').read_text()
        tree = ast.parse(source)
        node = next(n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)
                    and n.name == 'DEAS_H3StreamVideoSave')
        retrying = [handler for handler in ast.walk(node) if isinstance(handler, ast.ExceptHandler)
                    and isinstance(handler.type, ast.Tuple)
                    and {'CodecFailure', 'ValidationFailure'} <= {getattr(e, 'id', None)
                                                                  for e in handler.type.elts}]
        self.assertTrue(retrying, 'the encoder candidate loop must retry readback failures')
        self.assertIn('lenient_metadata = attempt == len(candidates) - 1', source)
        self.assertIn('DEAS_H3_KEEP_FAILED', source)
        self.assertTrue(issubclass(owned().ValidationFailure, ValueError),
                        'readback failures stay ValueError for existing callers')

    def test_codec_configuration_boundary_without_optional_dependencies(self):
        import errno
        import sys
        from unittest.mock import patch
        module = owned()
        class FFmpegError(ValueError):
            def __init__(self, number, message):
                super().__init__(message)
                self.errno = number
        errors = [ValueError('unsupported codec'), MemoryError('allocation failed'),
                  OSError(errno.ENOSPC, 'disk full'), FFmpegError(errno.ENOMEM, 'allocation failed'),
                  FFmpegError(123456, 'Cannot allocate memory'), FFmpegError(22, 'bad codec')]
        with patch.dict(sys.modules, {'av': types.SimpleNamespace(FFmpegError=FFmpegError)}):
            for configuration in (False, True):
                for error in errors:
                    retry = (type(error) is ValueError and configuration) or (isinstance(error, FFmpegError) and error.errno == 22)
                    with self.subTest(configuration=configuration, error=repr(error)):
                        def fail():
                            raise error
                        with self.assertRaises(module.CodecFailure if retry else type(error)) as caught:
                            module._codec(fail, configuration=configuration)
                        self.assertIs(caught.exception.__cause__ if retry else caught.exception, error)

    def test_schema_and_lazy_gate(self):
        from unittest.mock import patch
        module = owned()
        self.assertTrue(hasattr(module, 'DEAS_H3StreamVideoSave'), 'node missing')
        house = types.SimpleNamespace(DaSiWa_EnhancedVideoCombine=types.SimpleNamespace(INPUT_TYPES=lambda: {
            'required': {'images': ('IMAGE',), 'frame_rate': ('FLOAT', {'default': 24}),
                         'pingpong': ('BOOLEAN',), 'pass_frames': ('BOOLEAN',)},
            'optional': {'audio': ('AUDIO',), 'seed': ('INT',)}, 'hidden': {'prompt': 'PROMPT'}}))
        with patch.object(module, '_pack', return_value=house):
            schema = module.DEAS_H3StreamVideoSave.INPUT_TYPES()
        self.assertEqual(set(schema['required']), {'samples', 'vae', 'audio_vae', 'frame_rate'})
        self.assertEqual(schema['required']['samples'], ('LATENT', {'lazy': True}))
        self.assertNotIn('audio', schema['optional'])
        self.assertEqual(schema['optional']['baseline'], ('STRING', {'default': '', 'forceInput': True}))
        node = module.DEAS_H3StreamVideoSave()
        self.assertEqual(node.check_lazy_status(samples=None, baseline=None), ['baseline'])
        self.assertEqual(node.check_lazy_status(samples=None, baseline=''), ['samples'])
        self.assertEqual(node.check_lazy_status(samples={}, baseline=''), [])
        with self.assertRaises(ValueError):
            node.check_lazy_status(samples=None, baseline='/nonexistent/baseline.mp4')

    @unittest.skipUnless(importlib.util.find_spec('psutil') is not None, 'optional psutil absent')
    def test_cgroup_parent_admission_and_ram_failure(self):
        from unittest.mock import patch
        module = owned()
        files = {'/proc/self/cgroup': '0::/worker/job',
                 '/sys/fs/cgroup/worker/job/memory.max': '512',
                 '/sys/fs/cgroup/worker/job/memory.current': '56',
                 '/sys/fs/cgroup/worker/memory.max': '256',
                 '/sys/fs/cgroup/worker/memory.current': '128',
                 '/sys/fs/cgroup/memory.max': '1024',
                 '/sys/fs/cgroup/memory.current': '200'}
        with patch.object(Path, 'read_text', lambda path: files[str(path)]), patch('psutil.virtual_memory', return_value=types.SimpleNamespace(available=1000)):
            self.assertEqual(module.available_memory(), 128)
        with patch.object(module, 'available_memory', return_value=0):
            with self.assertRaises(MemoryError):
                module._admit((1, 3, 6, 16, 16), os.environ.get('TMPDIR', str(HERE)), None, 8, 0)

    @unittest.skipUnless(HAS_TORCH and CORE.is_dir(), 'optional torch/Core absent')
    def test_model_guard(self):
        module = owned()
        self.assertTrue(hasattr(module, 'validate_h3'), 'strict H3 guard missing')
        import torch
        sys_path = str(CORE)
        import sys
        if not CORE.exists():
            self.skipTest('optional Core absent')
        if sys_path not in sys.path:
            sys.path.insert(0, sys_path)
        import comfy.options
        comfy.options.enable_args_parsing()
        previous = sys.argv
        try:
            sys.argv = ['test', '--cpu']
            from comfy.ldm.minimax.vae import MiniMaxH3VideoVAE
        finally:
            sys.argv = previous
        model = MiniMaxH3VideoVAE(encoder=False, decoder=False)
        model.decoder = types.SimpleNamespace(out_channels=3)
        vae = types.SimpleNamespace(first_stage_model=model, process_output=lambda x: x,
                                    vae_output_dtype=lambda: torch.float32)
        shape = module.validate_h3(vae, torch.zeros(1, 24, 7, 1, 1))
        self.assertEqual(shape, (1, 3, 22, 16, 16))
        for video in (torch.zeros(2, 24, 7, 1, 1), torch.zeros(1, 3, 7, 1, 1), 'bad'):
            with self.assertRaises(ValueError):
                module.validate_h3(vae, video)
        model.noncausal = True
        with self.assertRaises(ValueError):
            module.validate_h3(vae, torch.zeros(1, 24, 7, 1, 1))
        vae.first_stage_model = object()
        with self.assertRaises(ValueError):
            module.validate_h3(vae, torch.zeros(1, 24, 7, 1, 1))

    @unittest.skipUnless(HAS_TORCH, 'optional torch absent')
    def test_sink_invalid_layout_and_incomplete_write(self):
        import torch
        module = owned()
        with self.assertRaises(ValueError):
            module.FrameSink((2, 3, 4, 2, 2), lambda frame: None, lambda: None)
        sink = module.FrameSink((1, 3, 4, 2, 2), lambda frame: None, lambda: None)
        for key in ((slice(None),) * 5, (slice(None), slice(None), slice(1, 3), slice(None), slice(None))):
            with self.assertRaises(ValueError):
                sink[key]
        with self.assertRaises(ValueError):
            sink[:, :, 0:2, :, :].copy_(torch.zeros(1, 3, 2, 2, 2, dtype=torch.float16))
        with self.assertRaises(ValueError):
            sink.finish()


if __name__ == '__main__':
    unittest.main()
