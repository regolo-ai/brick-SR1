#!/usr/bin/env python3
"""
Probe the domain classifier on the 40 humanities questions from brick_hard.
Sends each question through POST /api/v1/classify/intent and collects
the routing decision + signals. Domain distribution is in the container logs
([DomainSignal] BELOW_THRESHOLD lines).
"""

import json
import time
import requests
from collections import defaultdict

CLASSIFY_URL = "http://localhost:8080/api/v1/classify/intent"
SAMPLES_FILE = "evals/stage6_individual_hard_v4/brick/brick/samples_brick_hard_2026-03-13T13-39-22.798194.jsonl"

def format_question(doc: dict) -> str:
    """Format MMLU-Pro question as it would appear in a user message."""
    lines = [f"Question: {doc['question']}"]
    for i, choice in enumerate(doc["choices"]):
        lines.append(f"{chr(65+i)}. {choice}")
    lines.append("Answer:")
    return "\n".join(lines)

def classify(text: str) -> dict:
    try:
        r = requests.post(CLASSIFY_URL, json={
            "text": text,
            "options": {"return_probabilities": True}
        }, timeout=10)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        return {"error": str(e)}

def main():
    # Load humanities questions
    samples = []
    with open(SAMPLES_FILE) as f:
        for line in f:
            samples.append(json.loads(line))
    humanities = [s for s in samples if s["doc"]["category"] == "humanities"]
    print(f"Loaded {len(humanities)} humanities questions\n")

    results = []
    decision_counts = defaultdict(int)
    signal_domain_counts = defaultdict(int)

    for i, s in enumerate(humanities):
        doc = s["doc"]
        text = format_question(doc)
        resp = classify(text)

        decision = resp.get("classification", {}).get("category", "error")
        confidence = resp.get("classification", {}).get("confidence", 0)
        domain_signals = resp.get("matched_signals", {}).get("domain", [])

        decision_counts[decision] += 1
        for d in domain_signals:
            signal_domain_counts[d] += 1

        result = {
            "id": doc["id"],
            "decision": decision,
            "confidence": confidence,
            "domain_signals": domain_signals,
            "correct_answer": doc["answer"],
        }
        results.append(result)
        print(f"[{i+1:2}/40] {doc['id']} → decision={decision:30} domain={domain_signals}")
        time.sleep(0.05)  # avoid hammering the classifier

    print("\n" + "="*70)
    print("ROUTING DECISION DISTRIBUTION (40 humanities questions):")
    for decision, count in sorted(decision_counts.items(), key=lambda x: -x[1]):
        print(f"  {decision:<35} {count:>3}")

    print("\nDOMAIN SIGNALS MATCHED:")
    for domain, count in sorted(signal_domain_counts.items(), key=lambda x: -x[1]):
        print(f"  {domain:<35} {count:>3}")

    no_domain = sum(1 for r in results if not r["domain_signals"])
    print(f"\nQuestions with NO domain signal (below threshold): {no_domain}/40")
    print(f"Questions WITH domain signal:                      {40 - no_domain}/40")

    # Save full results for further analysis
    out_path = "evals/domain_classifier_probe_results.json"
    with open(out_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nDetailed results saved to {out_path}")
    print("Run: docker logs docker-compose-mymodel-1 2>&1 | grep 'DomainSignal.*BELOW_THRESHOLD'")
    print("to get the full probability distributions from the router logs.")

if __name__ == "__main__":
    main()
