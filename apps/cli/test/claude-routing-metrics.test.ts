import { describe, it, expect } from 'vitest';
import {
  parsePromExposition,
  routedRowsByModel,
  nativeRowsByModel,
  difficultyDistribution,
  effortRowsForModel,
  economy,
  totalRequests,
} from '../src/lib/claude/metrics.js';
import { OPUS_BLENDED, blendedPricePerReq } from '../src/lib/claude/pricing.js';

// A realistic snippet: same model reached via two difficulty buckets, plus a
// native (router-bypass) call on the same model. The aggregations must keep
// routed and native traffic separate and must not pair difficulty with model.
const EXPO = `
# HELP brick_cc_requests_total Total Anthropic /v1/messages requests routed by Brick.
# TYPE brick_cc_requests_total counter
brick_cc_requests_total{label="easy",model="claude-opus-4-8"} 3
brick_cc_requests_total{label="medium",model="claude-opus-4-8"} 2
brick_cc_requests_total{label="medium",model="claude-sonnet-4-6"} 1
brick_cc_requests_total{label="native",model="claude-opus-4-8"} 1
# TYPE brick_cc_effort_total counter
brick_cc_effort_total{model="claude-opus-4-8",effort="high"} 3
brick_cc_effort_total{model="claude-opus-4-8",effort="max"} 2
brick_cc_effort_total{model="claude-sonnet-4-6",effort="medium"} 1
`.trim();

describe('routing aggregations', () => {
  const m = parsePromExposition(EXPO);

  it('counts every request including native', () => {
    expect(totalRequests(m)).toBe(7);
  });

  it('aggregates routed traffic per model, excluding native', () => {
    const rows = routedRowsByModel(m);
    expect(rows.map((r) => [r.model, r.count])).toEqual([
      ['claude-opus-4-8', 5], // 3 easy + 2 medium, native NOT counted
      ['claude-sonnet-4-6', 1],
    ]);
    // pct is over the grand total (7) so routed + native sum to ~100
    expect(rows[0].pct).toBeCloseTo((5 / 7) * 100);
  });

  it('reports native traffic separately', () => {
    const rows = nativeRowsByModel(m);
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('claude-opus-4-8');
    expect(rows[0].count).toBe(1);
  });

  it('reports difficulty mix over routed traffic only', () => {
    const rows = difficultyDistribution(m);
    expect(rows.map((r) => [r.label, r.count])).toEqual([
      ['easy', 3],
      ['medium', 3],
    ]);
    // percentages are over routed total (6), native excluded
    expect(rows[0].pct).toBeCloseTo((3 / 6) * 100);
    expect(rows.every((r) => r.label !== 'native')).toBe(true);
  });
});

import { stackedWidths } from '../src/lib/claude-tui/Dashboard.js';

describe('stackedWidths (terminal stacked bar)', () => {
  it('always sums to exactly width', () => {
    const cases: number[][] = [
      [71, 14, 14],
      [50, 50],
      [33.33, 33.33, 33.34],
      [100],
      [0, 100],
      [12.5, 12.5, 75],
    ];
    for (const pcts of cases) {
      expect(stackedWidths(pcts, 28).reduce((a, b) => a + b, 0)).toBe(28);
    }
  });

  it('gives a zero-pct segment zero cells', () => {
    const w = stackedWidths([0, 100], 28);
    expect(w[0]).toBe(0);
    expect(w[1]).toBe(28);
  });

  it('is proportional for clean splits', () => {
    expect(stackedWidths([50, 50], 28)).toEqual([14, 14]);
  });
});

describe('effort distribution per model', () => {
  const m = parsePromExposition(EXPO);

  it('splits a model effort over its own total', () => {
    const rows = effortRowsForModel(m, 'claude-opus-4-8');
    expect(rows.map((r) => [r.label, r.count])).toEqual([
      ['high', 3], // EFFORT_ORDER sorts high before max
      ['max', 2],
    ]);
    expect(rows[0].pct).toBeCloseTo((3 / 5) * 100);
    expect(rows.reduce((a, r) => a + r.pct, 0)).toBeCloseTo(100);
  });

  it('returns empty for a model with no effort samples', () => {
    expect(effortRowsForModel(m, 'claude-haiku-4-5')).toEqual([]);
  });
});

describe('economy estimate', () => {
  const m = parsePromExposition(EXPO);

  it('excludes native and weighs routed reqs by blended price', () => {
    const e = economy(m);
    // routed: 5 opus + 1 sonnet (native opus excluded)
    expect(e.totalRoutedReqs).toBe(6);
    const expectedActual = 5 * blendedPricePerReq('claude-opus-4-8') + 1 * blendedPricePerReq('claude-sonnet-4-6');
    expect(e.actualUnits).toBeCloseTo(expectedActual);
    expect(e.opusUnits).toBeCloseTo(6 * OPUS_BLENDED);
    expect(e.savedPct).toBeGreaterThan(0); // sonnet is cheaper than opus
  });

  it('reports zero savings for an all-opus mix', () => {
    const allOpus = parsePromExposition('brick_cc_requests_total{label="easy",model="claude-opus-4-8"} 4');
    const e = economy(allOpus);
    expect(e.savedPct).toBeCloseTo(0);
  });

  it('is safe with no routed traffic', () => {
    const e = economy(parsePromExposition(''));
    expect(e).toEqual({ actualUnits: 0, opusUnits: 0, savedPct: 0, totalRoutedReqs: 0 });
  });
});
