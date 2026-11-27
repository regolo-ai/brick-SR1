#!/usr/bin/env python3
"""Verify SystemOne numerics on a CUDA host.

The checkpoint must already be present on disk (for example the directory the
Brick installer verifies). The script gates on three properties:

1. device parity: CPU fp32 and CUDA fp32 logits agree within FP32_TOLERANCE;
2. attention parity: CUDA fp32 SDPA and eager agree within ATTENTION_TOLERANCE;
3. bf16 parity: CUDA bf16 stays within BF16_RELATIVE_TOLERANCE of the CPU fp32
   reference, measured relative to the logit magnitude, and the per-prompt
   ranking of the six capability logits is unchanged.

Use --save-reference on one interpreter and --reference on another to compare
two torch builds: the saved file is the CPU fp32 reference produced by the
baseline torch, and the second run adds a version-drift gate against it.

It exits non-zero when a property is violated, which is the release gate for
GPU/attention changes.
"""

from __future__ import annotations

import argparse
import sys

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

PROMPTS = [
    "Write a Python function that reverses a linked list.",
    "Summarize the causes of the French Revolution in three sentences.",
    "Prove that the square root of two is irrational.",
    "Draft a friendly email asking a colleague to review a pull request.",
    "Plan a five-step migration from a monolith to microservices.",
    "Explain how a transformer attention head works to a new engineer.",
]
FP32_TOLERANCE = 1e-3
ATTENTION_TOLERANCE = 1e-4
BF16_RELATIVE_TOLERANCE = 0.03


def load(path: str, device: str, dtype: torch.dtype, attention: str):
    model = AutoModelForSequenceClassification.from_pretrained(
        path, dtype=dtype, attn_implementation=attention, local_files_only=True
    ).to(device)
    model.eval()
    return model


def logits(model, tokenizer, device: str) -> torch.Tensor:
    batch = tokenizer(PROMPTS, return_tensors="pt", padding=True, truncation=True, max_length=512).to(device)
    with torch.no_grad():
        output = model(**batch)
    return output.logits.float().cpu()


def ranking(tensor: torch.Tensor) -> list[list[int]]:
    return [row.argsort(descending=True).tolist() for row in tensor]


def relative_drift(reference: torch.Tensor, candidate: torch.Tensor) -> float:
    return (reference - candidate).abs().div(reference.abs() + 1.0).max().item()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--save-reference", metavar="PATH", help="write CPU fp32 logits for a later --reference run")
    parser.add_argument(
        "--reference", metavar="PATH", help="use saved CPU fp32 logits as the baseline instead of the local CPU run"
    )
    arguments = parser.parse_args()

    if arguments.save_reference is None and not torch.cuda.is_available():
        print("CUDA is not available; run this gate on a GPU host.", file=sys.stderr)
        return 2

    tokenizer = AutoTokenizer.from_pretrained(arguments.model_dir, local_files_only=True)
    cpu_fp32 = logits(load(arguments.model_dir, "cpu", torch.float32, "sdpa"), tokenizer, "cpu")
    if arguments.save_reference is not None:
        torch.save(cpu_fp32, arguments.save_reference)
        print(f"torch={torch.__version__} saved CPU fp32 reference to {arguments.save_reference}")
        return 0

    baseline = cpu_fp32
    version_drift = None
    if arguments.reference is not None:
        baseline = torch.load(arguments.reference, weights_only=True).float()
        version_drift = (baseline - cpu_fp32).abs().max().item()

    cuda_fp32 = logits(load(arguments.model_dir, "cuda", torch.float32, "sdpa"), tokenizer, "cuda")
    eager_fp32 = logits(load(arguments.model_dir, "cuda", torch.float32, "eager"), tokenizer, "cuda")
    cuda_bf16 = logits(load(arguments.model_dir, "cuda", torch.bfloat16, "sdpa"), tokenizer, "cuda")

    device_parity = (cpu_fp32 - cuda_fp32).abs().max().item()
    attention_parity = (cuda_fp32 - eager_fp32).abs().max().item()
    bf16_drift = relative_drift(baseline, cuda_bf16)
    order_stable = ranking(baseline) == ranking(cuda_bf16)

    print(f"torch={torch.__version__} device={torch.cuda.get_device_name(0)}")
    print(f"logit_abs_max={cpu_fp32.abs().max().item():.3f}")
    if version_drift is not None:
        print(f"reference_vs_cpu_fp32_max_abs={version_drift:.6f}")
    print(f"cpu_fp32_vs_cuda_fp32_max_abs={device_parity:.6f}")
    print(f"cuda_fp32_sdpa_vs_eager_max_abs={attention_parity:.6f}")
    print(f"cpu_fp32_vs_cuda_bf16_max_relative={bf16_drift:.6f}")
    print(f"capability_ranking_stable={order_stable}")

    failures = []
    if version_drift is not None and version_drift > FP32_TOLERANCE:
        failures.append(f"torch version drift {version_drift:.6f} exceeds {FP32_TOLERANCE}")
    if device_parity > FP32_TOLERANCE:
        failures.append(f"CPU/CUDA fp32 drift {device_parity:.6f} exceeds {FP32_TOLERANCE}")
    if attention_parity > ATTENTION_TOLERANCE:
        failures.append(f"SDPA/eager drift {attention_parity:.6f} exceeds {ATTENTION_TOLERANCE}")
    if bf16_drift > BF16_RELATIVE_TOLERANCE:
        failures.append(f"bf16 relative drift {bf16_drift:.6f} exceeds {BF16_RELATIVE_TOLERANCE}")
    if not order_stable:
        failures.append("capability ranking changed between CPU fp32 and CUDA bf16")
    if failures:
        for failure in failures:
            print(f"CUDA parity failed: {failure}", file=sys.stderr)
        return 1
    print("CUDA parity OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
