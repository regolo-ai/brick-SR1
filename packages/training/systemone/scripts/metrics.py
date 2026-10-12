"""Compute metrics for multi-output ordinal regression (6 capability dims).

Per-dim: MAE, RMSE, Pearson r, Spearman rho, Brier score.
Aggregate: macro_pearson, macro_mae, macro_spearman.
Threshold-conditional macro-F1 at {0.3, 0.5, 0.7}.

Used as `compute_metrics` callback in HF Trainer.
"""
from __future__ import annotations
import numpy as np
from scipy.stats import pearsonr, spearmanr
from sklearn.metrics import f1_score

DIMS = ["instruction_following", "coding", "math_reasoning",
        "world_knowledge", "planning_agentic", "creative_synthesis"]


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def _safe_pearson(a: np.ndarray, b: np.ndarray) -> float:
    if a.std() == 0 or b.std() == 0:
        return 0.0
    return float(pearsonr(a, b)[0])


def _safe_spearman(a: np.ndarray, b: np.ndarray) -> float:
    if a.std() == 0 or b.std() == 0:
        return 0.0
    return float(spearmanr(a, b)[0])


def compute_metrics(eval_pred):
    logits, labels = eval_pred
    logits = np.asarray(logits, dtype=np.float32)
    labels = np.asarray(labels, dtype=np.float32)
    preds = _sigmoid(logits)
    out = {}
    per_pearson, per_mae, per_spearman = [], [], []

    for i, d in enumerate(DIMS):
        y_true = labels[:, i]
        y_pred = preds[:, i]
        mae = float(np.mean(np.abs(y_true - y_pred)))
        rmse = float(np.sqrt(np.mean((y_true - y_pred) ** 2)))
        brier = float(np.mean((y_true - y_pred) ** 2))
        p = _safe_pearson(y_true, y_pred)
        s = _safe_spearman(y_true, y_pred)
        out[f"mae_{d}"] = mae
        out[f"rmse_{d}"] = rmse
        out[f"brier_{d}"] = brier
        out[f"pearson_{d}"] = p
        out[f"spearman_{d}"] = s
        per_pearson.append(p)
        per_mae.append(mae)
        per_spearman.append(s)

    out["pearson_macro"] = float(np.mean(per_pearson))
    out["mae_macro"] = float(np.mean(per_mae))
    out["spearman_macro"] = float(np.mean(per_spearman))

    # threshold-conditional macro-F1
    for t in (0.3, 0.5, 0.7):
        f1s = []
        for i in range(len(DIMS)):
            y_bin = (labels[:, i] >= t).astype(int)
            p_bin = (preds[:, i] >= t).astype(int)
            if y_bin.sum() == 0 and p_bin.sum() == 0:
                f1s.append(1.0)
            else:
                f1s.append(f1_score(y_bin, p_bin, zero_division=0))
        out[f"f1_macro_t{int(t * 10)}"] = float(np.mean(f1s))

    return out
