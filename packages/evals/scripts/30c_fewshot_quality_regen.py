#!/usr/bin/env python3
"""30c - Rigenerazione fewshot quality-aware per source con score basso (T2-01).

Target rev.4: AIME-2025 (2.31), LiveCodeBench-v6 (3.23), IFEval (3.97) sotto gate 4.0.

Strategia generate-and-verify:
1. Genera 12 candidati per source con prompt "expert anchor" migliorato
2. Per ogni candidato → judge rubric 5-axes (1-5 score, qwen3.5-122b)
3. Tieni top 5 con avg_score >= 4.0; se < 5 con avg>=4, top 5 by score (best effort)
4. Salva file `data/fewshot_pools/<sid>.json` + lockfile SHA256
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, file_sha256, utc_now_iso
from brick_evals.judge import Judge
from brick_evals.regolo_client import RegoloClient

K_KEEP = 5
N_CANDIDATES = 12
MIN_SCORE = 4.0

SPECS_FULL = {
    "aime_2025": {
        "system": "Sei un curatore di problemi di matematica di livello competizione AIME. Output: SOLO JSON.",
        "generate_prompt": """Genera ESATTAMENTE 1 problema di stile AIME (American Invitational Mathematics Exam) con risposta numerica intera 0-999.

REGOLE STRINGENTI:
- Il problema DEVE avere una risposta finale unica e ben definita (NO "il problema è malposto", NO "supponiamo che")
- Difficoltà media-alta (livello AIME è hard)
- Reasoning step-by-step CHIARO, ogni passaggio CONFERMATO da calcoli
- final_answer: stringa contenente SOLO un intero da 0 a 999

ESEMPIO STILE TARGET (anchor reale AIME 2024):
{
  "question": "Find the number of ordered pairs (a,b) of positive integers with a<=b<=100 such that a*b/gcd(a,b)^2 is a perfect square.",
  "reasoning": "Let d=gcd(a,b), a=dx, b=dy with gcd(x,y)=1. Then a*b/d^2 = xy. xy is a perfect square iff x=y (impossible since gcd=1 forces x=y=1) or x and y are themselves squares. Counting pairs with a<=b<=100: ...",
  "final_answer": "203"
}

Argomenti possibili (scegline UNO): teoria dei numeri, combinatorica, geometria, algebra, probabilità.

Output JSON object SOLO (no markdown, no commentary):
{"question": "<problema in inglese, ~150-300 chars>", "reasoning": "<soluzione step-by-step in inglese, ~300-700 chars con calcoli espliciti>", "final_answer": "<intero 0-999 come stringa>"}

JSON:""",
    },
    "livecodebench_v6": {
        "system": "Sei un curatore di problemi LeetCode/competitive programming. Output: SOLO JSON.",
        "generate_prompt": """Genera ESATTAMENTE 1 problema di programmazione competitiva stile LiveCodeBench/LeetCode.

REGOLE:
- Problema chiaro con input/output spec esplicito + esempi
- final_answer = codice Python eseguibile e CORRETTO che risolve il problema
- reasoning = approccio algoritmico in inglese, complessità time/space, edge cases
- Diversifica topic: array, string, DP, greedy, graph, math, hash table, two pointers, sliding window

Output JSON object SOLO:
{"question": "<problema completo con Input/Output spec + esempi>", "reasoning": "<approccio algoritmico, complessità, edge cases>", "final_answer": "<codice Python def function_name(...) corretto, eseguibile, con docstring breve>"}

JSON:""",
    },
    "ifeval": {
        "system": "Sei un curatore di esempi instruction-following con constraint verificabili. Output: SOLO JSON.",
        "generate_prompt": """Genera ESATTAMENTE 1 esempio di instruction-following stile IFEval (Google).

REGOLE:
- L'istruzione contiene 1-3 CONSTRAINT VERIFICABILI (es: word count esatto, formato, capitalizzazione, no punteggiatura, lingua specifica, includere/escludere keyword, JSON output)
- final_answer DEVE soddisfare ESATTAMENTE i constraint specificati
- reasoning può essere vuoto (instruction following ≠ CoT)
- Diversifica i tipi di constraint tra esempi

ESEMPI di constraint validi:
- "Rispondi in esattamente 50 parole, senza usare la lettera 'e'."
- "Genera un JSON con 3 chiavi: 'name', 'age', 'city'. Tutti i valori in MAIUSCOLO."
- "Scrivi una poesia di 4 versi, ogni verso inizia con la stessa lettera."

Output JSON object SOLO:
{"question": "<istruzione con constraint chiari>", "reasoning": "", "final_answer": "<risposta che soddisfa esattamente i constraint>"}

JSON:""",
    },
}


JUDGE_PROMPT = """Valuta la qualità di un esempio few-shot CoT per benchmark LLM.

OUTPUT JSON SOLO (no markdown):
{{
  "format": <int 1-5>,
  "cot_validity": <int 1-5>,
  "answer_alignment": <int 1-5>,
  "hallucination_inverse": <int 1-5>,
  "sufficiency": <int 1-5>,
  "verdict": "pass" | "fail",
  "rationale": "<max 200 char>"
}}

