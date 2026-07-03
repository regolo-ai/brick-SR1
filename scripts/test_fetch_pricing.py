#!/usr/bin/env python3
"""Tests for scripts/fetch_pricing.py.

No real network calls are made: requests.get is mocked throughout.

Run with:
    python3 -m pytest scripts/test_fetch_pricing.py -v
"""

import sys
from pathlib import Path
from unittest.mock import Mock, patch

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fetch_pricing as fp  # noqa: E402

# ---------------------------------------------------------------------------
# Fixture: a trimmed LiteLLM price map covering the Anthropic families we key
# on, plus an unrelated entry to prove we select by exact litellm_key. Costs
# are per-token USD, exactly as the real feed stores them.
# ---------------------------------------------------------------------------

LITELLM_FIXTURE = {
    "claude-haiku-4-5": {
        "litellm_provider": "anthropic",
        "input_cost_per_token": 1.0e-06,
        "output_cost_per_token": 5.0e-06,
    },
    "claude-sonnet-5": {
        "litellm_provider": "anthropic",
        "input_cost_per_token": 3.0e-06,
        "output_cost_per_token": 15.0e-06,
    },
    "claude-opus-4-8": {
        "litellm_provider": "anthropic",
        "input_cost_per_token": 5.0e-06,
        "output_cost_per_token": 25.0e-06,
    },
    # Decoy: an older opus with very different pricing. Selecting the wrong
    # key (e.g. a prefix match) would grab this instead of claude-opus-4-8.
    "claude-opus-4-1": {
        "litellm_provider": "anthropic",
        "input_cost_per_token": 15.0e-06,
        "output_cost_per_token": 75.0e-06,
    },
}


class TestLitellmPrice:
    def test_extracts_and_scales_to_per_million(self):
        assert fp.litellm_price(LITELLM_FIXTURE, "claude-haiku-4-5") == (1.0, 5.0)
        assert fp.litellm_price(LITELLM_FIXTURE, "claude-sonnet-5") == (3.0, 15.0)
        assert fp.litellm_price(LITELLM_FIXTURE, "claude-opus-4-8") == (5.0, 25.0)

    def test_selects_exact_key_not_a_sibling(self):
        # claude-opus-4-8 must not be confused with claude-opus-4-1.
        assert fp.litellm_price(LITELLM_FIXTURE, "claude-opus-4-8") == (5.0, 25.0)

    def test_returns_none_for_missing_key(self):
        assert fp.litellm_price(LITELLM_FIXTURE, "claude-does-not-exist") is None

    def test_returns_none_for_empty_or_none_map(self):
        assert fp.litellm_price(None, "claude-haiku-4-5") is None
        assert fp.litellm_price({}, "claude-haiku-4-5") is None

    def test_returns_none_when_cost_fields_absent_or_zero(self):
        m = {"x": {"input_cost_per_token": 0, "output_cost_per_token": 5e-06}}
        assert fp.litellm_price(m, "x") is None
        m2 = {"x": {"litellm_provider": "anthropic"}}
        assert fp.litellm_price(m2, "x") is None


class TestBuildPricingRecordsAnthropic:
    def test_litellm_source_when_key_present(self):
        records = fp.build_pricing_records(LITELLM_FIXTURE, "2026-07-03T00:00:00Z")
        opus = next(r for r in records if r["model"] == "claude-opus")
        assert opus["provider"] == "anthropic"
        assert opus["currency"] == "USD"
        assert opus["input_price"] == 5.0
        assert opus["output_price"] == 25.0
        assert opus["source"] == "litellm:claude-opus-4-8"
        assert opus["fetched_at"] == "2026-07-03T00:00:00Z"

    def test_generic_model_key_is_used_not_versioned(self):
        # pricing.yaml stays keyed by the generic family name the Go prefix
        # matcher expects, even though the price is read from a versioned key.
        records = fp.build_pricing_records(LITELLM_FIXTURE, "2026-07-03T00:00:00Z")
        models = {r["model"] for r in records if r["provider"] == "anthropic"}
        assert models == {"claude-haiku", "claude-sonnet", "claude-opus"}

    def test_fallback_when_key_missing_from_map(self):
        # An empty map forces every Anthropic row to the static fallback.
        records = fp.build_pricing_records({}, "2026-07-03T00:00:00Z")
        for model, _key, fb_in, fb_out in fp.ANTHROPIC_MODELS:
            row = next(r for r in records if r["model"] == model)
            assert row["source"] == "fallback_static"
            assert row["input_price"] == fb_in
            assert row["output_price"] == fb_out

    def test_fallback_when_map_is_none(self):
        records = fp.build_pricing_records(None, "2026-07-03T00:00:00Z")
        anthropic = [r for r in records if r["provider"] == "anthropic"]
        assert all(r["source"] == "fallback_static" for r in anthropic)


class TestBuildPricingRecordsRegolo:
    def test_regolo_always_curated_regardless_of_map(self):
        records = fp.build_pricing_records(None, "2026-07-03T00:00:00Z")
        regolo = [r for r in records if r["provider"] == "regolo"]
        assert len(regolo) == len(fp.REGOLO_MODELS)
        assert all(r["source"] == "static_curated" for r in regolo)
        assert all(r["currency"] == "EUR" for r in regolo)

    def test_regolo_values_match_table(self):
        records = fp.build_pricing_records(LITELLM_FIXTURE, "2026-07-03T00:00:00Z")
        qwen = next(r for r in records if r["model"] == "qwen3.5-9b")
        assert qwen["input_price"] == 0.07
        assert qwen["output_price"] == 0.35


