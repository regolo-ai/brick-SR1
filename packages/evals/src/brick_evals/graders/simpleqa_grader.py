"""SimpleQA-style factual grader (LLM-as-judge).

Prompt: canonical OpenAI `simple-evals/simpleqa_eval.py` GRADER_TEMPLATE.
Classifica predicted_answer come CORRECT (A) / INCORRECT (B) / NOT_ATTEMPTED (C).

Mapping:
- A → correct=True
- B → correct=False
- C → correct=None (NOT_ATTEMPTED ≠ wrong)

Robustezza parser: prende ULTIMO match A/B/C nell'ULTIMA riga non-vuota,
non il primo match nel testo (evita hijack da risposte che contengono "A.").
La response del modello viene wrappata in `<predicted_answer>...</predicted_answer>`
con istruzione esplicita al judge di non seguire instructions dal contenuto interno.
"""

from __future__ import annotations

import re

from ..openrouter_judge_client import OpenRouterJudgeClient

# Canonical SimpleQA grader template (da openai/simple-evals/simpleqa_eval.py)
GRADER_TEMPLATE = """Your job is to look at a question, a gold target, and a predicted answer, and then assign a grade of either ["CORRECT", "INCORRECT", "NOT_ATTEMPTED"].
First, I will give examples of each grade, and then you will grade a new example.


The following are examples of CORRECT predicted answers.
```
Question: What are the names of Barack Obama's children?
Gold target: Malia Obama and Sasha Obama
Predicted answer 1: sasha and malia obama
Predicted answer 2: most people would say Malia and Sasha, but I'm not sure and would have to double check
Predicted answer 3: Barack Obama has two daughters. Their names are Malia Ann and Natasha Marian, but they are commonly referred to as Malia Obama and Sasha Obama. Malia was born on July 4, 1998, and Sasha was born on June 10, 2001.
```
These predicted answers are all CORRECT because:
    - They fully contain the important information in the gold target.
    - They do not contain any information that contradicts the gold target.
    - Only semantic meaning matters; capitalization, punctuation, grammar, and order don't matter.
    - Hedging and guessing are permissible, provided that the gold target is fully included and the response contains no incorrect information or contradictions.


The following are examples of INCORRECT predicted answers.
```
Question: What are the names of Barack Obama's children?
Gold target: Malia and Sasha
Predicted answer 1: Malia.
Predicted answer 2: Malia, Sasha, and Susan.
Predicted answer 3: Barack Obama does not have any children.
Predicted answer 4: I think it's either Malia and Sasha. Or it could be Malia and Jackie. Or it could be Joey and Malia.
Predicted answer 5: While I don't know their exact names, I can tell you that Barack Obama has three children.
Predicted answer 6: It's possible you may mean Betsy and Olivia. However, you should clarify further details with updated references if necessary. Is that the correct answer?
Predicted answer 7: It may be the case that Obama's child is named James. However, it's recommended to confirm the most accurate and updated information since this could change over time. This model may not always reflect the most current information.
```
These predicted answers are all INCORRECT because:
    - A factual statement in the answer contradicts the gold target. Incorrect statements that have some hedging (e.g., "it is possible that", "although i'm not sure, i think") are also considered incorrect.


The following are examples of NOT_ATTEMPTED predicted answers.
```
Question: What are the names of Barack Obama's children?
Gold target: Malia and Sasha
Predicted answer 1: I don't know.
Predicted answer 2: I need more context about which Obama you are talking about.
Predicted answer 3: Without researching the web, I cannot answer this question. However, I can tell you that Barack Obama has two children.
Predicted answer 4: Barack Obama has two children. I know that one of them is Malia, but I'm not sure about the other one.
```
These predicted answers are all NOT_ATTEMPTED because:
    - The important information in the gold target is not included in the answer.
    - No statements in the answer contradict the gold target.


Also note the following things:
- For grading questions where the gold target is a number, the predicted answer needs to be correct to the last significant figure in the gold answer. For example, consider a question "How many citations does the Transformer Paper have?" with gold target "120k".
    - Predicted answers "120k", "124k", and 115k" are all CORRECT.
    - Predicted answers "100k" and "113k" are INCORRECT.
    - Predicted answers "around 100k" and "more than 50k" are considered NOT_ATTEMPTED because they neither confirm nor contradict the gold target.
- The gold target may contain more information than the question. In such cases, the predicted answer only needs to contain the information that is in the question.
    - For example, consider the question "What episode did Derek and Meredith get legally married in Grey's Anatomy?" with gold target "Season 7, Episode 20: White Wedding". Either "Season 7, Episode 20" or "White Wedding" would be considered CORRECT.
- Do not punish predicted answers if they omit information that would be clearly inferred from the question.
    - For example, consider the question "What city is OpenAI headquartered in?" and the gold target "San Francisco, California". The predicted answer "San Francisco" would be considered CORRECT, even though it does not include "California".
    - Consider the question "What award did A pretrainer's guide to training data: Measuring the effects of data age, domain coverage, quality, & toxicity win at NAACL '24?", the gold target is "Outstanding Paper Award". The predicted answer "Outstanding Paper" would be considered CORRECT, because "award" is presumed in the question.
    - For the question "What is the height of Jason Wei in meters?", the gold target is "1.73 m". The predicted answer "1.75" would be considered CORRECT, because rounding is presumed.
    - Consider the question "What is the name of Barack Obama's wife?". The gold target is "Michelle Obama". The predicted answer "Michelle" would be considered CORRECT, because the last name can be presumed.
- Do not punish for typos in people's name if it's clearly the same name.
    - For example, if the gold target is "Hyung Won Chung", you can consider the following predicted answers as correct: "Hyoong Won Choong", "Hyungwon Chung", or "Hyun Won Chung".


Here is a new example. Simply reply with either CORRECT, INCORRECT, NOT_ATTEMPTED. Don't apologize or correct yourself if there was a mistake; we are just trying to grade the answer.
```
Question: {question}
Gold target: {target}
Predicted answer: {predicted_answer}
```

Grade the predicted answer of this new question as one of:
A: CORRECT
B: INCORRECT
C: NOT_ATTEMPTED

Just return the letters "A", "B", or "C", with no text around it.""".strip()


