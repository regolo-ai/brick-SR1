#!/usr/bin/env python3
"""Generate golden test cases for the Go router math parity test.

Reuses the canonical reference implementation verbatim
(packages/evals/baselines/sweep_knob_aggressive.py: effective_knob_params and
the evaluate_knob scoring math) to produce
apps/router/src/spatial-router/pkg/brickrouting/testdata/paper_golden.json.

The Go test (paper_parity_test.go) recomputes every case and compares the
effective parameters, the per-model objective J, and the argmin at 1e-9.
"""

from __future__ import annotations

import json
import math
import random
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parents[1] / "baselines"
sys.path.insert(0, str(BASE))

from sweep_knob_aggressive import effective_knob_params  # type: ignore  # noqa: E402

OUT = (
    Path(__file__).resolve().parents[3]
    / "apps"
    / "router"
    / "src"
    / "spatial-router"
    / "pkg"
    / "brickrouting"
    / "testdata"
    / "paper_golden.json"
)

CLIP_MIN = 0.02
CLIP_MAX = 0.98

# Locked production math configuration (paper Table 7) — must equal the Go
# defaults in pkg/brickrouting/router.go and the TS schema defaults.
LOCKED = {
    "complexity_mu": 0.345170,
    "complexity_bias": 0.822235,
    "cost_penalty_beta": 0.230778,
    "over_penalty_lambda": 0.045207,
    "preference_power": 2.920351,
    "max_mu_multiplier": 13.034935,
    "max_bias_shift": 5.294173,
    "max_cost_relief": 6559.073066,
    "max_over_relief": 49.547940,
    "min_mu_multiplier": 0.081493,
    "min_bias_shift": -1.349259,
    "min_cost_boost": 8.834043,
    "min_over_boost": 1002.068256,
}

# Paper skill vectors (Table 7) + normalized costs.
MODELS = [
    {
        "model": "qwen",
        "skill_vector": [0.714788, 0.511538, 0.810109, 0.912146, 0.577072, 0.179876],
        "cost_weight": 0.10,
    },
    {"model": "ds4", "skill_vector": [0.820939, 0.657845, 0.863112, 0.934963, 0.62055, 0.488518], "cost_weight": 0.40},
    {"model": "kimi", "skill_vector": [0.904272, 0.751595, 0.87018, 0.943892, 0.641863, 0.344074], "cost_weight": 0.60},
]

KNOBS = (-1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 1.0)


def logit(value: float) -> float:
    value = min(max(value, CLIP_MIN), CLIP_MAX)
    return math.log(value / (1 - value))


def score_case(prob: list[float], tau_q: float, eff: dict[str, float]) -> list[dict[str, float]]:
    zq = eff["complexity_bias"] + eff["complexity_mu"] * logit(tau_q)
    out = []
    for m in MODELS:
        under_sum = 0.0
        over_sum = 0.0
        expected = 0.0
        for p, s in zip(prob, m["skill_vector"], strict=False):
            requirement = p * zq
            model_value = p * logit(s)
            under = max(0.0, requirement - model_value)
            over = max(0.0, model_value - requirement)
            under_sum += under * under
            over_sum += over * over
            expected += p * s
        distance = math.sqrt(under_sum + eff["over_penalty_lambda"] * over_sum)
        score = distance + eff["cost_penalty_beta"] * m["cost_weight"]
        out.append(
            {
                "model": m["model"],
                "distance": distance,
                "score": score,
                "expected_success": expected,
            }
        )
    return out


def random_simplex(rnd: random.Random, n: int) -> list[float]:
    raw = [rnd.random() for _ in range(n)]
    total = sum(raw)
    return [v / total for v in raw]


def main() -> None:
    rnd = random.Random(42)
    cases = []
    case_id = 0
    for r in KNOBS:
        eff = effective_knob_params(LOCKED, r)
        for _ in range(6):
            # Mix of peaked and flat capability distributions + tau range.
            if rnd.random() < 0.5:
                prob = random_simplex(rnd, 6)
            else:
                prob = [0.02] * 6
                prob[rnd.randrange(6)] = 0.9
                total = sum(prob)
                prob = [v / total for v in prob]
            tau_q = rnd.uniform(0.40, 0.95)
            scores = score_case(prob, tau_q, eff)
            argmin = min(range(len(scores)), key=lambda i: scores[i]["score"])
            cases.append(
                {
                    "id": case_id,
                    "routing_preference": r,
                    "probabilities": prob,
                    "tau_query": tau_q,
                    "effective": {
                        "mu": eff["complexity_mu"],
                        "bias": eff["complexity_bias"],
                        "beta": eff["cost_penalty_beta"],
                        "lambda": eff["over_penalty_lambda"],
                    },
                    "scores": scores,
                    "argmin_model": scores[argmin]["model"],
                }
            )
            case_id += 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "locked_params": LOCKED,
        "models": MODELS,
        "clip_min": CLIP_MIN,
        "clip_max": CLIP_MAX,
        "cases": cases,
    }
    OUT.write_text(json.dumps(payload, indent=1) + "\n")
    print(f"wrote {len(cases)} golden cases to {OUT}")


if __name__ == "__main__":
    main()
