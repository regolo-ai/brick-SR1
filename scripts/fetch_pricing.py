#!/usr/bin/env python3
"""Fetch public pricing pages (Anthropic, Regolo) and write pricing.yaml.

Downloads the public pricing pages for Anthropic and Regolo, extracts the
input/output USD or EUR price per 1M tokens for each known model, and writes
the result to ``pricing.yaml`` at the spatial-routing project root (next to
config.yaml). Downstream Go tooling reads that file to compute cost-based
routing/savings.

Extraction is a best-effort text search over the fetched HTML: it is not
guaranteed to survive page redesigns. When a page fails to fetch, or a known
model cannot be found in the fetched text, the script falls back to the
static prices in KNOWN_MODELS (last verified manually, see task brief) and
marks that row with source "fallback_static" instead of "fetched". A failure
for one model/provider never stops processing of the others.

Requires: requests, pyyaml

Usage:
    python3 scripts/fetch_pricing.py
"""

from __future__ import annotations

import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests
import yaml

# ---------------------------------------------------------------------------
# Source pages
# ---------------------------------------------------------------------------

ANTHROPIC_URL = "https://platform.claude.com/docs/en/about-claude/pricing"
REGOLO_URL = "https://regolo.ai/pricing/"

# ---------------------------------------------------------------------------
# Known models: (provider, model, fallback_input, fallback_output, currency,
# source_url). Prices are USD/EUR per 1M tokens. This list drives what the
# script searches for on each page AND supplies the fallback values used
# when a fetch or extraction fails. See task brief for provenance:
#   - Anthropic: apps/cli/src/lib/claude/pricing.ts (verified June 2026)
#   - Regolo: /root/forkGO/ModelPrices.md (fetched 20 April 2026)
# ---------------------------------------------------------------------------

KNOWN_MODELS: list[tuple[str, str, float, float, str, str]] = [
    ("anthropic", "claude-haiku", 1.0, 5.0, "USD", ANTHROPIC_URL),
    ("anthropic", "claude-sonnet", 3.0, 15.0, "USD", ANTHROPIC_URL),
    ("anthropic", "claude-opus", 5.0, 25.0, "USD", ANTHROPIC_URL),
    ("regolo", "qwen3.5-9b", 0.07, 0.35, "EUR", REGOLO_URL),
    ("regolo", "gpt-oss-20b", 0.10, 0.42, "EUR", REGOLO_URL),
    ("regolo", "apertus-70b", 0.40, 2.10, "EUR", REGOLO_URL),
    ("regolo", "gemma4-31b", 0.40, 2.10, "EUR", REGOLO_URL),
    ("regolo", "mistral-small-4-119b", 0.50, 2.10, "EUR", REGOLO_URL),
    ("regolo", "qwen3-coder-next", 0.50, 2.00, "EUR", REGOLO_URL),
    ("regolo", "mistral-small3.2", 0.50, 2.20, "EUR", REGOLO_URL),
    ("regolo", "minimax-m2.5", 0.60, 3.80, "EUR", REGOLO_URL),
    ("regolo", "Llama-3.3-70B-Instruct", 0.60, 2.70, "EUR", REGOLO_URL),
    ("regolo", "qwen3.5-122b", 1.00, 4.20, "EUR", REGOLO_URL),
    ("regolo", "gpt-oss-120b", 1.00, 4.20, "EUR", REGOLO_URL),
]

# spatial-routing/pricing.yaml, i.e. one directory above scripts/.
PRICING_YAML_PATH = Path(__file__).resolve().parent.parent / "pricing.yaml"

_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")
_PRICE_TOKEN_RE = re.compile(r"[\$€]?\s?(\d+(?:\.\d+)?)")


def fetch_page(url: str) -> str | None:
    """Download a page's HTML text.

    Returns None (after logging a warning to stderr) on any network or HTTP
    error instead of raising, so the caller can fall back gracefully.
    """
    try:
        resp = requests.get(url, timeout=15, headers={"User-Agent": "brick-pricing-fetcher/1.0"})
        resp.raise_for_status()
        return resp.text
    except requests.exceptions.RequestException as exc:
        print(f"WARNING: failed to fetch pricing page {url}: {exc}", file=sys.stderr)
        return None


def _model_name_pattern(model_name: str) -> re.Pattern[str]:
    """Build a regex that matches model_name loosely.

    Pricing pages tend to render model names with spaces ("Claude Haiku")
    while our canonical identifiers use hyphens/dots ("claude-haiku",
    "qwen3.5-9b"). Treat whitespace, '-' and '.' as interchangeable
    separators so either rendering matches.
    """
    parts = [p for p in re.split(r"[\s\-.]+", model_name) if p]
    joined = r"[\s\-.]*".join(re.escape(p) for p in parts)
    return re.compile(joined, re.IGNORECASE)


