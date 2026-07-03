#!/usr/bin/env python3
"""30b - Few-shot Regolo generate: 5 esempi CoT per ogni source senza pool valido.

Source target (shots=5 senza fewshot_pool funzionante):
- math500, aime_2025, livecodebench_v6, ifeval, gpqa_diamond, eqbench_creative_v3

Strategia: prompt-meta source-specific a Regolo qwen3.5-122b → 5 esempi
(question, reasoning, final_answer) realistici. Output statico:
    data/fewshot_pools/<source_id>.json
+ SHA256 in lockfile.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, file_sha256, utc_now_iso
from brick_evals.regolo_client import RegoloClient

K = 5

# Schema target uniforme
META_PROMPT = """Sei un curatore di esempi few-shot CoT (Chain-of-Thought) per benchmark LLM.

Genera ESATTAMENTE 5 esempi distinti per la fonte specificata. Ogni esempio è un JSON object con questi campi:
{spec}

Vincoli:
- 5 esempi diversi tra loro per topic, difficoltà, struttura
- Realistici e plausibili (non templated)
- Stile coerente con la fonte
- Output: SOLO un JSON array di 5 oggetti. NO markdown fences, NO commenti, NO testo extra.

Fonte target: {source}
Descrizione: {description}

{extra_constraints}

