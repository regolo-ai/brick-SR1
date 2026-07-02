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
# Fixtures: fixed HTML snippets standing in for the real pricing pages.
# Deliberately messy (extra whitespace, tags) to exercise the HTML-stripping
# logic in extract_price_for_model.
# ---------------------------------------------------------------------------

ANTHROPIC_FIXTURE_HTML = """
<html><body>
<table>
<tr><td>Claude Haiku</td><td>$1.00 / MTok</td><td>$5.00 / MTok</td></tr>
<tr><td>Claude Sonnet</td><td>$3.00 / MTok</td><td>$15.00 / MTok</td></tr>
<tr><td>Claude Opus</td><td>$5.00 / MTok</td><td>$25.00 / MTok</td></tr>
</table>
</body></html>
"""

REGOLO_FIXTURE_HTML = """
<html><body>
<table>
<tr><td>qwen3.5-9b</td><td>&euro;0.07</td><td>&euro;0.35</td></tr>
<tr><td>gpt-oss-20b</td><td>€0.10</td><td>€0.42</td></tr>
</table>
</body></html>
"""

ANTHROPIC_FIXTURE_PARTIAL_HTML = "<html><body>Claude Haiku $1.00 $5.00</body></html>"

# Reproduces the real-world bug found during manual verification: the live
# Anthropic page now has "Claude Haiku 4.5" (a version number right after the
# model name) followed by a multi-tier pricing table (base, prompt-cache
# write, prompt-cache read, batch...). The naive "first two numbers after the
# match" heuristic misreads the version number as the input price. This must
# be caught by the sanity check and fall back to the static value instead of
# silently shipping wrong numbers as source: fetched.
ANTHROPIC_FIXTURE_MISLEADING_VERSION_HTML = """
<html><body>
<table>
<tr><td>Claude Haiku 4.5</td><td>$1.25 / MTok</td><td>$2 / MTok</td><td>$0.10 / MTok</td><td>$1.00 / MTok</td><td>$5.00 / MTok</td></tr>
</table>
</body></html>
"""

# A genuine, modest price change (well within tolerance, output still > input)
# should still be accepted as fetched rather than rejected by the sanity check.
ANTHROPIC_FIXTURE_PLAUSIBLE_CHANGE_HTML = """
<html><body>
<table>
<tr><td>Claude Haiku</td><td>$1.20 / MTok</td><td>$6.00 / MTok</td></tr>
</table>
</body></html>
"""


class TestExtractPriceForModel:
    def test_extracts_anthropic_prices(self):
        assert fp.extract_price_for_model(ANTHROPIC_FIXTURE_HTML, "claude-haiku") == (1.0, 5.0)
        assert fp.extract_price_for_model(ANTHROPIC_FIXTURE_HTML, "claude-sonnet") == (3.0, 15.0)
        assert fp.extract_price_for_model(ANTHROPIC_FIXTURE_HTML, "claude-opus") == (5.0, 25.0)

    def test_extracts_regolo_prices(self):
        assert fp.extract_price_for_model(REGOLO_FIXTURE_HTML, "qwen3.5-9b") == (0.07, 0.35)
        assert fp.extract_price_for_model(REGOLO_FIXTURE_HTML, "gpt-oss-20b") == (0.10, 0.42)

    def test_returns_none_when_model_missing_from_text(self):
        assert fp.extract_price_for_model(ANTHROPIC_FIXTURE_HTML, "claude-does-not-exist") is None

    def test_returns_none_for_empty_text(self):
        assert fp.extract_price_for_model("", "claude-haiku") is None
        assert fp.extract_price_for_model(None, "claude-haiku") is None