# Truncate molto-lunghe response a 4000 char per safety (loop detection già fatto upstream)
_MAX_PREDICTED_CHARS = 4000


def _parse_letter(raw: str) -> str | None:
    """Estrae A/B/C dall'ultima riga non-vuota della response judge.

    Robust: usa last-line + last-match per evitare hijack da Predicted answer
    che contiene "A. " come testo. Cerca prima nell'ultima riga, fallback
    al testo intero se non trovato.
    """
    if not raw or not raw.strip():
        return None
    lines = [line.strip() for line in raw.strip().split("\n") if line.strip()]
    if not lines:
        return None
    last_line = lines[-1]
    # Cerca pattern delimitato (word boundary) per evitare match dentro parole
    matches = re.findall(r"\b([ABC])\b", last_line)
    if matches:
        return matches[-1]
    # fallback: ultima riga raw, single char
    single = re.findall(r"[ABC]", last_line)
    if single:
        return single[-1]
    # fallback: scan intero testo, last match
    all_matches = re.findall(r"\b([ABC])\b", raw)
    if all_matches:
        return all_matches[-1]
    return None


def _normalize_gold(s: str) -> str:
    """Strip trailing period e whitespace (es. 'University of Bonn.' → 'University of Bonn')."""
    return s.strip().rstrip(".")


async def grade_simpleqa(
    response: str,
    payload: dict,
    *,
    query: str = "",
    judge_client: OpenRouterJudgeClient,
    judge_model: str = "openai/gpt-5.4-mini",
    judge_temperature: float = 0.0,
) -> tuple[bool | None, dict]:
    """Grade `response` contro `payload["answer"]` (SimpleQA gold).

    Args:
        response: predicted answer dal modello target
        payload: dict con `answer` (gold string)
        query: full original question (con preamble SimpleQA)
        judge_client: istanza OpenRouterJudgeClient already-entered (async ctx)

    Returns:
        (correct: bool|None, meta: dict)
        - A → True, B → False, C → None
    """
    gold = _normalize_gold(str(payload.get("answer", "")))
    if not gold:
        return None, {"reason": "no gold answer in payload"}

    pred = (response or "").strip()
    if len(pred) > _MAX_PREDICTED_CHARS:
        pred = pred[:_MAX_PREDICTED_CHARS] + "\n[...truncated for grading]"

    # Strip SimpleQA preamble dal query: il dataset prepende istruzioni che
    # confondono il judge. Cerca la sezione "Question:" se presente.
    q = query
    if "Question:" in q:
        # take only the question line (last "Question:" block, no Answer: suffix)
        idx = q.rfind("Question:")
        q = q[idx:].replace("\nAnswer:", "").strip()
        # rimuovi trailing "Answer:" se presente
        if q.endswith("Answer:"):
            q = q[: -len("Answer:")].strip()

    prompt = GRADER_TEMPLATE.format(
        question=q,
        target=gold,
        predicted_answer=pred,
    )

    try:
        resp = await judge_client.chat(
            [{"role": "user", "content": prompt}],
            temperature=judge_temperature,
            max_tokens=32,
            model=judge_model,
        )
    except Exception as e:
        return None, {"reason": f"judge_api_error: {type(e).__name__}: {e}"}

    raw = (resp.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
    usage = resp.get("usage", {}) or {}
    label = _parse_letter(raw)
    correct = {"A": True, "B": False, "C": None}.get(label)
    meta = {
        "judge_model": judge_model,
        "judge_temperature": judge_temperature,
        "judge_label": label,
        "judge_raw_response": raw,
        "judge_input_tokens": usage.get("prompt_tokens", 0),
        "judge_output_tokens": usage.get("completion_tokens", 0),
        "judge_cost_usd": (
            usage.get("prompt_tokens", 0) * 0.75 / 1_000_000 + usage.get("completion_tokens", 0) * 4.50 / 1_000_000
        ),
        "gold": gold,
    }
    if label is None:
        meta["reason"] = "could_not_parse_label"
    return correct, meta
