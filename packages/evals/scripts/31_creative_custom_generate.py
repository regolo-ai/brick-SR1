#!/usr/bin/env python3
"""31 - Creative custom generate: 600 candidati via Regolo qwen3.5-122b (fuori-pool).

Genere bilanciati: literary, sci-fi, horror, comedic, poetic, dialogue-driven, micro-fiction, character study.
Output: data/creative_custom/generated.jsonl + SHA256 in lockfile.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, file_sha256, save_jsonl, utc_now_iso
from brick_evals.regolo_client import RegoloClient

GENRE_TAGS = [
    "literary",
    "sci-fi",
    "horror",
    "comedic",
    "poetic",
    "dialogue-driven",
    "micro-fiction",
    "character-study",
]

TARGET_GENERATIONS = 900  # rev.5: 900 candidati → cap 600 validati (replace LitBench drop)
PER_GENRE = TARGET_GENERATIONS // len(GENRE_TAGS)  # ~112/genre

SYSTEM_PROMPT = """You are a curator of creative writing prompts for an LLM evaluation benchmark.
Generate a single original creative writing prompt, concise but evocative, that asks a model \
to write a short text (200-2000 characters).

Constraints:
- Original and non-templated (avoid clichés like "write a story about a dragon")
- Specific enough to be judgeable (include a constraint, mood, or creative requirement)
- Required genre: {genre}
- The prompt MUST be written in English.
- Output ONLY the prompt, no commentary, no meta-text, no prefixes like "Prompt:".
"""


def gen_one(client: RegoloClient, genre: str) -> str:
    sys_p = SYSTEM_PROMPT.format(genre=genre)
    user_p = f"Generate an original creative writing prompt of genre '{genre}'. Output only the prompt, in English."
    return client.text(user_p, system=sys_p, temperature=0.95, max_tokens=300).strip()


def main():
    out_path = data_dir("creative_custom") / "generated.jsonl"
    if out_path.exists():
        existing = sum(1 for _ in open(out_path))
        print(f"generated.jsonl already exists with {existing} rows; appending only if < {TARGET_GENERATIONS}")
        if existing >= TARGET_GENERATIONS:
            print("target reached; nothing to do.")
            return 0

    client = RegoloClient()
    print(f"target {TARGET_GENERATIONS} generations across {len(GENRE_TAGS)} genres ({PER_GENRE}/genere)")

    rows: list[dict] = []
    if out_path.exists():
        with open(out_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    rows.append(json.loads(line))

    seen_hashes = {hash(r.get("prompt", "")) for r in rows}
    counts_by_genre = {g: sum(1 for r in rows if r.get("genre_tag") == g) for g in GENRE_TAGS}

    for genre in GENRE_TAGS:
        while counts_by_genre[genre] < PER_GENRE:
            try:
                prompt = gen_one(client, genre)
                if not prompt or hash(prompt) in seen_hashes:
                    continue
                row = {
                    "id": f"creative_custom_{len(rows):04d}",
                    "prompt": prompt,
                    "genre_tag": genre,
                    "generated_by": "qwen3.5-122b@regolo",
                    "generated_at": utc_now_iso(),
                }
                rows.append(row)
                seen_hashes.add(hash(prompt))
                counts_by_genre[genre] += 1
                if len(rows) % 25 == 0:
                    save_jsonl(out_path, rows)
                    print(
                        f"  progress: {len(rows)}/{TARGET_GENERATIONS} (genre={genre} {counts_by_genre[genre]}/{PER_GENRE})"
                    )
            except Exception as e:
                print(f"  [warn] gen_one failed ({genre}): {type(e).__name__}: {str(e)[:120]}")
                time.sleep(2)
                continue

    n = save_jsonl(out_path, rows)
    sha = file_sha256(out_path)
    print(f"\nsaved {n} prompts -> {out_path}")
    print(f"SHA256: {sha}")

    # Lockfile entry
    import yaml

    lockfile = data_dir("reports") / "lockfile.yaml"
    entries = {}
    if lockfile.exists():
        with open(lockfile) as f:
            entries = yaml.safe_load(f) or {}
    entries["creative_custom_generated"] = {
        "model": "qwen3.5-122b@regolo",
        "n": n,
        "sha256": sha,
        "generated_at": utc_now_iso(),
    }
    with open(lockfile, "w") as f:
        yaml.safe_dump(entries, f, default_flow_style=False, sort_keys=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
