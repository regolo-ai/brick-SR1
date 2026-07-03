"""3 tokenizer cache: qwen3.5-9b (ufficiale), deepseek-v4-flash (proxy V3), kimi2.6 (proxy K2.5)."""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from .io_utils import configs_dir, hf_token, load_yaml


def _load_models_config() -> dict:
    return load_yaml(configs_dir() / "models.yaml")


@lru_cache(maxsize=8)
def get_tokenizer(alias: str) -> Any:
    """Carica tokenizer HF via AutoTokenizer (use_fast=True). Cached.

    alias ∈ {qwen3.5-9b, deepseek-v4-flash, kimi2.6} → mappa a hf_tokenizer in models.yaml.
    """
    from transformers import AutoTokenizer

    cfg = _load_models_config()
    entry = next((v for v in cfg.values() if isinstance(v, dict) and v.get("alias") == alias), None)
    if entry is None:
        raise KeyError(f"alias '{alias}' not found in models.yaml")

    hf_id = entry["hf_tokenizer"]
    fallback = entry.get("hf_tokenizer_fallback")
    token = hf_token()

    try:
        return AutoTokenizer.from_pretrained(hf_id, use_fast=True, token=token, trust_remote_code=False)
    except Exception as e:
        if fallback:
            print(f"[tokenizers] {hf_id} failed ({e}); trying fallback {fallback}")
            return AutoTokenizer.from_pretrained(fallback, use_fast=True, token=token, trust_remote_code=False)
        raise


def count_tokens(text: str, alias: str) -> int:
    tok = get_tokenizer(alias)
    # use_fast tokenizers expose encode that returns list[int]
    return len(tok.encode(text, add_special_tokens=False))


def count_tokens_triplo(text: str) -> dict[str, int]:
    return {
        "input_tokens_qwen": count_tokens(text, "qwen3.5-9b"),
        "input_tokens_deepseek": count_tokens(text, "deepseek-v4-flash"),
        "input_tokens_kimi": count_tokens(text, "kimi2.6"),
    }


def count_tokens_batch(texts: list[str], alias: str, batch_size: int = 64) -> list[int]:
    """Batch encoding for speed."""
    tok = get_tokenizer(alias)
    out = []
    for i in range(0, len(texts), batch_size):
        chunk = texts[i : i + batch_size]
        encoded = tok(chunk, add_special_tokens=False, padding=False, truncation=False, return_attention_mask=False)
        out.extend([len(ids) for ids in encoded["input_ids"]])
    return out