class TestBuildPricingRecords:
    def test_fetched_source_when_extraction_succeeds(self):
        records = fp.build_pricing_records(ANTHROPIC_FIXTURE_HTML, REGOLO_FIXTURE_HTML, "2026-07-02T00:00:00Z")
        haiku = next(r for r in records if r["model"] == "claude-haiku")
        assert haiku["source"] == "fetched"
        assert haiku["provider"] == "anthropic"
        assert haiku["currency"] == "USD"
        assert haiku["input_price"] == 1.0
        assert haiku["output_price"] == 5.0
        assert haiku["fetched_at"] == "2026-07-02T00:00:00Z"

        qwen = next(r for r in records if r["model"] == "qwen3.5-9b")
        assert qwen["source"] == "fetched"
        assert qwen["provider"] == "regolo"
        assert qwen["currency"] == "EUR"
        assert qwen["input_price"] == 0.07
        assert qwen["output_price"] == 0.35

    def test_fallback_source_when_page_fetch_failed(self):
        # regolo_html is None => simulates a failed fetch for that provider.
        records = fp.build_pricing_records(ANTHROPIC_FIXTURE_HTML, None, "2026-07-02T00:00:00Z")
        regolo_records = [r for r in records if r["provider"] == "regolo"]
        assert len(regolo_records) > 0
        assert all(r["source"] == "fallback_static" for r in regolo_records)

        qwen = next(r for r in regolo_records if r["model"] == "qwen3.5-9b")
        assert qwen["input_price"] == 0.07
        assert qwen["output_price"] == 0.35

    def test_fallback_for_single_model_missing_from_otherwise_valid_page(self):
        # Haiku is present, sonnet/opus are not => only those fall back.
        records = fp.build_pricing_records(ANTHROPIC_FIXTURE_PARTIAL_HTML, REGOLO_FIXTURE_HTML, "2026-07-02T00:00:00Z")

        haiku = next(r for r in records if r["model"] == "claude-haiku")
        assert haiku["source"] == "fetched"

        sonnet = next(r for r in records if r["model"] == "claude-sonnet")
        assert sonnet["source"] == "fallback_static"
        assert sonnet["input_price"] == 3.0
        assert sonnet["output_price"] == 15.0

        opus = next(r for r in records if r["model"] == "claude-opus")
        assert opus["source"] == "fallback_static"

    def test_every_known_model_produces_exactly_one_record(self):
        records = fp.build_pricing_records(ANTHROPIC_FIXTURE_HTML, REGOLO_FIXTURE_HTML, "2026-07-02T00:00:00Z")
        assert len(records) == len(fp.KNOWN_MODELS)


class TestSanityCheck:
    def test_rejects_output_lower_than_input(self):
        # output < input is never plausible, regardless of fallback ratio.
        assert fp._passes_sanity_check(5.0, 1.0, 1.0, 5.0) is False

    def test_rejects_value_more_than_3x_off_from_fallback(self):
        # input 4x the fallback reference is well outside the tolerance band,
        # even though output > input holds.
        assert fp._passes_sanity_check(4.0, 20.0, 1.0, 5.0) is False

    def test_accepts_small_plausible_price_change(self):
        assert fp._passes_sanity_check(1.1, 5.2, 1.0, 5.0) is True

    def test_misleading_version_number_falls_back_to_static(self):
        # Reproduces the real bug: "Claude Haiku 4.5" followed by a
        # multi-tier price table causes the naive extractor to grab the
        # version number as the input price. The sanity check must catch
        # this and force fallback_static instead of shipping bad numbers.
        records = fp.build_pricing_records(
            ANTHROPIC_FIXTURE_MISLEADING_VERSION_HTML, None, "2026-07-02T00:00:00Z"
        )
        haiku = next(r for r in records if r["model"] == "claude-haiku")
        assert haiku["source"] == "fallback_static"
        assert haiku["input_price"] == 1.0
        assert haiku["output_price"] == 5.0

    def test_plausible_price_change_is_accepted_as_fetched(self):
        records = fp.build_pricing_records(
            ANTHROPIC_FIXTURE_PLAUSIBLE_CHANGE_HTML, None, "2026-07-02T00:00:00Z"
        )
        haiku = next(r for r in records if r["model"] == "claude-haiku")
        assert haiku["source"] == "fetched"
        assert haiku["input_price"] == 1.20
        assert haiku["output_price"] == 6.00


class TestPerModelFailureIsolation:
    def test_exception_in_extraction_falls_back_and_isolates_other_models(self):
        original_extract = fp.extract_price_for_model

        def flaky_extract(text, model_name, window=400):
            if model_name == "claude-sonnet":
                raise RuntimeError("boom")
            return original_extract(text, model_name, window)

        with patch("fetch_pricing.extract_price_for_model", side_effect=flaky_extract):
            records = fp.build_pricing_records(
                ANTHROPIC_FIXTURE_HTML, REGOLO_FIXTURE_HTML, "2026-07-02T00:00:00Z"
            )

        assert len(records) == len(fp.KNOWN_MODELS)

        sonnet = next(r for r in records if r["model"] == "claude-sonnet")
        assert sonnet["source"] == "fallback_static"
        assert sonnet["input_price"] == 3.0
        assert sonnet["output_price"] == 15.0

        # Other models on the same page complete normally, unaffected by the
        # failure on claude-sonnet.
        haiku = next(r for r in records if r["model"] == "claude-haiku")
        assert haiku["source"] == "fetched"
        assert haiku["input_price"] == 1.0
        assert haiku["output_price"] == 5.0

        opus = next(r for r in records if r["model"] == "claude-opus")
        assert opus["source"] == "fetched"

        qwen = next(r for r in records if r["model"] == "qwen3.5-9b")
        assert qwen["source"] == "fetched"