Output JSON array:
"""


SOURCE_SPECS: dict[str, dict] = {
    "math500": {
        "description": "MATH-500 by Hendrycks: problemi competition-style (algebra, geometry, number theory, calculus, combinatorics, intermediate algebra, prealgebra, precalculus). Risposta finale tipicamente in formato latex con \\boxed{}.",
        "spec": '{"question": "<problema in latex>", "reasoning": "<soluzione step-by-step in latex con passaggi numerici>", "final_answer": "<risposta in latex, e.g. \\\\boxed{42} o \\\\frac{3}{4}>"}',
        "extra": "I problemi devono coprire diverse aree (almeno 3 categorie tra le 7 sopra).",
    },
    "aime_2025": {
        "description": "AIME 2025 (American Invitational Mathematics Exam): problemi competition matematica con risposta numerica intera 0-999.",
        "spec": '{"question": "<problema testuale, lunghezza ~100-300 chars>", "reasoning": "<soluzione step-by-step con calcoli espliciti>", "final_answer": "<intero 0-999 come stringa, e.g. \\"125\\">"}',
        "extra": "Problemi medio-difficili (AIME è hard). final_answer DEVE essere intero 0-999 stringa.",
    },
    "livecodebench_v6": {
        "description": "LiveCodeBench v6: problemi competitive programming MISTI. Due testtype: 'functional' (LeetCode-style con `class Solution: def methodName(...)` e args parsati) e 'stdin' (AtCoder/Codeforces-style con input da sys.stdin, output via print). Pool DEVE coprire ENTRAMBI per generalizzare.",
        "spec": '{"question": "<problema in inglese, con input/output spec, esempi, constraint. Per testtype=functional termina con starter code `class Solution: def methodName(...) -> Type:`. Per testtype=stdin descrive input format righe e termina SENZA starter code (modello legge stdin).>", "reasoning": "<approccio algoritmico, identifica tecnica esplicita: hashmap / sliding-window-variabile / two-pointer / DP / greedy / math / etc.>", "final_answer": "<codice Python eseguibile. Per functional: DENTRO `class Solution` con method camelCase. Per stdin: top-level script che legge `input()` o `sys.stdin.readline()` e usa `print(...)`.>"}',
        "extra": "VINCOLI CRITICI MIXED POOL:\n1. ESATTAMENTE 5 esempi cosi' distribuiti:\n   - 3 esempi LeetCode-style functional con `class Solution: def methodName(...)` (camelCase). final_answer dentro classe.\n   - 2 esempi AtCoder/Codeforces-style stdin. Input dato come righe (es. 'N\\nA1 A2 ... AN'). final_answer e' script top-level con `import sys; input = sys.stdin.readline` e `print(result)`. NO class Solution per gli stdin.\n2. Per i 3 functional: tecniche {hashmap, sliding-window-variabile con while shrink, DP top-down}. Naming camelCase (twoSum, minSubArrayLen, etc.).\n3. Per i 2 stdin: tecniche {greedy/sort, math/number-theory}. Esempi tipici: 'somma minima con vincolo', 'numero di coppie con proprieta'. Input format esplicito nella question.\n4. Ogni question functional DEVE terminare con starter code `class Solution:\\n    def methodName(self, ...) -> Type:\\n        `. Ogni question stdin NON ha starter code, ma descrive 'Input is given from Standard Input in the following format:\\n<format>'.\n5. reasoning cita tecnica esplicitamente (es. 'Use variable-size sliding window').\n6. NO commenti verbose nel codice. NO chain-of-thought lungo.\n7. Esempio stdin-style atteso (per riferimento, NON copiare):\n   question termina con 'Input format:\\nN\\nA_1 A_2 ... A_N\\n\\nOutput: print the answer.'\n   final_answer: 'import sys\\ninput = sys.stdin.readline\\nN = int(input())\\nA = list(map(int, input().split()))\\nprint(sum(A))'",
    },
    "ifbench": {
        "description": "IFBench (AllenAI): instruction-following con constraint verificabili (count: unique words, ratio: sentence/word, words: palindrome/repeats, format constraints, etc.). Ogni instruction ha 1-2 constraint espliciti che la risposta DEVE soddisfare.",
        "spec": '{"question": "<istruzione completa con 1-2 constraint espliciti verificabili (es. \'Use at least 128 unique words\', \'Each sentence must have N/M ratio\', \'Include 10 palindromes >=5 chars\')>", "reasoning": "", "final_answer": "<RISPOSTA REALE che soddisfa effettivamente TUTTI i constraint specificati. NON un placeholder. Lunghezza adeguata al constraint (es. se 128 unique words, scrivi testo con >=128 parole uniche).>"}',
        "extra": "VINCOLI CRITICI:\n1. final_answer DEVE essere RISPOSTA CONCRETA che soddisfa il constraint, NON placeholder come '[risposta di esempio]' o '[fill in]'. Genera testo reale.\n2. 5 esempi con constraint diversificati: 1× count:unique_words (>=N parole uniche), 1× ratio:sentence_words (rapporto), 1× words:palindrome (N palindromi), 1× words:repeats (parola ripetuta N volte), 1× format (es. all caps + word count).\n3. Verifica mentalmente che il final_answer rispetti il constraint prima di emetterlo.\n4. reasoning vuoto (instruction-following non richiede CoT).\n5. Realismo: le istruzioni devono sembrare query utente reali, non template artificiali.\n6. Se constraint richiede testo lungo (es. 128 unique words), genera testo lungo e ricco lessicalmente.",
    },
    "ifeval": {
        "description": "IFEval (Google): instruction following con constraint verificabili (numero parole, format, language, contains keyword, etc.). Una sola istruzione con constraint chiari.",
        "spec": '{"question": "<istruzione con 1-3 constraint espliciti>", "reasoning": "", "final_answer": "<risposta che soddisfa esattamente i constraint>"}',
        "extra": "5 esempi con constraint diversi (e.g., word count, all caps, JSON format, no commas, specific language). reasoning può essere vuoto (instruction following non richiede CoT).",
    },
    "gpqa_diamond": {
        "description": "GPQA Diamond: graduate-level multiple choice in physics, chemistry, biology. 4 opzioni A/B/C/D, una corretta.",
        "spec": '{"question": "<domanda graduate-level>", "options_formatted": "A. <opt1>\\nB. <opt2>\\nC. <opt3>\\nD. <opt4>", "reasoning": "<ragionamento scientifico step-by-step>", "final_answer": "<lettera A/B/C/D>"}',
        "extra": "Coverage: physics, chem, bio (mix). Distractors plausibili. final_answer SOLO una lettera A/B/C/D.",
    },
    "eqbench_creative_v3": {
        "description": "EQ-Bench Creative Writing v3: prompt di scrittura creativa con constraint stilistici. Output è una breve storia/scena (200-1000 chars).",
        "spec": '{"question": "<prompt creativo con constraint stilistico>", "reasoning": "", "final_answer": "<breve testo creativo 200-1000 chars che soddisfa il prompt>"}',
        "extra": "5 prompt diversi per genere/mood (literary, sci-fi, horror, comedic, dialogue-driven). final_answer è il testo creativo.",
    },
}


def _parse_json_array(text: str) -> list[dict]:
    """Estrae JSON array da output LLM (tollerante a code fences)."""
    text = text.strip()
    if text.startswith("```"):
        # rimuovi code fence
        lines = text.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    # Trova primo '[' e ultimo ']'
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1 or end <= start:
        raise ValueError(f"no JSON array found in output: {text[:200]}")
    arr_text = text[start : end + 1]
    # strict=False: allow literal control chars in strings (code blocks with newlines)
    return json.loads(arr_text, strict=False)


def generate_for_source(client: RegoloClient, source_id: str, spec: dict) -> list[dict]:
    prompt = META_PROMPT.format(
        source=source_id,
        description=spec["description"],
        spec=spec["spec"],
        extra_constraints=spec.get("extra", ""),
    )
    out = client.text(
        prompt,
        system="Sei un curatore di esempi few-shot per benchmark LLM. Output: solo JSON array, no commentary.",
        temperature=0.7,
        max_tokens=4096,
    )
    arr = _parse_json_array(out)
    if not isinstance(arr, list) or len(arr) < 1:
        raise ValueError(f"expected list, got {type(arr).__name__}")
    return arr[:K]


def main():
    out_dir = data_dir("fewshot_pools")
    client = RegoloClient()

    results: dict[str, dict] = {}
    for sid, spec in SOURCE_SPECS.items():
        out_path = out_dir / f"{sid}.json"
        # Skip se già esiste e non vuoto
        if out_path.exists():
            try:
                existing = json.loads(out_path.read_text())
                if isinstance(existing, list) and len(existing) >= K and any(e.get("question") for e in existing):
                    print(f"  [SKIP] {sid}: already populated ({len(existing)} examples)")
                    continue
            except Exception:
                pass

        print(f"\n=== {sid} ===")
        last_err = None
        for attempt in range(3):
            try:
                examples = generate_for_source(client, sid, spec)
                # Validate min schema: question + final_answer present
                bad = [i for i, e in enumerate(examples) if not e.get("question") or "final_answer" not in e]
                if bad:
                    raise ValueError(f"missing fields in examples {bad}")
                break
            except Exception as e:
                last_err = e
                print(f"  [warn] attempt {attempt + 1} failed: {type(e).__name__}: {str(e)[:120]}")
                examples = None
        if not examples:
            print(f"  [FAIL] {sid}: {last_err}")
            continue

        # Ensure list-typed fields
        for e in examples:
            if "reasoning" not in e:
                e["reasoning"] = ""
            if "options_formatted" not in e:
                e["options_formatted"] = None

        out_path.write_text(json.dumps(examples, ensure_ascii=False, indent=2), encoding="utf-8")
        sha = file_sha256(out_path)
        print(f"  saved {len(examples)} examples -> {out_path}")
        print(f"  SHA256: {sha}")
        results[sid] = {"n": len(examples), "sha256": sha}

    # Lockfile
    import yaml

    lockfile = data_dir("reports") / "lockfile.yaml"
    entries = {}
    if lockfile.exists():
        with open(lockfile) as f:
            entries = yaml.safe_load(f) or {}
    for sid, info in results.items():
        entries[f"fewshot_synthetic_{sid}"] = {
            "model": "qwen3.5-122b@regolo",
            "n": info["n"],
            "sha256": info["sha256"],
            "generated_at": utc_now_iso(),
        }
    with open(lockfile, "w") as f:
        yaml.safe_dump(entries, f, default_flow_style=False, sort_keys=True)


if __name__ == "__main__":
    main()
