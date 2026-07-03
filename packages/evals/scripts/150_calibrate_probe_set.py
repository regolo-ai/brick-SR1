#!/usr/bin/env python3
"""Build the frozen skill-probe set for `brick skills extract` and calibrate K.

Inputs (offline, already in the repo):
  - per-model deterministic graded results (qwen3.5-9b, deepseek-v4-flash, kimi2.6)
  - scientificv1/data/final/hub_split/all/train.jsonl (query text + expected answer)

Method
  1. Join correctness of the 3 known models per query_id (verifiable protocols only).
  2. Keep DISCRIMINATIVE questions: pass-rate strictly between 0 and 1 across the
     3 models (questions everyone solves or nobody solves carry no signal),
     plus a slice of hard-for-all questions to anchor the low end.
  3. K calibration per category: smallest K whose bootstrap 95% CIs of the
     Bayesian-smoothed accuracies separate the CLOSEST pair of models.
  4. Anchor mapping: store (probe_accuracy, paper_skill) anchors of the 3 known
     models so `brick skills extract` can map a new model's probe accuracy onto
     the paper skill-vector scale via piecewise-linear interpolation.

Output
  - apps/cli/templates/skill-probe-set.jsonl  (one question per line)
  - probe set header (first line) carries metadata: K per category, anchors,
    subset hash, capability order.

Only categories gradable WITHOUT an LLM judge and WITHOUT code execution are
included in v1: math_reasoning (math_equiv + gsm8k_final_answer) and
world_knowledge (mcq_letter). coding (lcb_unit_test) requires sandboxed
execution and ships later behind --allow-code-exec; ifeval needs a constraint
checker port. Their skill coordinates keep coming from the public benchmark
table / prior.
"""

from __future__ import annotations

import hashlib
import json
import random
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[3].parent  # /root/forkGO
SCI = REPO / "scientificv1" / "data"
OUT = Path(__file__).resolve().parents[3] / "apps" / "cli" / "templates" / "skill-probe-set.jsonl"

GRADED = {
    "qwen3.5-9b": SCI / "inference" / "qwen3.5-9b" / "individualruns" / "outputs" / "qwen35_9b_full_graded_v2.jsonl",
    "deepseek-v4-flash": SCI / "inference" / "deepseek-v4-flash" / "dataset_a_deterministic_graded.jsonl",
    "kimi2.6": SCI / "inference" / "kimi2.6" / "dataset_a_deterministic_graded.jsonl",
}
HUB_ALL = SCI / "final" / "hub_split" / "all" / "train.jsonl"

# v1 verifiable categories -> accepted evaluation protocols.
CATEGORY_PROTOCOLS = {
    "math_reasoning": {"math_equiv", "gsm8k_final_answer"},
    "world_knowledge": {"mcq_letter"},
}

# Paper skill vectors (capability order: coding, creative_synthesis,
# instruction_following, math_reasoning, planning_agentic, world_knowledge).
CAPS = [
    "coding",
    "creative_synthesis",
    "instruction_following",
    "math_reasoning",
    "planning_agentic",
    "world_knowledge",
]
PAPER_SKILLS = {
    "qwen3.5-9b": [0.714788, 0.511538, 0.810109, 0.912146, 0.577072, 0.179876],
    "deepseek-v4-flash": [0.820939, 0.657845, 0.863112, 0.934963, 0.62055, 0.488518],
    "kimi2.6": [0.904272, 0.751595, 0.87018, 0.943892, 0.641863, 0.344074],
}

PRIOR_STRENGTH = 8.0
MAX_K = 120  # cap per category: extract cost ceiling
K_GRID = list(range(20, MAX_K + 1, 10))
BOOTSTRAP = 400
SEED = 42
HARD_ANCHOR_FRACTION = 0.25  # slice of all-fail questions appended for low-end anchoring


def load_correctness() -> dict[str, dict[str, bool]]:
    """query_id -> model -> correct, restricted to verifiable protocols."""
    table: dict[str, dict[str, bool]] = defaultdict(dict)
    meta: dict[str, tuple[str, str]] = {}
    for model, path in GRADED.items():
        for line in open(path):
            d = json.loads(line)
            proto = d.get("evaluation_protocol_id")
            cat = d.get("dimension")
            if cat not in CATEGORY_PROTOCOLS or proto not in CATEGORY_PROTOCOLS[cat]:
                continue
            qid = d["query_id"]
            table[qid][model] = bool(d.get("correct"))
            meta[qid] = (cat, proto)
    # keep only fully-covered questions
    full = {qid: v for qid, v in table.items() if len(v) == len(GRADED)}
    return full, meta


def load_questions() -> dict[str, dict]:
    out = {}
    for line in open(HUB_ALL):
        d = json.loads(line)
        out[d["query_id"]] = d
    return out


def smoothed_acc(correct: int, total: int, mu: float) -> float:
    return (correct + PRIOR_STRENGTH * mu) / (total + PRIOR_STRENGTH)


