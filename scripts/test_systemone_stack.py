#!/usr/bin/env python3
"""Verify the production SystemOne worker against Transformers FP32."""

import argparse
import gc
import json
import subprocess
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assets", type=Path)
    args = parser.parse_args()
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    torch.set_num_threads(4)
    texts = [
        "Hello!",
        "Write a Python function to sort integers.",
        "Solve 3x + 7 = 22 and explain each step.",
        "asdf !!! 123 zzz",
        "Explain this code: " + "value = value + 1\n" * 110,
    ]
    tokenizer = AutoTokenizer.from_pretrained(args.assets, local_files_only=True)
    model = AutoModelForSequenceClassification.from_pretrained(
        args.assets,
        local_files_only=True,
        dtype=torch.float32,
        attn_implementation="eager",
    ).eval()
    references = []
    for text in texts:
        encoded = tokenizer(text, return_tensors="pt", truncation=True, max_length=8192)
        with torch.inference_mode():
            references.append((model(**encoded).logits[0].sigmoid().tolist(), encoded.input_ids.shape[1]))
    del model
    gc.collect()
    worker = Path(__file__).resolve().parents[1] / "apps/router/systemone/systemone_worker.py"
    with subprocess.Popen(
        [sys.executable, "-u", str(worker), str(args.assets.resolve())],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    ) as process:
        try:
            ready = json.loads(process.stdout.readline())
            assert ready["ready"] and ready["device"] == "cpu", ready
            assert ready["dtype"] == "torch.float32" and ready["attention"] == "sdpa", ready
            maximum = 0.0
            for text, (expected, length) in zip(texts, references, strict=True):
                process.stdin.write(json.dumps({"text": text}) + "\n")
                process.stdin.flush()
                response = json.loads(process.stdout.readline())
                actual = response["probabilities"]
                delta = max(abs(a - b) for a, b in zip(actual, expected, strict=True))
                assert delta <= 1e-4, delta
                maximum = max(maximum, delta)
                print(json.dumps({"tokens": length, "max_error": delta}), flush=True)
            process.stdin.close()
            assert process.wait(timeout=30) == 0
            print(f"PyTorch SDPA worker parity passed; maximum error {maximum:.8g}")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


if __name__ == "__main__":
    main()
