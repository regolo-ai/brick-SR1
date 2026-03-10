"""Monkey-patch lm-eval's parse_generations to handle reasoning model responses.

When the backend returns reasoning_content without content (common with
use_reasoning: true in the semantic routing config), lm-eval's original code
does ``choices["message"]["content"]`` which raises KeyError — because the
field is *absent*, not null.  The except block then falls back to ``[""]``,
producing an empty answer that scores zero.

This patch uses ``msg.get("content")`` and falls back to
``msg.get("reasoning_content", "")`` so that the reasoning output is still
captured and scored.

Additionally, it captures ``usage`` (prompt_tokens, completion_tokens) from
each API response and appends it to a sidecar JSONL file for cost analysis.

Import this module before calling lm-eval's CLI to apply the patch::

    python3 -c "import patch_parse_generations; ..."
"""

import json
import logging
import os
from typing import Dict, List, Union

import lm_eval.models.openai_completions as oai

eval_logger = logging.getLogger("lm-eval")

_original = oai.OpenAIChatCompletion.parse_generations

# Sidecar file for usage data — set USAGE_LOG_PATH env var to override
_usage_log_path = os.environ.get("USAGE_LOG_PATH", "brick_usage.jsonl")
_usage_log_file = None


def _log_usage(out: dict) -> None:
    """Append usage data from a single API response to the sidecar JSONL."""
    global _usage_log_file
    usage = out.get("usage")
    if not usage:
        return
    record = {
        "id": out.get("id", ""),
        "model": out.get("model", ""),
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "completion_tokens": usage.get("completion_tokens", 0),
        "total_tokens": usage.get("total_tokens", 0),
    }
    try:
        if _usage_log_file is None:
            _usage_log_file = open(_usage_log_path, "a")
        _usage_log_file.write(json.dumps(record) + "\n")
        _usage_log_file.flush()
    except Exception as e:
        eval_logger.warning(f"Failed to log usage: {e}")


@staticmethod
def _patched_parse_generations(
    outputs: Union[Dict, List[Dict]], **kwargs
) -> List[str]:
    res: List[str] = []
    if not isinstance(outputs, list):
        outputs = [outputs]
    for out in outputs:
        _log_usage(out)
        try:
            tmp: list = [None] * len(out["choices"])
            for choice in out["choices"]:
                msg = choice["message"]
                content = msg.get("content")
                if content is None:
                    content = msg.get("reasoning_content", "")
                tmp[choice["index"]] = content
        except Exception as e:
            eval_logger.warning(f"Could not parse generations: {e}")
            tmp = [""]
        res = res + tmp
    return res


oai.OpenAIChatCompletion.parse_generations = _patched_parse_generations
