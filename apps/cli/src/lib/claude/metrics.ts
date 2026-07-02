// Shared metric fetching + Prometheus parsing for `brick claude status` and the
// live dashboard. Kept free of any rendering so both the one-shot text output
// and the ink TUI can reuse it.

import { blendedPricePerReq, OPUS_BLENDED } from './pricing.js';

export type DiagClassifier = {
  enabled: boolean;
  endpoint?: string;
  reachable?: boolean;
  device?: string;
  model?: string;
  latency_ms?: number;
  error?: string;
};

export type ParsedMetrics = {
  requestsByLabelModel: Map<string, number>;
  effortByModelEffort: Map<string, number>;
  routingByDiffEffortModel: Map<string, number>;
  fallbackTotal: number;
  classifyDurationCount: number;
  classifyDurationSum: number;
  classifyDurationBuckets: Array<{ le: number; count: number }>;
};

export type RoutingRow = { label: string; model: string; count: number; pct: number };

export interface Snapshot {
  baseUrl: string;
  attached: boolean;
  envUrl?: string;
  health: boolean;
  diag: DiagClassifier | null;
  metrics: ParsedMetrics | null;
}

export async function probeHealth(baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function fetchDiag(baseUrl: string): Promise<DiagClassifier | null> {
  try {
    const r = await fetch(`${baseUrl}/api/v1/diag/classifier`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    return (await r.json()) as DiagClassifier;
  } catch {
    return null;
  }
}

export type EconomicsModelStats = {
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_ratio_in: number;
  cost_ratio_out: number;
  estimated_cost_units: number;
};

export type EconomicsResponse = {
  models: EconomicsModelStats[];
  most_expensive_model: string;
  actual_cost_units: number;
  baseline_cost_units_all_expensive: number;
  savings_pct: number;
  pricing_available: boolean;
  note?: string;
};

export async function fetchEconomics(baseUrl: string): Promise<EconomicsResponse | null> {
  try {
    const r = await fetch(`${baseUrl}/api/v1/economics`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    return (await r.json()) as EconomicsResponse;
  } catch {
    return null;
  }
}

export async function fetchMetrics(baseUrl: string): Promise<ParsedMetrics | null> {
  // The metrics endpoint is exposed on a separate port — try the same host on
  // the typical metrics ports first, then fall back to the proxy port itself.
  const url = new URL(baseUrl);
  const candidates = [
    `${url.protocol}//${url.hostname}:19190/metrics`,
    `${url.protocol}//${url.hostname}:9190/metrics`,
    `${baseUrl}/metrics`,
  ];
  for (const u of candidates) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return parsePromExposition(await r.text());
    } catch {
      // try next
    }
  }
  return null;
}

/** One-shot fetch of everything the status/dashboard views need. */
export async function fetchSnapshot(baseUrl: string, envUrl?: string): Promise<Snapshot> {
  const [health, diag] = await Promise.all([probeHealth(baseUrl), fetchDiag(baseUrl)]);
  const metrics = health ? await fetchMetrics(baseUrl) : null;
  return { baseUrl, envUrl, attached: envUrl === baseUrl, health, diag, metrics };
}

/**
 * Clear the router's Brick routing counters (brick_cc_*) so the dashboard starts
 * fresh without a restart. POSTs to the reset endpoint on the proxy port.
 * Returns true on success. The endpoint lives on the main proxy port (unlike
 * /metrics, which may be on a dedicated port), so we hit baseUrl directly.
 */
export async function resetMetrics(baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/api/v1/metrics/reset`, {
      method: 'POST',
      signal: AbortSignal.timeout(4000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export function parsePromExposition(body: string): ParsedMetrics {
  const out: ParsedMetrics = {
    requestsByLabelModel: new Map(),
    effortByModelEffort: new Map(),
    routingByDiffEffortModel: new Map(),
    fallbackTotal: 0,
    classifyDurationCount: 0,
    classifyDurationSum: 0,
    classifyDurationBuckets: [],
  };

  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('brick_cc_effort_total')) {
      const m = line.match(/^brick_cc_effort_total\{([^}]*)\}\s+([0-9.eE+-]+)$/);
      if (!m) continue;
      const labels = parseLabels(m[1]);
      const key = `${labels.model ?? 'unknown'}|${labels.effort ?? 'unknown'}`;
      out.effortByModelEffort.set(key, (out.effortByModelEffort.get(key) ?? 0) + Number(m[2]));
    } else if (line.startsWith('brick_cc_routing_total')) {
      const m = line.match(/^brick_cc_routing_total\{([^}]*)\}\s+([0-9.eE+-]+)$/);
      if (!m) continue;
      const labels = parseLabels(m[1]);
      const key = `${labels.difficulty ?? 'unknown'}|${labels.effort ?? 'unknown'}|${labels.model ?? 'unknown'}`;
      out.routingByDiffEffortModel.set(key, (out.routingByDiffEffortModel.get(key) ?? 0) + Number(m[2]));
    } else if (line.startsWith('brick_cc_requests_total')) {
      const m = line.match(/^brick_cc_requests_total\{([^}]*)\}\s+([0-9.eE+-]+)$/);
      if (!m) continue;
      const labels = parseLabels(m[1]);
      const key = `${labels.label ?? 'unknown'}|${labels.model ?? 'unknown'}`;
      out.requestsByLabelModel.set(key, (out.requestsByLabelModel.get(key) ?? 0) + Number(m[2]));
    } else if (line.startsWith('brick_cc_classify_fallback_total')) {
      const m = line.match(/^brick_cc_classify_fallback_total\s+([0-9.eE+-]+)$/);
      if (m) out.fallbackTotal += Number(m[1]);
    } else if (line.startsWith('brick_cc_classify_duration_seconds_count')) {
      const m = line.match(/^brick_cc_classify_duration_seconds_count\s+([0-9.eE+-]+)$/);
      if (m) out.classifyDurationCount += Number(m[1]);
    } else if (line.startsWith('brick_cc_classify_duration_seconds_sum')) {
      const m = line.match(/^brick_cc_classify_duration_seconds_sum\s+([0-9.eE+-]+)$/);
      if (m) out.classifyDurationSum += Number(m[1]);
    } else if (line.startsWith('brick_cc_classify_duration_seconds_bucket')) {
      const m = line.match(/^brick_cc_classify_duration_seconds_bucket\{le="([^"]+)"\}\s+([0-9.eE+-]+)$/);
      if (!m) continue;
      const le = m[1] === '+Inf' ? Number.POSITIVE_INFINITY : Number(m[1]);
      out.classifyDurationBuckets.push({ le, count: Number(m[2]) });
    }
  }

  out.classifyDurationBuckets.sort((a, b) => a.le - b.le);
  return out;
}

export function parseLabels(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Naive label parser; assumes well-formed Prometheus exposition output.
  for (const m of s.matchAll(/(\w+)="([^"]*)"/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

export const LABEL_ORDER = ['easy', 'medium', 'hard'];

// Label emitted by the router for requests that bypass the skill router entirely
// (client picked a native model explicitly, so the complexity classifier never ran).
export const NATIVE_LABEL = 'native';

export function totalRequests(m: ParsedMetrics): number {
  return [...m.requestsByLabelModel.values()].reduce((a, b) => a + b, 0);
}

export function routingRows(m: ParsedMetrics): RoutingRow[] {
  const total = totalRequests(m);
  const rows: RoutingRow[] = [];
  for (const [key, count] of m.requestsByLabelModel.entries()) {
    const [label, model] = key.split('|');
    rows.push({ label, model, count, pct: total === 0 ? 0 : (count / total) * 100 });
  }
  rows.sort((a, b) => LABEL_ORDER.indexOf(a.label) - LABEL_ORDER.indexOf(b.label));
  return rows;
}

// Aggregates the {label, model} counter into one row per selected model, keeping
// only Brick-routed traffic (label !== native). The difficulty label is dropped
// on purpose: it is just the complexity classifier's verdict, one of several
// inputs, and pairing it with the final model implies a mapping that does not
// exist. Percentages are over the grand total so routed + native sum to ~100%.
export function routedRowsByModel(m: ParsedMetrics): RoutingRow[] {
  return aggregateByModel(m, (label) => label !== NATIVE_LABEL);
}

// Same aggregation but only for native (router-bypass) traffic. Kept separate
// from the routed rows because a native opus call is not a routing decision.
export function nativeRowsByModel(m: ParsedMetrics): RoutingRow[] {
  return aggregateByModel(m, (label) => label === NATIVE_LABEL);
}

function aggregateByModel(m: ParsedMetrics, keep: (label: string) => boolean): RoutingRow[] {
  const total = totalRequests(m);
  const byModel = new Map<string, number>();
  for (const [key, count] of m.requestsByLabelModel.entries()) {
    const [label, model] = key.split('|');
    if (!keep(label)) continue;
    byModel.set(model, (byModel.get(model) ?? 0) + count);
  }
  const rows: RoutingRow[] = [];
  for (const [model, count] of byModel.entries()) {
    rows.push({ label: '', model, count, pct: total === 0 ? 0 : (count / total) * 100 });
  }
  rows.sort((a, b) => b.count - a.count);
  return rows;
}

// Distribution of the complexity classifier verdict across Brick-routed traffic,
// independent of which model was ultimately selected. Native traffic is excluded
// since it never gets classified. Percentages are over routed traffic only.
export function difficultyDistribution(m: ParsedMetrics): RoutingRow[] {
  const byLabel = new Map<string, number>();
  let routedTotal = 0;
  for (const [key, count] of m.requestsByLabelModel.entries()) {
    const [label] = key.split('|');
    if (label === NATIVE_LABEL) continue;
    byLabel.set(label, (byLabel.get(label) ?? 0) + count);
    routedTotal += count;
  }
  const rows: RoutingRow[] = [];
  for (const [label, count] of byLabel.entries()) {
    rows.push({ label, model: '', count, pct: routedTotal === 0 ? 0 : (count / routedTotal) * 100 });
  }
  rows.sort((a, b) => LABEL_ORDER.indexOf(a.label) - LABEL_ORDER.indexOf(b.label));
  return rows;
}

export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

// Distribution of autonomous reasoning effort for a single model: one row per
// effort level, pct over that model's own routed requests. Empty when the model
// has no effort samples (e.g. effort tracking just started, or Haiku which has a
// reduced vocabulary). The `label` field carries the effort name.
export function effortRowsForModel(m: ParsedMetrics, model: string): RoutingRow[] {
  const byEffort = new Map<string, number>();
  let modelTotal = 0;
  for (const [key, count] of m.effortByModelEffort.entries()) {
    const [mdl, effort] = key.split('|');
    if (mdl !== model) continue;
    byEffort.set(effort, (byEffort.get(effort) ?? 0) + count);
    modelTotal += count;
  }
  const rows: RoutingRow[] = [];
  for (const [effort, count] of byEffort.entries()) {
    rows.push({ label: effort, model, count, pct: modelTotal === 0 ? 0 : (count / modelTotal) * 100 });
  }
  rows.sort((a, b) => EFFORT_ORDER.indexOf(a.label) - EFFORT_ORDER.indexOf(b.label));
  return rows;
}

// Cross-product of classifier verdict and autonomous effort for Brick-routed
// traffic, one cell per (difficulty, effort) pair. Both axes are decisions Brick
// makes on the same request, so pairing them is meaningful (unlike difficulty x
// final-model, see routedRowsByModel). topModel is the model that won the most
// requests in that cell, used only to tint the heatmap cell.
export type HeatCell = { difficulty: string; effort: string; count: number; topModel: string };

export function routingHeatmap(m: ParsedMetrics): { cells: HeatCell[]; max: number; estimated: boolean } {
  // Exact path: the 3-label counter directly carries the (difficulty, effort,
  // model) cross-product. Available once the router emitting brick_cc_routing_total
  // is running.
  if (m.routingByDiffEffortModel.size > 0) {
    return buildHeatmap(m.routingByDiffEffortModel, false);
  }
  // Fallback for routers that only expose the two marginal counters: reconstruct
  // an estimate by spreading each model's difficulty distribution across its own
  // effort distribution (per-model outer product). Not the true joint, but it
  // lights up the same diagonal so the heatmap works without a router restart.
  const synth = synthesizeRoutingFromMarginals(m);
  return buildHeatmap(synth, true);
}

// Shared aggregation: a (difficulty|effort|model) -> count map into per-cell
// totals plus the busiest model per cell (for the tint).
function buildHeatmap(
  byKey: Map<string, number>,
  estimated: boolean
): { cells: HeatCell[]; max: number; estimated: boolean } {
  const cellCount = new Map<string, number>();
  const cellModels = new Map<string, Map<string, number>>();
  for (const [key, count] of byKey.entries()) {
    const [difficulty, effort, model] = key.split('|');
    const cellKey = `${difficulty}|${effort}`;
    cellCount.set(cellKey, (cellCount.get(cellKey) ?? 0) + count);
    let models = cellModels.get(cellKey);
    if (!models) {
      models = new Map();
      cellModels.set(cellKey, models);
    }
    models.set(model, (models.get(model) ?? 0) + count);
  }

  const cells: HeatCell[] = [];
  let max = 0;
  for (const [cellKey, count] of cellCount.entries()) {
    const [difficulty, effort] = cellKey.split('|');
    let topModel = '';
    let topCount = -1;
    for (const [model, c] of cellModels.get(cellKey)!.entries()) {
      if (c > topCount) {
        topCount = c;
        topModel = model;
      }
    }
    cells.push({ difficulty, effort, count, topModel });
    if (count > max) max = count;
  }
  return { cells, max, estimated };
}

// Approximate the (difficulty, effort, model) joint from the two marginal
// counters when the exact one is absent. For each model we know how its routed
// requests split by difficulty (requestsByLabelModel) and by effort
// (effortByModelEffort); the per-model outer product, normalised by the model's
// total, is the maximum-entropy estimate of the joint that respects both margins.
function synthesizeRoutingFromMarginals(m: ParsedMetrics): Map<string, number> {
  const diffByModel = new Map<string, Map<string, number>>();
  const modelTotal = new Map<string, number>();
  for (const [key, count] of m.requestsByLabelModel.entries()) {
    const [label, model] = key.split('|');
    if (label === NATIVE_LABEL) continue;
    let d = diffByModel.get(model);
    if (!d) { d = new Map(); diffByModel.set(model, d); }
    d.set(label, (d.get(label) ?? 0) + count);
    modelTotal.set(model, (modelTotal.get(model) ?? 0) + count);
  }

  const effByModel = new Map<string, Map<string, number>>();
  for (const [key, count] of m.effortByModelEffort.entries()) {
    const [model, effort] = key.split('|');
    let e = effByModel.get(model);
    if (!e) { e = new Map(); effByModel.set(model, e); }
    e.set(effort, (e.get(effort) ?? 0) + count);
  }

  const out = new Map<string, number>();
  for (const [model, diffs] of diffByModel.entries()) {
    const total = modelTotal.get(model) ?? 0;
    if (total === 0) continue;
    const efforts = effByModel.get(model);
    // No effort samples for this model (e.g. effort tracking just started): fall
    // back to attributing all of its difficulty mass to the medium effort lane so
    // the model still shows up on the grid.
    const effEntries = efforts && efforts.size > 0 ? [...efforts.entries()] : [['medium', total]] as Array<[string, number]>;
    const effTotal = effEntries.reduce((a, [, c]) => a + c, 0) || 1;
    for (const [label, dCount] of diffs.entries()) {
      for (const [effort, eCount] of effEntries) {
        const joint = (dCount * eCount) / effTotal; // share of this model's diff mass at this effort
        if (joint <= 0) continue;
        const key = `${label}|${effort}|${model}`;
        out.set(key, (out.get(key) ?? 0) + joint);
      }
    }
  }
  return out;
}

// Block character for a cell whose count is `count` against the busiest cell's
// `max`. Any cell with traffic gets at least the second shade so a smart-but-rare
// decision (e.g. hard+max on opus) still lights up next to a dominant cell;
// empty cells stay at the lightest shade so the grid keeps its shape.
const SHADES = ['░', '▒', '▓', '█'];

export function shadeFor(count: number, max: number): string {
  if (max <= 0 || count <= 0) return SHADES[0];
  const ratio = count / max;
  if (ratio > 0.66) return SHADES[3];
  if (ratio > 0.33) return SHADES[2];
  return SHADES[1];
}

export type Economy = {
  actualUnits: number;   // blended cost weight of the actual routed mix
  opusUnits: number;     // blended cost weight if everything had gone to opus
  savedPct: number;      // 1 - actual/opus, in percent (0 when no routed traffic)
  totalRoutedReqs: number;
};

// Relative cost estimate of the routed traffic vs an all-opus baseline. Native
// requests are excluded since they are not a Brick routing decision. See
// pricing.ts for the (deliberate) assumptions: this is a request-mix estimate,
// not a token-accurate dollar figure.
export function economy(m: ParsedMetrics): Economy {
  const routed = routedRowsByModel(m);
  let actualUnits = 0;
  let totalRoutedReqs = 0;
  for (const r of routed) {
    actualUnits += r.count * blendedPricePerReq(r.model);
    totalRoutedReqs += r.count;
  }
  const opusUnits = totalRoutedReqs * OPUS_BLENDED;
  const savedPct = opusUnits === 0 ? 0 : (1 - actualUnits / opusUnits) * 100;
  return { actualUnits, opusUnits, savedPct, totalRoutedReqs };
}

export type UnifiedEconomy = {
  source: 'real' | 'estimate';
  savedPct: number;
  // Present only when source === 'real':
  totalInputTokens?: number;
  totalOutputTokens?: number;
  mostExpensiveModel?: string;
  // Present only when source === 'estimate' (mirrors legacy Economy):
  totalRoutedReqs?: number;
};

// Prefers real token-based savings from /api/v1/economics when the router
// exposes it AND has actual data (pricing_available && at least one model
// with non-zero estimated_cost_units contributing to the baseline).
// Falls back to the legacy request-count estimate otherwise (older router,
// endpoint unreachable, or no priced traffic yet).
export function unifyEconomy(econ: EconomicsResponse | null, m: ParsedMetrics): UnifiedEconomy {
  if (econ && econ.pricing_available && econ.baseline_cost_units_all_expensive > 0) {
    const totalInputTokens = econ.models.reduce((sum, row) => sum + row.input_tokens, 0);
    const totalOutputTokens = econ.models.reduce((sum, row) => sum + row.output_tokens, 0);
    return {
      source: 'real',
      savedPct: econ.savings_pct,
      totalInputTokens,
      totalOutputTokens,
      mostExpensiveModel: econ.most_expensive_model,
    };
  }
  const legacy = economy(m);
  return {
    source: 'estimate',
    savedPct: legacy.savedPct,
    totalRoutedReqs: legacy.totalRoutedReqs,
  };
}

export function classifierPercentiles(m: ParsedMetrics): { p50: number | null; p95: number | null } {
  return {
    p50: bucketPercentile(m.classifyDurationBuckets, m.classifyDurationCount, 0.5),
    p95: bucketPercentile(m.classifyDurationBuckets, m.classifyDurationCount, 0.95),
  };
}

/** Mean classifier call latency in seconds (histogram sum/count), or null when
 *  no classify calls have been recorded yet. */
export function classifierMean(m: ParsedMetrics): number | null {
  return m.classifyDurationCount > 0 ? m.classifyDurationSum / m.classifyDurationCount : null;
}

export function fallbackPct(m: ParsedMetrics): number {
  const total = totalRequests(m);
  return total === 0 ? 0 : (m.fallbackTotal / total) * 100;
}

export function bucketPercentile(
  buckets: Array<{ le: number; count: number }>,
  total: number,
  q: number
): number | null {
  if (total === 0 || buckets.length === 0) return null;
  const target = total * q;
  for (const b of buckets) {
    if (b.count >= target) return b.le;
  }
  return buckets[buckets.length - 1].le;
}

export function formatLatency(seconds: number): string {
  if (!isFinite(seconds)) return '>10s';
  const ms = seconds * 1000;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}
