#!/usr/bin/env python3
"""Eval gpt-oss-120b with thinking=True, reasoning_effort=high on brick_hard (200 MMLU-Pro questions)."""

import json, os, re, sys, time
from pathlib import Path
from openai import OpenAI

# ── config ──────────────────────────────────────────────────────────────────
MODEL           = "gpt-oss-120b"
REASONING_EFFORT = "high"
BASE_URL        = "https://api.regolo.ai/v1"
API_KEY         = os.environ.get("OPENAI_API_KEY") or os.environ.get("REGOLO_API_KEY") or "sk-NklmaM1W15f-FWYh8Li-mA"
DATASET         = Path(__file__).parent / "custom_tasks/brick_hard/test.jsonl"
OUT_DIR         = Path(__file__).parent / "stage6_individual_hard_v4/gpt-oss-120b-reasoning-v2"
SYSTEM_PROMPT   = (
    "You are solving multiple choice questions. "
    "Think carefully, then you MUST end your response with exactly this format: "
    "\"The answer is (X)\" where X is the option letter (A–J). "
    "Do not omit this closing line under any circumstances."
)

OUT_DIR.mkdir(parents=True, exist_ok=True)
log_path     = OUT_DIR / "gpt-oss-120b-reasoning.log"
samples_path = OUT_DIR / "samples.jsonl"
usage_path   = OUT_DIR / "usage.jsonl"

# ── helpers ──────────────────────────────────────────────────────────────────
LETTERS = list("ABCDEFGHIJ")

def format_question(doc):
    choices = doc["choices"]
    options = "\n".join(f"{LETTERS[i]}. {c}" for i, c in enumerate(choices))
    return f"Question: {doc['question']}\n{options}\nAnswer:"

ANSWER_RE = re.compile(
    r"(?:the answer is|best answer is|correct answer is|answer is|answer:\s*)\s*\*{0,2}\s*\(?([A-Ja-j])\)?\*{0,2}"
    r"|\boption\s+([A-Ja-j])\b"
    r"|^([A-Ja-j])[.):]\s",          # line starting with "C. " or "C) "
    re.IGNORECASE | re.MULTILINE
)

def extract_letter(text):
    # search from the end so we catch the closing verdict even after long reasoning
    for m in reversed(list(ANSWER_RE.finditer(text))):
        letter = next(filter(None, m.groups()), None)
        if letter:
            return letter.upper()
    # last-resort: final standalone uppercase option letter on its own line
    for line in reversed(text.splitlines()):
        m = re.fullmatch(r'\s*([A-Ja-j])\s*', line)
        if m:
            return m.group(1).upper()
    return "Z"

# ── main ─────────────────────────────────────────────────────────────────────
questions = [json.loads(l) for l in DATASET.read_text().splitlines() if l.strip()]
client    = OpenAI(api_key=API_KEY, base_url=BASE_URL)

correct = 0
total   = len(questions)

log = open(log_path, "w")
samples_f = open(samples_path, "w")
usage_f   = open(usage_path, "w")

def tee(msg):
    print(msg, flush=True)
    log.write(msg + "\n")
    log.flush()

tee(f"Model: {MODEL}  reasoning_effort={REASONING_EFFORT}  questions={total}")
tee("=" * 60)

for i, doc in enumerate(questions):
    prompt = format_question(doc)
    expected = doc["answer"].upper()

    try:
        resp = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user",   "content": prompt},
            ],
            temperature=0,
            max_tokens=4096,
            stream=False,
            extra_body={"thinking": True, "reasoning_effort": REASONING_EFFORT},
        )
        msg         = resp.choices[0].message
        answer_text = msg.content or ""
        # fallback: some responses land only in reasoning_content when content is empty
        if not answer_text.strip():
            psf = getattr(msg, "provider_specific_fields", None) or {}
            answer_text = psf.get("reasoning_content") or psf.get("reasoning") or ""
        predicted   = extract_letter(answer_text)
        usage       = resp.usage

        usage_f.write(json.dumps({
            "id": doc["id"],
            "prompt_tokens": usage.prompt_tokens if usage else None,
            "completion_tokens": usage.completion_tokens if usage else None,
        }) + "\n")
        usage_f.flush()

    except Exception as e:
        answer_text = ""
        predicted   = "Z"
        tee(f"  ERROR q{i+1}: {e}")

    hit = predicted == expected
    if hit:
        correct += 1

    samples_f.write(json.dumps({
        "id": doc["id"],
        "expected": expected,
        "predicted": predicted,
        "correct": hit,
        "response": answer_text[:300],
    }) + "\n")
    samples_f.flush()

    acc = correct / (i + 1)
    bar_n = (i + 1) * 20 // total
    bar   = "█" * bar_n + "░" * (20 - bar_n)
    tee(f"[{i+1:3}/{total}] {bar} {acc:.1%}  expected={expected} got={predicted} {'✓' if hit else '✗'}")

tee("=" * 60)
tee(f"FINAL ACCURACY: {correct}/{total} = {correct/total:.1%}")

# write summary json
summary = {
    "model": MODEL,
    "reasoning_effort": REASONING_EFFORT,
    "thinking": True,
    "dataset": "brick_hard MMLU-Pro 200q",
    "results": {
        "brick_hard": {
            "exact_match,get_answer_letter": correct / total,
            "correct": correct,
            "total": total,
        }
    }
}
(OUT_DIR / "results.json").write_text(json.dumps(summary, indent=2))

log.close()
samples_f.close()
usage_f.close()
print(f"\nResults saved to {OUT_DIR}/")
