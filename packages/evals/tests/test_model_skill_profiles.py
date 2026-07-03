from __future__ import annotations

import importlib.util
from collections import Counter
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "140_extract_model_skill_profiles.py"


def load_module():
    spec = importlib.util.spec_from_file_location("extract_model_skill_profiles", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_compute_profiles_uses_bayesian_smoothing() -> None:
    mod = load_module()
    correct = {model: Counter({cap: 0 for cap in mod.CAPABILITIES}) for model in mod.MODEL_COLUMNS}
    support = {model: Counter({cap: 0 for cap in mod.CAPABILITIES}) for model in mod.MODEL_COLUMNS}

    correct["qwen3.5-9b"]["coding"] = 1
    support["qwen3.5-9b"]["coding"] = 2
    correct["deepseek-v4-flash"]["coding"] = 2
    support["deepseek-v4-flash"]["coding"] = 2
    correct["kimi2.6"]["coding"] = 0
    support["kimi2.6"]["coding"] = 2

    for cap in mod.CAPABILITIES:
        if cap == "coding":
            continue
        for model in mod.MODEL_COLUMNS:
            correct[model][cap] = 1
            support[model][cap] = 1

    out = mod.compute_profiles(correct, support, prior_strength=2)
    assert out["global_prior"]["coding"] == 0.5
    assert out["models"]["qwen3.5-9b"]["ability"]["coding"] == 0.5
    assert out["models"]["deepseek-v4-flash"]["ability"]["coding"] == 0.75
    assert out["models"]["kimi2.6"]["ability"]["coding"] == 0.25


def test_aggregate_maps_multiturn_dimension_to_planning_agentic() -> None:
    mod = load_module()
    rows = [
        {
            "dimension": "planning_agentic_multiturn",
            "qwen_correct": True,
            "ds4_correct": False,
            "kimi_correct": None,
        }
    ]

    correct, support, total_rows, dimensions = mod.aggregate(rows)
    assert total_rows == 1
    assert dimensions["planning_agentic"] == 1
    assert support["qwen3.5-9b"]["planning_agentic"] == 1
    assert correct["qwen3.5-9b"]["planning_agentic"] == 1
    assert correct["deepseek-v4-flash"]["planning_agentic"] == 0
    assert correct["kimi2.6"]["planning_agentic"] == 0
