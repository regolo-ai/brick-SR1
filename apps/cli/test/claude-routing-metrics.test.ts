import { describe, it, expect } from 'vitest';
import {
  parsePromExposition,
  routedRowsByModel,
  nativeRowsByModel,
  difficultyDistribution,
  effortRowsForModel,
  routingHeatmap,
  shadeFor,
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

// difficulty x effort x model cross-product: easy traffic spread over haiku at
// two efforts, hard traffic on opus. sonnet edges haiku in one mixed cell so we
// can assert topModel resolves to the busiest model in that cell.
const HEAT_EXPO = `
# TYPE brick_cc_routing_total counter
brick_cc_routing_total{difficulty="easy",effort="low",model="claude-haiku-4-5"} 8
brick_cc_routing_total{difficulty="easy",effort="medium",model="claude-haiku-4-5"} 2
brick_cc_routing_total{difficulty="medium",effort="medium",model="claude-haiku-4-5"} 1
brick_cc_routing_total{difficulty="medium",effort="medium",model="claude-sonnet-4-6"} 3
brick_cc_routing_total{difficulty="hard",effort="max",model="claude-opus-4-8"} 5
`.trim();

describe('routing heatmap', () => {
  const m = parsePromExposition(HEAT_EXPO);

  it('parses the 3-label routing counter into its own map', () => {
    expect(m.routingByDiffEffortModel.get('easy|low|claude-haiku-4-5')).toBe(8);
    expect(m.routingByDiffEffortModel.get('hard|max|claude-opus-4-8')).toBe(5);
  });

  it('aggregates per difficulty x effort cell with the busiest cell as max', () => {
    const { cells, max, estimated } = routingHeatmap(m);
    expect(estimated).toBe(false); // exact counter present
    expect(max).toBe(8); // easy|low is the busiest
    const easyLow = cells.find((c) => c.difficulty === 'easy' && c.effort === 'low');
    expect(easyLow?.count).toBe(8);
    expect(easyLow?.topModel).toBe('claude-haiku-4-5');
  });

  it('picks the model with the most requests in a mixed cell', () => {
    const { cells } = routingHeatmap(m);
    const medMed = cells.find((c) => c.difficulty === 'medium' && c.effort === 'medium');
    expect(medMed?.count).toBe(4); // 1 haiku + 3 sonnet
    expect(medMed?.topModel).toBe('claude-sonnet-4-6'); // sonnet wins 3 vs 1
  });

  it('is empty when no routing counter is present', () => {
    const { cells, max } = routingHeatmap(parsePromExposition(''));
    expect(cells).toEqual([]);
    expect(max).toBe(0);
  });
});

// When the router only exposes the two marginal counters (no brick_cc_routing_total),
// the heatmap reconstructs an estimate from requestsByLabelModel x effortByModelEffort.
describe('routing heatmap fallback from marginal counters', () => {
  // haiku: all easy, all low effort. opus: all hard, all max effort. The
  // per-model outer product must land each model's mass on a single cell.
  const MARGINALS = `
brick_cc_requests_total{label="easy",model="claude-haiku-4-5"} 10
brick_cc_requests_total{label="hard",model="claude-opus-4-8"} 4
brick_cc_requests_total{label="native",model="claude-opus-4-8"} 3
brick_cc_effort_total{model="claude-haiku-4-5",effort="low"} 10
brick_cc_effort_total{model="claude-opus-4-8",effort="max"} 4
`.trim();
  const m = parsePromExposition(MARGINALS);

  it('flags the result as estimated', () => {
    expect(routingHeatmap(m).estimated).toBe(true);
  });

  it('places each model mass on its difficulty x effort cell, excluding native', () => {
    const { cells } = routingHeatmap(m);
    const easyLow = cells.find((c) => c.difficulty === 'easy' && c.effort === 'low');
    const hardMax = cells.find((c) => c.difficulty === 'hard' && c.effort === 'max');
    expect(easyLow?.count).toBeCloseTo(10);
    expect(easyLow?.topModel).toBe('claude-haiku-4-5');
    expect(hardMax?.count).toBeCloseTo(4); // native 3 not counted
    expect(hardMax?.topModel).toBe('claude-opus-4-8');
  });

  it('attributes a model with no effort samples to the medium lane', () => {
    const noEffort = parsePromExposition('brick_cc_requests_total{label="medium",model="claude-sonnet-4-6"} 6');
    const { cells, estimated } = routingHeatmap(noEffort);
    expect(estimated).toBe(true);
    const cell = cells.find((c) => c.difficulty === 'medium' && c.effort === 'medium');
    expect(cell?.count).toBeCloseTo(6);
  });
});

describe('shadeFor', () => {
  it('returns the lightest shade for empty or zero-max cells', () => {
    expect(shadeFor(0, 10)).toBe('░');
    expect(shadeFor(5, 0)).toBe('░');
  });

  it('lights up any cell with traffic, scaling shade with intensity', () => {
    expect(shadeFor(1, 10)).toBe('▒');  // 10% — rare but visible
    expect(shadeFor(4, 10)).toBe('▓');  // 40%
    expect(shadeFor(7, 10)).toBe('█');  // 70%
    expect(shadeFor(10, 10)).toBe('█'); // 100%
  });
});
