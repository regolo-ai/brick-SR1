#!/usr/bin/env python3
"""Single-trial Brick V2 router evaluator for W&B Bayesian sweep agents.

Reads params from W&B run config, evaluates dev + holdout, logs metrics.
Usage: `wandb agent <sweep_id>` calls this with params from sweep YAML.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sweep_brick_v2_wandb import (  # type: ignore
    COMPARISON_INPUT,
    DEBUG_INPUT,
    SKILL_VECTORS_6,
    calibrate_skills,
    evaluate_prepared,
    prepare_arrays,
    rows_from_debug,
    split_rows,
)


def main():
    import wandb

    key_path = Path.home() / ".wandb_key"
    if key_path.exists() and not os.environ.get("WANDB_API_KEY"):
        os.environ["WANDB_API_KEY"] = key_path.read_text().strip()

    run = wandb.init(job_type="risk_sweep_v2_bayes")
    cfg = dict(run.config)

    use_calibrated = cfg.get("calibrate_skills", True)
    dev_fraction = float(cfg.get("dev_fraction", 0.70))
    seed = cfg.get("seed", "brick-v2-bayes")
    tau_mode = cfg.get("tau_mode", "raw")

    rows = rows_from_debug(Path(DEBUG_INPUT), Path(COMPARISON_INPUT))
    dev, holdout = split_rows(rows, dev_fraction, seed)
    skill_vectors = calibrate_skills(dev) if use_calibrated else SKILL_VECTORS_6

    dev_arr = prepare_arrays(dev, skill_vectors)
    hold_arr = prepare_arrays(holdout, skill_vectors)

    params = {
        "routing_preference": float(cfg["routing_preference"]),
        "complexity_mu": float(cfg["complexity_mu"]),
        "complexity_bias": float(cfg["complexity_bias"]),
        "cost_penalty_beta": float(cfg["cost_penalty_beta"]),
        "over_penalty_lambda": float(cfg["over_penalty_lambda"]),
        "tau_base": float(cfg["tau_base"]),
        "tau_override_mode": tau_mode,
    }

    dev_m = evaluate_prepared(dev_arr, params)
    hold_m = evaluate_prepared(hold_arr, params)

    log = {"n_dev": len(dev), "n_holdout": len(holdout), "calibrated": use_calibrated}
    log.update({f"dev_{k}": v for k, v in dev_m.items()})
    log.update({f"holdout_{k}": v for k, v in hold_m.items()})
    wandb.log(log)
    for k, v in log.items():
        if isinstance(v, int | float | bool):
            run.summary[k] = v
    print(f"holdout_accuracy={hold_m['accuracy']:.4f} avg_cost={hold_m['avg_cost']:.4f}")
    wandb.finish()


if __name__ == "__main__":
    main()
