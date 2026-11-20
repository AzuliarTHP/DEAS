"""Contract: GGUF-style layers reach Core's eager branch; Core layers keep the fused path."""
import sys
import unittest
from types import ModuleType

calls = []


def core(linear, x, input_act, *args, **kwargs):
    calls.append(("eager" if getattr(linear, "comfy_force_forward", False) else "fused", args, kwargs))
    return "out"


comfy = ModuleType("comfy")
ops = ModuleType("comfy.ops")
ops.linear_input_act = core
comfy.ops = ops
sys.modules["comfy"], sys.modules["comfy.ops"] = comfy, ops
adapter = ModuleType("deas_gguf_core_compat_test")
exec(compile(sys.argv.pop(1), "gguf_core_compat.py", "exec"), adapter.__dict__)


class CoreLinear:  # Core layers cast through the module-level function.
    comfy_force_forward = False


class GGMLLinear(CoreLinear):  # ComfyUI-GGUF: dequantizes in its own method.
    def cast_bias_weight(self, input=None, dtype=None, device=None, bias_dtype=None):
        raise AssertionError("not called by the adapter")


class Tests(unittest.TestCase):
    def setUp(self):
        calls.clear()

    def test_gguf_layer_takes_the_eager_branch_and_flag_is_restored(self):
        layer = GGMLLinear()
        self.assertEqual(ops.linear_input_act(layer, "x", "gelu_tanh", residual="r"), "out")
        self.assertEqual(calls, [("eager", (), {"residual": "r"})])
        self.assertNotIn("comfy_force_forward", layer.__dict__)
        self.assertFalse(layer.comfy_force_forward)
        layer.comfy_force_forward = True  # e.g. Core's bypass adapter
        ops.linear_input_act(layer, "x", None)
        self.assertTrue(layer.__dict__["comfy_force_forward"])

    def test_core_layers_keep_the_fused_path(self):
        ops.linear_input_act(CoreLinear(), "x", "swiglu")
        self.assertEqual(calls, [("fused", (), {})])

    def test_wrapping_is_idempotent_and_absent_core_is_left_alone(self):
        wrapped = ops.linear_input_act
        self.assertTrue(wrapped._deas_gguf_compat)
        self.assertIs(wrapped.__wrapped__, core)
        self.assertIs(adapter.wrap(wrapped), wrapped)
        self.assertIsNone(adapter.wrap(None))

    def test_exception_restores_flag(self):
        def failing(linear, *a, **k):
            raise RuntimeError("boom")
        layer = GGMLLinear()
        with self.assertRaises(RuntimeError):
            adapter.wrap(failing)(layer, "x", None)
        self.assertNotIn("comfy_force_forward", layer.__dict__)


unittest.main(argv=["gguf_core_compat"], exit=True)