def extract_price_for_model(text: str | None, model_name: str, window: int = 400) -> tuple[float, float] | None:
    """Extract (input_price, output_price) for model_name from raw page text.

    Strips HTML tags, locates the first occurrence of model_name, then reads
    the next two numeric tokens after it (optionally prefixed by a currency
    symbol) as input/output price. Returns None if the model isn't found or
    fewer than two numbers follow it within `window` characters.
    """
    if not text:
        return None

    plain = _TAG_RE.sub(" ", text)
    plain = _WHITESPACE_RE.sub(" ", plain)

    match = _model_name_pattern(model_name).search(plain)
    if match is None:
        return None

    snippet = plain[match.end() : match.end() + window]
    numbers = _PRICE_TOKEN_RE.findall(snippet)
    if len(numbers) < 2:
        return None

    try:
        input_price = float(numbers[0])
        output_price = float(numbers[1])
    except ValueError:
        return None

    return input_price, output_price


_SANITY_RATIO_BOUND = 3.0


def _passes_sanity_check(input_price: float, output_price: float, fallback_in: float, fallback_out: float) -> bool:
    """Reject extracted prices that are implausible.

    The known static list is the spec's designated "sanity-check" reference
    (see task brief point 3): extracted values must be validated against it,
    not just accepted because two numbers were found near the model name.
    Real pricing pages often have multiple tiers (batch, prompt-cache
    write/read, standard) clustered around a model name, plus adjacent
    version numbers (e.g. "Claude Haiku 4.5"), and a naive "first two
    numbers after the match" heuristic can silently grab the wrong ones.

    Two independent guards, both must pass:
    - output price must not be lower than input price. True for every
      known Anthropic/Regolo model; a strong general signal that the
      extraction grabbed unrelated numbers.
    - neither extracted value may differ from the last verified static
      reference by more than a factor of _SANITY_RATIO_BOUND in either
      direction. Genuine price changes over time are expected to be much
      smaller than that; anything further off indicates a bad extraction
      rather than a real price update.
    """
    if output_price < input_price:
        return False
    for extracted, fallback in ((input_price, fallback_in), (output_price, fallback_out)):
        if fallback <= 0:
            continue
        ratio = extracted / fallback
        if ratio > _SANITY_RATIO_BOUND or ratio < (1.0 / _SANITY_RATIO_BOUND):
            return False
    return True


def build_pricing_records(
    anthropic_html: str | None,
    regolo_html: str | None,
    fetched_at: str,
) -> list[dict]:
    """Build the list of pricing records for all KNOWN_MODELS.

    Uses the fetched text for each provider when available; falls back to
    the static price for any model that can't be extracted (page missing,
    model not found, unexpected format, or an extraction that fails the
    plausibility sanity-check against the known reference). Never raises
    for a single model/provider failure.
    """
    page_by_provider = {"anthropic": anthropic_html, "regolo": regolo_html}
    records = []

    for provider, model, fallback_in, fallback_out, currency, source_url in KNOWN_MODELS:
        page_text = page_by_provider.get(provider)
        extracted = extract_price_for_model(page_text, model)

        if extracted is not None and _passes_sanity_check(extracted[0], extracted[1], fallback_in, fallback_out):
            input_price, output_price = extracted
            source = "fetched"
        elif extracted is not None:
            print(
                f"WARNING: extracted price for {provider}/{model} "
                f"({extracted[0]}/{extracted[1]}) looks implausible vs known reference "
                f"({fallback_in}/{fallback_out}); using static fallback price",
                file=sys.stderr,
            )
            input_price, output_price = fallback_in, fallback_out
            source = "fallback_static"
        else:
            print(
                f"WARNING: could not extract price for {provider}/{model} from {source_url}; "
                "using static fallback price",
                file=sys.stderr,
            )
            input_price, output_price = fallback_in, fallback_out
            source = "fallback_static"

        records.append(
            {
                "provider": provider,
                "model": model,
                "input_price": input_price,
                "output_price": output_price,
                "currency": currency,
                "source_url": source_url,
                "source": source,
                "fetched_at": fetched_at,
            }
        )

    return records


def write_pricing_yaml(records: list[dict], path: Path = PRICING_YAML_PATH) -> None:
    with path.open("w") as f:
        yaml.safe_dump(records, f, sort_keys=False, default_flow_style=False)


def main(output_path: Path = PRICING_YAML_PATH) -> None:
    fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    anthropic_html = fetch_page(ANTHROPIC_URL)
    regolo_html = fetch_page(REGOLO_URL)

    records = build_pricing_records(anthropic_html, regolo_html, fetched_at)
    write_pricing_yaml(records, output_path)

    fetched_count = sum(1 for r in records if r["source"] == "fetched")
    fallback_count = len(records) - fetched_count
    print(
        f"Wrote {len(records)} pricing records to {output_path} "
        f"({fetched_count} fetched, {fallback_count} fallback_static)"
    )


if __name__ == "__main__":
    main()
