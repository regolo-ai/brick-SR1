"""Smoke test: configs/sources.yaml legge correttamente, normalizers registry consistente."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import configs_dir, load_yaml
from brick_evals.normalize import NORMALIZERS


def test_sources_yaml_valid():
    cfg = load_yaml(configs_dir() / "sources.yaml")
    assert "_meta" in cfg
    assert isinstance(cfg["_meta"]["seed"], int)


def test_models_yaml_valid():
    cfg = load_yaml(configs_dir() / "models.yaml")
    aliases = [v.get("alias") for v in cfg.values() if isinstance(v, dict)]
    assert "qwen3.5-9b" in aliases
    assert "deepseek-v4-flash" in aliases
    assert "kimi2.6" in aliases


def test_prompts_yaml_valid():
    cfg = load_yaml(configs_dir() / "prompts.yaml")
    for required in ("fewshot_cot", "fewshot_cot_math", "agentic_zero_shot", "simpleqa_zero_shot"):
        assert required in cfg


def test_protocols_yaml_valid():
    cfg = load_yaml(configs_dir() / "protocols.yaml")
    for proto in ("ifeval_constraint_check", "lcb_unit_test", "math_equiv", "rubric_judge"):
        assert proto in cfg


def test_normalizers_match_sources():
    sources = load_yaml(configs_dir() / "sources.yaml")
    src_ids = {sid for sid in sources if not sid.startswith("_") and isinstance(sources[sid], dict)}
    norm_ids = set(NORMALIZERS.keys())
    missing = src_ids - norm_ids
    assert not missing, f"normalizers missing for: {missing}"