def bootstrap_ci(flags: list[bool], mu: float, rnd: random.Random) -> tuple[float, float]:
    n = len(flags)
    stats = []
    for _ in range(BOOTSTRAP):
        sample = [flags[rnd.randrange(n)] for _ in range(n)]
        stats.append(smoothed_acc(sum(sample), n, mu))
    stats.sort()
    return stats[int(0.025 * BOOTSTRAP)], stats[int(0.975 * BOOTSTRAP)]


def calibrate_k(pool: list[str], correctness: dict, mu: float, rnd: random.Random) -> tuple[int, bool]:
    """Smallest K in K_GRID where the closest model pair separates at 95%."""
    models = list(GRADED)
    for k in K_GRID:
        if k > len(pool):
            break
        separated_runs = 0
        runs = 30
        for _ in range(runs):
            subset = rnd.sample(pool, k)
            cis = {}
            for m in models:
                flags = [correctness[q][m] for q in subset]
                cis[m] = bootstrap_ci(flags, mu, rnd)
            accs = {m: smoothed_acc(sum(correctness[q][m] for q in subset), k, mu) for m in models}
            ordered = sorted(models, key=lambda m: accs[m])
            ok = True
            for a, b in zip(ordered, ordered[1:], strict=False):
                lo_b, _ = cis[b]
                _, hi_a = cis[a]
                if hi_a >= lo_b:  # overlap
                    ok = False
                    break
            if ok:
                separated_runs += 1
        if separated_runs / runs >= 0.8:
            return k, True
    return min(MAX_K, len(pool)), False


def main() -> None:
    rnd = random.Random(SEED)
    correctness, meta = load_correctness()
    questions = load_questions()
    print(f"verifiable graded questions across 3 models: {len(correctness)}")

    by_cat: dict[str, list[str]] = defaultdict(list)
    for qid in correctness:
        by_cat[meta[qid][0]].append(qid)

    probe_lines = []
    header_categories = {}
    for cat, qids in sorted(by_cat.items()):
        cap_idx = CAPS.index(cat)
        # global prior mu_c = mean accuracy of the 3 known models on this category
        total = len(qids) * len(GRADED)
        correct = sum(correctness[q][m] for q in qids for m in GRADED)
        mu = correct / total

        discr = [q for q in qids if 0 < sum(correctness[q].values()) < len(GRADED)]
        all_fail = [q for q in qids if sum(correctness[q].values()) == 0]
        rnd.shuffle(discr)
        rnd.shuffle(all_fail)

        k, separated = calibrate_k(discr, correctness, mu, rnd)
        n_hard = min(len(all_fail), max(1, int(k * HARD_ANCHOR_FRACTION)))
        chosen = discr[:k] + all_fail[:n_hard]
        # drop questions whose text is missing from the hub split
        chosen = [q for q in chosen if q in questions]

        anchors = []
        for m in GRADED:
            acc = sum(correctness[q][m] for q in chosen) / len(chosen)
            anchors.append({"model": m, "probe_accuracy": acc, "paper_skill": PAPER_SKILLS[m][cap_idx]})
        anchors.sort(key=lambda a: a["probe_accuracy"])

        header_categories[cat] = {
            "k_discriminative": k,
            "k_hard_anchor": n_hard,
            "n_total": len(chosen),
            "ci_separated": separated,
            "global_prior_mu": round(mu, 6),
            # Prior on the PROBE scale (mean anchor accuracy): this is the mu to
            # use for Bayesian smoothing of a new model's probe accuracy, since
            # the probe subset is deliberately harder than the full dataset.
            "probe_prior_mu": round(sum(a["probe_accuracy"] for a in anchors) / len(anchors), 6),
            "anchors": anchors,
        }
        print(f"{cat}: K={k} (+{n_hard} hard anchors, CI separated={separated}, mu={mu:.3f})")
        for a in anchors:
            print(f"   anchor {a['model']}: probe_acc={a['probe_accuracy']:.3f} -> skill={a['paper_skill']}")

        for qid in chosen:
            q = questions[qid]
            probe_lines.append(
                json.dumps(
                    {
                        "query_id": qid,
                        "category": cat,
                        "protocol": meta[qid][1],
                        "query": q["query"],
                        "expected_answer": q.get("expected_answer"),
                    },
                    ensure_ascii=False,
                )
            )

    body = "\n".join(probe_lines)
    subset_hash = hashlib.sha256(body.encode()).hexdigest()[:16]
    header = json.dumps(
        {
            "_meta": True,
            "version": 1,
            "subset_hash": subset_hash,
            "capabilities": CAPS,
            "prior_strength": PRIOR_STRENGTH,
            "categories": header_categories,
            "note": "Frozen probe set for brick skills extract. Anchors map probe accuracy onto the paper skill scale (piecewise linear).",
        },
        ensure_ascii=False,
    )

    OUT.write_text(header + "\n" + body + "\n")
    print(f"wrote {len(probe_lines)} questions + header to {OUT} (hash {subset_hash})")


if __name__ == "__main__":
    main()
