#!/usr/bin/env python3
"""Build pricing.yaml from machine-readable sources (Anthropic, Regolo).

Anthropic prices are read from the LiteLLM community price map
(``model_prices_and_context_window.json``), a continuously-maintained JSON
feed with day-0 model coverage and canonical per-token USD costs. This
replaces the previous best-effort HTML scrape of the Anthropic pricing page,
which was fragile (it once captured a model's version number, e.g. "4.8", as
a price). Anthropic does not expose prices via its Models API, so an external
machine-readable feed is the most robust option short of hardcoding.

Regolo prices have no upstream machine-readable feed (its /v1/models endpoint
and public model catalog expose model names only, no prices), so they are
maintained as a curated in-repo table sourced from regolo.ai/pricing.

Downstream Go tooling (pkg/economics) reads the resulting pricing.yaml. The
output schema is unchanged from the previous version of this script.

When the LiteLLM feed can't be fetched, or a model isn't found in it, the
script falls back to the static price in the KNOWN_MODELS list and marks that
row with source "fallback_static". A failure for one model never stops
processing of the others.

Requires: requests, pyyaml

Usage:
    python3 scripts/fetch_pricing.py
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import requests
import yaml

# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

# LiteLLM community price map: canonical per-token USD costs for Anthropic
# (and most other providers), continuously updated with day-0 coverage.
LITELLM_URL = (
    "https://raw.githubusercontent.com/BerriAI/litellm/main/"
    "model_prices_and_context_window.json"
)
ANTHROPIC_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing"
REGOLO_PRICING_URL = "https://regolo.ai/pricing/"

# ---------------------------------------------------------------------------
# Anthropic models.
#
# The router records versioned model IDs (e.g. "claude-opus-4-8") but
# pricing.yaml is keyed by the generic family name ("claude-opus"); the Go
# PricingTable resolves versioned -> generic via a longest-prefix match. We
# keep that generic key as `model`, and point `litellm_key` at the specific
# LiteLLM entry that is the current price source of truth for that family.
# Bump `litellm_key` (and the fallback values) when the family's flagship
# model changes.
#
# Tuple: (model_generic, litellm_key, fallback_in, fallback_out)
# Prices are USD per 1M tokens. Fallbacks last verified July 2026.
# ---------------------------------------------------------------------------

ANTHROPIC_MODELS: list[tuple[str, str, float, float]] = [
    ("claude-haiku", "claude-haiku-4-5", 1.0, 5.0),
    ("claude-sonnet", "claude-sonnet-5", 3.0, 15.0),
    ("claude-opus", "claude-opus-4-8", 5.0, 25.0),
]

# ---------------------------------------------------------------------------
# Regolo models. No upstream machine-readable price feed exists, so these are
# a curated in-repo table sourced from regolo.ai/pricing. Prices are EUR per
# 1M tokens. Keep model names aligned with the ids served by
# api.regolo.ai/v1/models. Last verified July 2026.
#
# Tuple: (model, input_price, output_price)
# ---------------------------------------------------------------------------

REGOLO_MODELS: list[tuple[str, float, float]] = [
    ("qwen3.5-9b", 0.07, 0.35),
    ("gpt-oss-20b", 0.10, 0.42),
    ("apertus-70b", 0.40, 2.10),
    ("gemma4-31b", 0.40, 2.10),
    ("mistral-small-4-119b", 0.50, 2.10),
    ("qwen3-coder-next", 0.50, 2.00),
    ("mistral-small3.2", 0.50, 2.20),
    ("minimax-m2.5", 0.60, 3.80),
    ("Llama-3.3-70B-Instruct", 0.60, 2.70),
    ("qwen3.5-122b", 1.00, 4.20),
    ("gpt-oss-120b", 1.00, 4.20),
]

# spatial-routing/pricing.yaml, i.e. one directory above scripts/.
PRICING_YAML_PATH = Path(__file__).resolve().parent.parent / "pricing.yaml"


def fetch_litellm_prices() -> dict | None:
    """Download and parse the LiteLLM price map.

    Returns the raw {model_id: {...}} dict, or None (after logging to stderr)
    on any network, HTTP, or JSON error so the caller can fall back to static
    prices.
    """
    try:
        resp = requests.get(
            LITELLM_URL,
            timeout=30,
            headers={"User-Agent": "brick-pricing-fetcher/2.0"},
        )
        resp.raise_for_status()
        return resp.json()
    except (requests.exceptions.RequestException, ValueError) as exc:
        print(f"WARNING: failed to fetch LiteLLM price map {LITELLM_URL}: {exc}", file=sys.stderr)
        return None


def litellm_price(price_map: dict | None, litellm_key: str) -> tuple[float, float] | None:
    """Extract (input_price, output_price) in USD/1M tokens for a LiteLLM key.

    Returns None if the map is missing, the key isn't present, or either
    per-token cost is absent/zero.
    """
    if not price_map:
        return None
    entry = price_map.get(litellm_key)
    if not isinstance(entry, dict):
        return None
    in_tok = entry.get("input_cost_per_token")
    out_tok = entry.get("output_cost_per_token")
    if not in_tok or not out_tok:
        return None
    return in_tok * 1_000_000, out_tok * 1_000_000


def build_pricing_records(price_map: dict | None, fetched_at: str) -> list[dict]:
    """Build pricing records for all known Anthropic and Regolo models.

    Anthropic prices come from the LiteLLM map when available, falling back to
    the static values otherwise. Regolo prices are always the curated in-repo
    table (no upstream feed exists). Never raises for a single-model failure.
    """
    records: list[dict] = []

    for model, litellm_key, fallback_in, fallback_out in ANTHROPIC_MODELS:
        try:
            extracted = litellm_price(price_map, litellm_key)
        except Exception as exc:  # noqa: BLE001 - one model must never abort the run
            print(
                f"WARNING: unexpected error reading LiteLLM price for {litellm_key}: {exc!r}; "
                "using static fallback price",
                file=sys.stderr,
            )
            extracted = None

        if extracted is not None:
            input_price, output_price = extracted
            source = f"litellm:{litellm_key}"
        else:
            print(
                f"WARNING: could not read LiteLLM price for {litellm_key}; "
                "using static fallback price",
                file=sys.stderr,
            )
            input_price, output_price = fallback_in, fallback_out
            source = "fallback_static"

        records.append(
            {
                "provider": "anthropic",
                "model": model,
                "input_price": input_price,
                "output_price": output_price,
                "currency": "USD",
                "source_url": ANTHROPIC_PRICING_URL,
                "source": source,
                "fetched_at": fetched_at,
            }
        )

    for model, input_price, output_price in REGOLO_MODELS:
        records.append(
            {
                "provider": "regolo",
                "model": model,
                "input_price": input_price,
                "output_price": output_price,
                "currency": "EUR",
                "source_url": REGOLO_PRICING_URL,
                "source": "static_curated",
                "fetched_at": fetched_at,
            }
        )

    return records


def write_pricing_yaml(records: list[dict], path: Path = PRICING_YAML_PATH) -> None:
    with path.open("w") as f:
        yaml.safe_dump(records, f, sort_keys=False, default_flow_style=False)


def main(output_path: Path = PRICING_YAML_PATH) -> None:
    fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    price_map = fetch_litellm_prices()

    records = build_pricing_records(price_map, fetched_at)
    write_pricing_yaml(records, output_path)

    litellm_count = sum(1 for r in records if r["source"].startswith("litellm:"))
    fallback_count = sum(1 for r in records if r["source"] == "fallback_static")
    curated_count = sum(1 for r in records if r["source"] == "static_curated")
    print(
        f"Wrote {len(records)} pricing records to {output_path} "
        f"({litellm_count} litellm, {fallback_count} fallback_static, "
        f"{curated_count} static_curated)"
    )


if __name__ == "__main__":
    main()
