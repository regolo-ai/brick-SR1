"""Smoke test: try 3 methods to disable Qwen3 thinking.
Picks fastest+cleanest, prints sample outputs.
"""

import time

import requests

EP = "http://localhost:30000/v1/chat/completions"
MODEL = "Qwen/Qwen3.6-35B-A3B"

PROMPT = """You are generating a single user query for an LLM benchmark.
Target capability: coding
Difficulty: medium
Length: short

Output ONLY the query text (one realistic user request requiring coding).
Do NOT include any reasoning, explanation, or thinking process.
Do NOT prefix with "Query:" or any label.

The query:"""


def call(payload, label):
    t0 = time.time()
    try:
        r = requests.post(EP, json=payload, timeout=120)
        r.raise_for_status()
        msg = r.json()["choices"][0]["message"]
        content = msg.get("content") or ""
        reasoning = msg.get("reasoning") or msg.get("reasoning_content") or ""
        finish = r.json()["choices"][0].get("finish_reason")
        usage = r.json().get("usage", {})
        print(
            f"=== {label} ({time.time()-t0:.1f}s, finish={finish}, completion_tokens={usage.get('completion_tokens')}) ==="
        )
        print(f"REASONING_LEN: {len(reasoning)}")
        print(f"CONTENT[:500]: {repr(content[:500])}")
        print()
        return content
    except Exception as e:
        print(f"=== {label} ERROR: {e} ===")
        return None


# Method 1: /no_think directive (Qwen3 standard)
call(
    {
        "model": MODEL,
        "messages": [{"role": "user", "content": "/no_think " + PROMPT}],
        "temperature": 1.0,
        "top_p": 0.95,
        "max_tokens": 512,
    },
    "M1: /no_think prefix",
)

# Method 2: chat_template_kwargs enable_thinking=False (vLLM extra body)
call(
    {
        "model": MODEL,
        "messages": [{"role": "user", "content": PROMPT}],
        "temperature": 1.0,
        "top_p": 0.95,
        "max_tokens": 512,
        "chat_template_kwargs": {"enable_thinking": False},
    },
    "M2: enable_thinking=False",
)

# Method 3: System message instructing no thinking
call(
    {
        "model": MODEL,
        "messages": [
            {
                "role": "system",
                "content": "You are a query generator. Output ONLY the requested query, no thinking, no reasoning, no preamble.",
            },
            {"role": "user", "content": PROMPT},
        ],
        "temperature": 1.0,
        "top_p": 0.95,
        "max_tokens": 512,
    },
    "M3: system no-think",
)

# Method 4: M2 + bumped max_tokens to confirm not just truncation
call(
    {
        "model": MODEL,
        "messages": [{"role": "user", "content": PROMPT}],
        "temperature": 1.0,
        "top_p": 0.95,
        "max_tokens": 2048,
        "chat_template_kwargs": {"enable_thinking": False},
    },
    "M4: enable_thinking=False + 2048 tok",
)
