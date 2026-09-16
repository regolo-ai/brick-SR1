#!/usr/bin/env python3
"""Verify the packaged ABI with real assets and the pre-refactoring corpus."""

import concurrent.futures
import ctypes
import json
import sys
from pathlib import Path


def main():
    library, assets = map(Path, sys.argv[1:3])
    baseline = json.loads(
        (
            Path(__file__).resolve().parents[1] / "apps/router/candle-binding/testdata/capability-baseline.json"
        ).read_text()
    )
    lib = ctypes.CDLL(str(library.resolve()))
    lib.brick_model_load.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_size_t]
    lib.brick_classify.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_float), ctypes.c_char_p, ctypes.c_size_t]
    error = ctypes.create_string_buffer(1024)
    output = (ctypes.c_float * 6)(*[-1] * 6)
    assert lib.brick_classify(b"test", output, error, len(error)) == -1
    assert lib.brick_model_load(b"/does/not/exist", error, len(error)) == -1
    assert lib.brick_model_load(str(assets.resolve()).encode(), error, len(error)) == 0, error.value
    assert lib.brick_classify(None, output, error, len(error)) == -1
    assert lib.brick_classify(b"\xff", output, error, len(error)) == -1
    assert list(output) == [-1] * 6
    metadata = json.loads((assets / "config.json").read_text())
    assert metadata["id2label"] == baseline["labels"]

    def check(row):
        error = ctypes.create_string_buffer(1024)
        output = (ctypes.c_float * 6)()
        assert lib.brick_classify(row["text"].encode(), output, error, len(error)) == 0, error.value
        delta = max(abs(a - b) for a, b in zip(output, row["probabilities"], strict=True))
        assert delta < 1e-6, (row["text"], delta)
        return delta

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        errors = list(executor.map(check, baseline["cases"] * 3))
    print(f"{len(errors)} real-model comparisons passed; max absolute error: {max(errors)}")


if __name__ == "__main__":
    main()
