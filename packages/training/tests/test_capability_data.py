"""Offline checks for the retained training data/metric contract."""

import csv
import importlib.util
from pathlib import Path

import numpy as np

SCRIPTS = Path(__file__).resolve().parents[1] / "modernbert/scripts"


def load(name):
    spec = importlib.util.spec_from_file_location(f"training_{name}", SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_human_csv_preserves_checkpoint_label_order(tmp_path):
    loader = load("dataset_loader")
    columns = [
        "creative_synthesis",
        "planning_agentic",
        "world_knowledge",
        "math_reasoning",
        "coding",
        "instruction_following",
    ]
    path = tmp_path / "human.csv"
    with path.open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=["query_id", "query", *columns])
        writer.writeheader()
        writer.writerow(
            dict(
                query_id="one", query="short prompt", **dict(zip(columns, [0.6, 0.5, 0.4, 0.3, 0.2, 0.1], strict=True))
            )
        )

    def tokenize(texts, *, truncation, max_length):
        assert truncation and max_length == 512
        return {"input_ids": [[1, 2] for _ in texts], "attention_mask": [[1, 1] for _ in texts]}

    dataset = loader.build_human_eval(tokenize, csv_path=path)
    assert dataset.column_names == ["labels", "input_ids", "attention_mask"]
    assert dataset[0]["labels"] == [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]


def test_training_metrics_are_independent_probabilities_not_softmax():
    metrics = load("metrics")
    labels = np.array([[0.1] * 6, [0.5] * 6, [0.9] * 6], dtype=np.float32)
    logits = np.log(labels / (1 - labels))
    result = metrics.compute_metrics((logits, labels))
    assert result["mae_macro"] < 1e-6
    assert result["pearson_macro"] > 0.99999
    assert result["f1_macro_t5"] == 1
    constant = metrics.compute_metrics((np.zeros((3, 6)), np.full((3, 6), 0.5)))
    assert constant["pearson_macro"] == 0
    assert constant["mae_macro"] == 0