Criteri (1-5, 5=eccellente):
1. format: rispetta formato atteso del benchmark {source}?
2. cot_validity: reasoning step-by-step è LOGICO e privo di errori?
3. answer_alignment: la risposta finale è coerente con il reasoning?
4. hallucination_inverse: l'esempio è privo di hallucination/info inventate (5=privo, 1=pieno)?
5. sufficiency: l'esempio è SUFFICIENTE a guidare un modello sul task?

verdict: "pass" se TUTTI gli score >=4, altrimenti "fail".

=== SOURCE: {source} ===

ESEMPIO:
{ex}

JSON:"""

AXES = ["format", "cot_validity", "answer_alignment", "hallucination_inverse", "sufficiency"]


def parse_json_object(text: str) -> dict | None:
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    s = text.find("{")
    e = text.rfind("}")
    if s == -1 or e == -1:
        return None
    try:
        return json.loads(text[s : e + 1])
    except json.JSONDecodeError:
        return None


def main():
    import os

    out_dir = data_dir("fewshot_pools")
    client = RegoloClient()
    judge = Judge(n_judges=2)  # 2 judges (T0.2 + T0.5) for cost

    only = os.environ.get("REGEN_ONLY", "").split(",") if os.environ.get("REGEN_ONLY") else None
    SPECS = {k: v for k, v in SPECS_FULL.items() if not only or k in only}

    summary: dict = {}

    for sid, spec in SPECS.items():
        out_path = out_dir / f"{sid}.json"
        print(f"\n=== {sid} ===")

        candidates: list[dict] = []
        attempts = 0
        while len(candidates) < N_CANDIDATES and attempts < N_CANDIDATES * 2:
            attempts += 1
            try:
                out = client.text(
                    spec["generate_prompt"],
                    system=spec["system"],
                    temperature=0.7,
                    max_tokens=2048,
                )
                obj = parse_json_object(out)
                if not obj or "question" not in obj or "final_answer" not in obj:
                    continue
                obj.setdefault("reasoning", "")
                obj.setdefault("options_formatted", None)
                # Avoid duplicates
                if any(c["question"][:80] == obj["question"][:80] for c in candidates):
                    continue
                candidates.append(obj)
                print(f"  [gen {len(candidates)}/{N_CANDIDATES}] {obj['question'][:80]!r}")
            except Exception as e:
                print(f"  [warn] gen attempt {attempts} failed: {type(e).__name__}: {str(e)[:120]}")

        # Judge each candidate
        scored = []
        for i, c in enumerate(candidates):
            ex_text = json.dumps(c, ensure_ascii=False, indent=2)
            prompt = JUDGE_PROMPT.format(source=sid, ex=ex_text)
            try:
                result = judge.score(prompt, axes=AXES, max_tokens=512)
                avg = sum(result["scores"].values()) / len(result["scores"]) if result["scores"] else 0
            except Exception as e:
                avg = 0
                result = {"verdict": "error", "scores": {}, "rationales": str(e)[:120]}
            scored.append((avg, c, result))
            print(f"  [judge {i+1}/{len(candidates)}] avg={avg:.2f} v={result.get('verdict')}")

        # Top K_KEEP by avg
        scored.sort(key=lambda x: -x[0])
        kept = scored[:K_KEEP]
        kept_avg = sum(s[0] for s in kept) / len(kept) if kept else 0
        print(f"  → kept top {len(kept)}, kept avg score = {kept_avg:.2f}")

        if len(kept) < K_KEEP or kept_avg < MIN_SCORE:
            print(f"  [warn] {sid}: kept_avg {kept_avg:.2f} < {MIN_SCORE}, saving best-effort")

        examples = [c for _, c, _ in kept]
        out_path.write_text(json.dumps(examples, ensure_ascii=False, indent=2), encoding="utf-8")
        sha = file_sha256(out_path)
        print(f"  saved → {out_path}")
        print(f"  SHA256: {sha}")

        summary[sid] = {
            "n_candidates": len(candidates),
            "n_kept": len(kept),
            "kept_avg_score": round(kept_avg, 3),
            "scores_per_kept": [round(s, 3) for s, _, _ in kept],
            "sha256": sha,
            "regenerated_at": utc_now_iso(),
        }

    # Update lockfile
    import yaml

    lockfile = data_dir("reports") / "lockfile.yaml"
    entries = {}
    if lockfile.exists():
        with open(lockfile) as f:
            entries = yaml.safe_load(f) or {}
    for sid, info in summary.items():
        entries[f"fewshot_synthetic_{sid}"] = {
            "model": "qwen3.5-122b@regolo (rev.4 with judge)",
            "n": info["n_kept"],
            "sha256": info["sha256"],
            "kept_avg_score": info["kept_avg_score"],
            "regenerated_at": info["regenerated_at"],
        }
    with open(lockfile, "w") as f:
        yaml.safe_dump(entries, f, default_flow_style=False, sort_keys=True)

    print("\n[30c] summary:")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
