#!/usr/bin/env python3
"""Verify real SystemOne vectors retain their label order through Go routing."""

import json
import subprocess
import sys
import tempfile
from pathlib import Path


def main():
    binary, assets = (str(Path(value).resolve()) for value in sys.argv[1:3])
    labels = [
        "instruction_following",
        "coding",
        "math_reasoning",
        "world_knowledge",
        "planning_agentic",
        "creative_synthesis",
    ]
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    torch.set_num_threads(4)
    tokenizer = AutoTokenizer.from_pretrained(assets, local_files_only=True)
    model = AutoModelForSequenceClassification.from_pretrained(
        assets, local_files_only=True, dtype=torch.float32, attn_implementation="sdpa"
    ).eval()
    with torch.inference_mode():
        expected = model(**tokenizer("Hello.", return_tensors="pt")).logits[0].sigmoid().tolist()
    del model
    for dimensions in [labels, sorted(labels)]:
        with tempfile.TemporaryDirectory(prefix="brick-labels-") as directory:
            config = {
                "config_version": 2,
                "default_model": "test",
                "model_config": {"test": {}},
                "skill_router": {
                    "enabled": True,
                    "knob": 0,
                    "capabilities": dimensions,
                    "systemone": {"local_path": assets},
                    "models": [{"model": "test", "skill_vector": [0.5] * 6}],
                },
            }
            path = Path(directory) / "config.yaml"
            path.write_text(json.dumps(config))
            output = subprocess.check_output(
                [binary, "--config", str(path), "--metrics-port", "0", "--route-test", "Hello."], text=True
            )
            result = json.loads(output)
            assert result["model"] == "test" and result["knob"] == 0
            assert max(abs(a - b) for a, b in zip(result["query_vector"], expected, strict=True)) <= 1e-4
            assert result["query_vector"] == result["scaled_vector"]
            assert result["distances"][0]["model"] == "test"
    print("PASS: real SystemOne vectors use canonical label order for both profile dimension orders")


if __name__ == "__main__":
    main()
