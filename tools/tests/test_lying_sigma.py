"""Sampler contract with scalar/model doubles; no Torch, custom packs or inference."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deas_lying_sigma_fixture', Path(__file__).resolve().parents[2] / 'src-tauri/src/lying_sigma.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class Sigma(float):
    def max(self): return self
    def detach(self): return self
    def cpu(self): return self


class KSampler:
    def __init__(self, sampler_function, extra_options=None, inpaint_options=None):
        self.sampler_function = sampler_function
        self.extra_options = extra_options or {}
        self.inpaint_options = inpaint_options or {}


class LyingSigmaTests(unittest.TestCase):
    def test_namespaced_registration_defaults_and_socket_contract(self):
        self.assertEqual(set(adapter.NODE_CLASS_MAPPINGS), {'DEAS_LyingSigmaSampler'})
        node = adapter.LyingSigmaSampler
        self.assertEqual(node.RETURN_TYPES, ('SAMPLER',))
        inputs = node.INPUT_TYPES()
        self.assertEqual(inputs['required']['sampler'], ('SAMPLER',))
        self.assertEqual(inputs['required']['dishonesty_factor'][1]['default'], 0)
        self.assertEqual(inputs['required']['dishonesty_factor'][1]['step'], 0.01)
        self.assertEqual(inputs['optional']['start_percent'][1]['default'], 0.25)
        self.assertEqual(inputs['optional']['end_percent'][1]['default'], 0.9)

    def test_zero_returns_the_original_sampler_without_importing_comfy(self):
        original = object()
        with patch.dict(sys.modules, {'comfy': None, 'comfy.samplers': None}):
            self.assertIs(adapter.LyingSigmaSampler.wrap(original, 0)[0], original)

    def test_wrapper_preserves_sampler_and_inpaint_options_without_mutating_them(self):
        original = KSampler(object(), {'eta': 0.75}, {'random': True})
        samplers = types.ModuleType('comfy.samplers')
        samplers.KSAMPLER = KSampler
        with patch.dict(sys.modules, {'comfy': types.ModuleType('comfy'), 'comfy.samplers': samplers}):
            wrapped, = adapter.LyingSigmaSampler.wrap(original, -0.1)
        self.assertIs(wrapped.extra_options['lss_wrapped_sampler'], original)
        self.assertIs(wrapped.inpaint_options, original.inpaint_options)
        self.assertEqual(wrapped.extra_options['lss_startend_percent'], (0.25, 0.9))
        self.assertEqual(original.extra_options, {'eta': 0.75})

    def test_only_reported_sigma_changes_inside_the_model_percentage_window(self):
        for factor, expected in [(-0.1, [9, 6.75, 4.5, 0.9, 0.5]), (0.1, [9, 8.25, 5.5, 1.1, 0.5])]:
            with self.subTest(factor=factor):
                seen, calls = [], []
                x, schedule, extra_args, callback = object(), object(), {'seed': 42, 'denoise_mask': object()}, object()
                sampling = types.SimpleNamespace(percent_to_sigma=lambda percent: calls.append(percent) or 10 * (1 - percent))
                class Model:
                    inner_model = types.SimpleNamespace(inner_model=types.SimpleNamespace(model_sampling=sampling))
                    sigmas = schedule
                    def __call__(self, latent, sigma, **kwargs):
                        self_test.assertIs(latent, x)
                        self_test.assertIs(kwargs['sentinel'], extra_args)
                        seen.append(float(sigma))
                        return latent
                self_test = self
                model = Model()
                def sample(wrapped_model, latent, sigmas, **kwargs):
                    self.assertIs(latent, x)
                    self.assertIs(sigmas, schedule)
                    self.assertIs(wrapped_model.inner_model, model.inner_model)
                    self.assertIs(wrapped_model.sigmas, schedule)
                    self.assertIs(kwargs['extra_args'], extra_args)
                    self.assertIs(kwargs['callback'], callback)
                    self.assertTrue(kwargs['disable'])
                    self.assertEqual(kwargs['eta'], 0.75)
                    for sigma in [9, 7.5, 5, 1, 0.5]:
                        wrapped_model(x, Sigma(sigma), sentinel=extra_args)
                    return latent
                original = KSampler(sample, {'eta': 0.75})
                result = adapter.lying_sigma_sampler(model, x, schedule, lss_wrapped_sampler=original,
                    lss_dishonesty_factor=factor, lss_startend_percent=(0.25, 0.9),
                    extra_args=extra_args, callback=callback, disable=True)
                self.assertIs(result, x)
                self.assertEqual(calls, [0.25, 0.9])
                for actual, target in zip(seen, expected): self.assertAlmostEqual(actual, target)
                self.assertEqual(extra_args['seed'], 42)

    def test_rounding_matches_the_reviewed_algorithm_at_window_boundaries(self):
        seen = []
        sampling = types.SimpleNamespace(percent_to_sigma=lambda p: 7.500049 if p == 0.25 else 0.999951)
        class Model:
            inner_model = types.SimpleNamespace(inner_model=types.SimpleNamespace(model_sampling=sampling))
            def __call__(self, latent, sigma, **kwargs): seen.append(float(sigma))
        def sample(model, x, sigmas):
            for sigma in [7.50001, 7.5, 1.0, 0.99999]: model(x, Sigma(sigma))
        adapter.lying_sigma_sampler(Model(), None, None, lss_wrapped_sampler=KSampler(sample), lss_dishonesty_factor=-0.1, lss_startend_percent=(0.25, 0.9))
        for actual, target in zip(seen, [7.50001, 6.75, 0.9, 0.99999]): self.assertAlmostEqual(actual, target)

    def test_invalid_strength_and_timing_fail_before_import_or_execution(self):
        for factor, start, end in [(float('nan'), 0.25, 0.9), (float('inf'), 0.25, 0.9), (-1, 0.25, 0.9), (1.01, 0.25, 0.9), (0, 0.9, 0.25), (0, 0.25, 1.01), (0, -0.01, 0.9), (0, 0.5, 0.5)]:
            with self.subTest(factor=factor, start=start, end=end), self.assertRaisesRegex(ValueError, 'DEAS Lying Sigma'):
                adapter.LyingSigmaSampler.wrap(object(), factor, start_percent=start, end_percent=end)


if __name__ == '__main__': unittest.main()
