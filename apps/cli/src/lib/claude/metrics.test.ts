import { describe, it, expect, afterEach, vi } from 'vitest';
import { unifyEconomy, fetchEconomics, type EconomicsResponse, type HistoryStats } from './metrics.js';

function emptyMetrics(): HistoryStats {
  return { overall: { calls: 0, completed_calls: 0, failed_calls: 0 }, models: [] };
}

function metricsWithRoutedTraffic(): HistoryStats {
  return {
    overall: { calls: 12, completed_calls: 12, failed_calls: 0 },
    models: [
      { model: 'claude-sonnet-4-6', routed_calls: 10, native_calls: 0, reasoning_modes: [] },
      { model: 'claude-opus-4-8', routed_calls: 0, native_calls: 2, reasoning_modes: [] },
    ],
  };
}

function economicsResponse(overrides: Partial<EconomicsResponse> = {}): EconomicsResponse {
  return {
    models: [
      {
        model: 'claude-haiku-4-5',
        requests: 100,
        input_tokens: 1000,
        output_tokens: 200,
        cost_ratio_in: 5,
        cost_ratio_out: 5,
        estimated_cost_units: 240,
      },
      {
        model: 'claude-opus-4-8',
        requests: 10,
        input_tokens: 50,
        output_tokens: 10,
        cost_ratio_in: 1,
        cost_ratio_out: 1,
        estimated_cost_units: 60,
      },
      // A model observed but without pricing data: its tokens must still
      // count toward the total sums, even though it contributes 0 cost.
      {
        model: 'unpriced-model',
        requests: 5,
        input_tokens: 30,
        output_tokens: 5,
        cost_ratio_in: 0,
        cost_ratio_out: 0,
        estimated_cost_units: 0,
      },
    ],
    most_expensive_model: 'claude-opus-4-8',
    actual_cost_units: 300,
    baseline_cost_units_all_expensive: 1260,
    savings_pct: 76.19047619047619,
    pricing_available: true,
    ...overrides,
  };
}

describe('unifyEconomy', () => {
  it('prefers real token-based savings when the router reports priced traffic', () => {
    const econ = economicsResponse();
    const result = unifyEconomy(econ, emptyMetrics());

    expect(result.source).toBe('real');
    expect(result.savedPct).toBe(econ.savings_pct);
    expect(result.mostExpensiveModel).toBe('claude-opus-4-8');
    // Sums must include ALL observed models, including the unpriced one:
    // 1000 + 50 + 30 = 1080 input, 200 + 10 + 5 = 215 output.
    expect(result.totalInputTokens).toBe(1080);
    expect(result.totalOutputTokens).toBe(215);
  });

  it('falls back to the request-count estimate when econ is null', () => {
    const m = metricsWithRoutedTraffic();
    const result = unifyEconomy(null, m);

    expect(result.source).toBe('estimate');
    expect(result.savedPct).toBeCloseTo(40);
    expect(result.totalRoutedReqs).toBe(10);
  });

  it('falls back to the request-count estimate when pricing_available is false', () => {
    const m = metricsWithRoutedTraffic();
    const econ = economicsResponse({ pricing_available: false });
    const result = unifyEconomy(econ, m);

    expect(result.source).toBe('estimate');
  });

  it('falls back to the request-count estimate when there is no priced baseline yet', () => {
    const m = metricsWithRoutedTraffic();
    const econ = economicsResponse({ baseline_cost_units_all_expensive: 0 });
    const result = unifyEconomy(econ, m);

    expect(result.source).toBe('estimate');
  });

  it('propagates savings_pct_vs_opus when the router reports it', () => {
    const econ = economicsResponse({
      most_expensive_model: 'claude-fable-5',
      savings_pct: 80,
      savings_pct_vs_opus: 60,
    });
    const result = unifyEconomy(econ, emptyMetrics());

    expect(result.source).toBe('real');
    expect(result.savedPctVsOpus).toBe(60);
  });

  it('leaves savedPctVsOpus undefined when the router omits it (opus unpriced or older router)', () => {
    const econ = economicsResponse();
    delete econ.savings_pct_vs_opus;
    const result = unifyEconomy(econ, emptyMetrics());

    expect(result.source).toBe('real');
    expect(result.savedPctVsOpus).toBeUndefined();
  });

  it('does not fall back to all-opus when an explicit baseline is unavailable', () => {
    const econ = economicsResponse({ pricing_available: false, note: 'baseline missing' });
    const result = unifyEconomy(econ, metricsWithRoutedTraffic(), 'gpt-5.6-sol');
    expect(result.source).toBe('unavailable');
    expect(result.baselineModel).toBe('gpt-5.6-sol');
    expect(result.note).toBe('baseline missing');
    expect(result.totalInputTokens).toBe(1080);
  });
});

describe('fetchEconomics', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the parsed response on a successful fetch', async () => {
    const econ = economicsResponse();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => econ })
    );

    const result = await fetchEconomics('http://localhost:8000');
    expect(result).toEqual(econ);
  });

  it('passes an explicit baseline model as an encoded query parameter', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => economicsResponse() });
    vi.stubGlobal('fetch', fetchMock);
    await fetchEconomics('http://localhost:8000', 'gpt-5.6-sol');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://localhost:8000/api/v1/economics?baseline_model=gpt-5.6-sol'
    );
  });

  it('returns null when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));

    const result = await fetchEconomics('http://localhost:8000');
    expect(result).toBeNull();
  });

  it('returns null when fetch throws (e.g. timeout on an older router)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('timeout'))
    );

    const result = await fetchEconomics('http://localhost:8000');
    expect(result).toBeNull();
  });
});