class TestRecordCount:
    def test_every_known_model_produces_exactly_one_record(self):
        records = fp.build_pricing_records(LITELLM_FIXTURE, "2026-07-03T00:00:00Z")
        assert len(records) == len(fp.ANTHROPIC_MODELS) + len(fp.REGOLO_MODELS)


class TestPerModelFailureIsolation:
    def test_exception_reading_one_price_isolates_other_models(self):
        original = fp.litellm_price

        def flaky(price_map, key):
            if key == "claude-sonnet-5":
                raise RuntimeError("boom")
            return original(price_map, key)

        with patch("fetch_pricing.litellm_price", side_effect=flaky):
            records = fp.build_pricing_records(LITELLM_FIXTURE, "2026-07-03T00:00:00Z")

        assert len(records) == len(fp.ANTHROPIC_MODELS) + len(fp.REGOLO_MODELS)

        sonnet = next(r for r in records if r["model"] == "claude-sonnet")
        assert sonnet["source"] == "fallback_static"
        assert sonnet["input_price"] == 3.0
        assert sonnet["output_price"] == 15.0

        # Other models complete normally.
        opus = next(r for r in records if r["model"] == "claude-opus")
        assert opus["source"] == "litellm:claude-opus-4-8"
        qwen = next(r for r in records if r["model"] == "qwen3.5-9b")
        assert qwen["source"] == "static_curated"


class TestFetchLitellmPrices:
    @patch("fetch_pricing.requests.get")
    def test_returns_parsed_json_on_success(self, mock_get):
        mock_resp = Mock()
        mock_resp.json.return_value = LITELLM_FIXTURE
        mock_resp.raise_for_status = Mock()
        mock_get.return_value = mock_resp

        result = fp.fetch_litellm_prices()

        assert result == LITELLM_FIXTURE
        mock_get.assert_called_once()

    @patch("fetch_pricing.requests.get")
    def test_returns_none_and_warns_on_network_error(self, mock_get, capsys):
        mock_get.side_effect = fp.requests.exceptions.ConnectionError("no network")

        result = fp.fetch_litellm_prices()

        assert result is None
        assert "WARNING" in capsys.readouterr().err

    @patch("fetch_pricing.requests.get")
    def test_returns_none_on_http_error(self, mock_get):
        mock_resp = Mock()
        mock_resp.raise_for_status.side_effect = fp.requests.exceptions.HTTPError("404")
        mock_get.return_value = mock_resp
        assert fp.fetch_litellm_prices() is None

    @patch("fetch_pricing.requests.get")
    def test_returns_none_on_invalid_json(self, mock_get):
        mock_resp = Mock()
        mock_resp.raise_for_status = Mock()
        mock_resp.json.side_effect = ValueError("not json")
        mock_get.return_value = mock_resp
        assert fp.fetch_litellm_prices() is None


class TestWritePricingYaml:
    def test_yaml_schema_matches_spec(self, tmp_path):
        records = fp.build_pricing_records(LITELLM_FIXTURE, "2026-07-03T00:00:00Z")
        out_path = tmp_path / "pricing.yaml"

        fp.write_pricing_yaml(records, out_path)
        loaded = yaml.safe_load(out_path.read_text())

        assert isinstance(loaded, list)
        assert len(loaded) == len(fp.ANTHROPIC_MODELS) + len(fp.REGOLO_MODELS)

        expected_keys = {
            "provider",
            "model",
            "input_price",
            "output_price",
            "currency",
            "source_url",
            "source",
            "fetched_at",
        }
        for row in loaded:
            assert set(row.keys()) == expected_keys
            assert row["provider"] in ("anthropic", "regolo")
            assert isinstance(row["input_price"], float)
            assert isinstance(row["output_price"], float)
            assert isinstance(row["fetched_at"], str)

        opus = next(r for r in loaded if r["model"] == "claude-opus")
        assert opus["input_price"] == 5.0
        assert opus["output_price"] == 25.0
        assert opus["source_url"] == fp.ANTHROPIC_PRICING_URL


class TestMainEndToEnd:
    @patch("fetch_pricing.requests.get")
    def test_main_falls_back_for_anthropic_when_network_unavailable(self, mock_get, tmp_path):
        mock_get.side_effect = fp.requests.exceptions.ConnectionError("no network in sandbox")
        out_path = tmp_path / "pricing.yaml"

        fp.main(output_path=out_path)

        loaded = yaml.safe_load(out_path.read_text())
        assert len(loaded) == len(fp.ANTHROPIC_MODELS) + len(fp.REGOLO_MODELS)

        anthropic = [r for r in loaded if r["provider"] == "anthropic"]
        assert all(r["source"] == "fallback_static" for r in anthropic)
        for model, _key, fb_in, fb_out in fp.ANTHROPIC_MODELS:
            row = next(r for r in loaded if r["model"] == model)
            assert row["input_price"] == fb_in
            assert row["output_price"] == fb_out

        # Regolo is curated and unaffected by the network failure.
        regolo = [r for r in loaded if r["provider"] == "regolo"]
        assert all(r["source"] == "static_curated" for r in regolo)

    @patch("fetch_pricing.requests.get")
    def test_main_uses_litellm_values_when_available(self, mock_get, tmp_path):
        mock_resp = Mock()
        mock_resp.raise_for_status = Mock()
        mock_resp.json.return_value = LITELLM_FIXTURE
        mock_get.return_value = mock_resp
        out_path = tmp_path / "pricing.yaml"

        fp.main(output_path=out_path)

        loaded = yaml.safe_load(out_path.read_text())
        opus = next(r for r in loaded if r["model"] == "claude-opus")
        assert opus["source"] == "litellm:claude-opus-4-8"
        assert opus["input_price"] == 5.0
        assert opus["output_price"] == 25.0