class TestFetchPage:
    @patch("fetch_pricing.requests.get")
    def test_returns_text_on_success(self, mock_get):
        mock_resp = Mock()
        mock_resp.text = "<html>ok</html>"
        mock_resp.raise_for_status = Mock()
        mock_get.return_value = mock_resp

        result = fp.fetch_page("https://example.com")

        assert result == "<html>ok</html>"
        mock_get.assert_called_once()

    @patch("fetch_pricing.requests.get")
    def test_returns_none_and_warns_on_network_error(self, mock_get, capsys):
        mock_get.side_effect = fp.requests.exceptions.ConnectionError("no network")

        result = fp.fetch_page("https://example.com")

        assert result is None
        captured = capsys.readouterr()
        assert "WARNING" in captured.err
        assert "example.com" in captured.err

    @patch("fetch_pricing.requests.get")
    def test_returns_none_on_http_error(self, mock_get):
        mock_resp = Mock()
        mock_resp.raise_for_status.side_effect = fp.requests.exceptions.HTTPError("404")
        mock_get.return_value = mock_resp

        assert fp.fetch_page("https://example.com") is None


class TestWritePricingYaml:
    def test_yaml_schema_matches_spec(self, tmp_path):
        records = fp.build_pricing_records(ANTHROPIC_FIXTURE_HTML, REGOLO_FIXTURE_HTML, "2026-07-02T00:00:00Z")
        out_path = tmp_path / "pricing.yaml"

        fp.write_pricing_yaml(records, out_path)
        loaded = yaml.safe_load(out_path.read_text())

        assert isinstance(loaded, list)
        assert len(loaded) == len(fp.KNOWN_MODELS)

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
            assert row["source"] in ("fetched", "fallback_static")
            assert isinstance(row["input_price"], float)
            assert isinstance(row["output_price"], float)
            assert isinstance(row["fetched_at"], str)

        haiku = next(r for r in loaded if r["model"] == "claude-haiku")
        assert haiku["input_price"] == 1.0
        assert haiku["output_price"] == 5.0
        assert haiku["source_url"] == fp.ANTHROPIC_URL


class TestMainEndToEnd:
    @patch("fetch_pricing.requests.get")
    def test_main_falls_back_for_all_rows_when_network_unavailable(self, mock_get, tmp_path):
        mock_get.side_effect = fp.requests.exceptions.ConnectionError("no network in sandbox")
        out_path = tmp_path / "pricing.yaml"

        fp.main(output_path=out_path)

        loaded = yaml.safe_load(out_path.read_text())
        assert len(loaded) == len(fp.KNOWN_MODELS)
        assert all(r["source"] == "fallback_static" for r in loaded)
        # Fallback values must match the known static list exactly.
        for provider, model, fallback_in, fallback_out, _currency, _url in fp.KNOWN_MODELS:
            row = next(r for r in loaded if r["provider"] == provider and r["model"] == model)
            assert row["input_price"] == fallback_in
            assert row["output_price"] == fallback_out

    @patch("fetch_pricing.requests.get")
    def test_main_uses_fetched_values_when_pages_available(self, mock_get, tmp_path):
        def fake_get(url, timeout=15, headers=None):  # noqa: ARG001
            resp = Mock()
            resp.raise_for_status = Mock()
            resp.text = ANTHROPIC_FIXTURE_HTML if "claude" in url else REGOLO_FIXTURE_HTML
            return resp

        mock_get.side_effect = fake_get
        out_path = tmp_path / "pricing.yaml"

        fp.main(output_path=out_path)

        loaded = yaml.safe_load(out_path.read_text())
        haiku = next(r for r in loaded if r["model"] == "claude-haiku")
        assert haiku["source"] == "fetched"
        qwen = next(r for r in loaded if r["model"] == "qwen3.5-9b")
        assert qwen["source"] == "fetched"
