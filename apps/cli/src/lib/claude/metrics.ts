// Persistent routing statistics and economics shared by status and the live dashboard.

import { blendedPricePerReq,OPUS_BLENDED } from './pricing.js';

export type DiagSystemOne = {
  enabled: boolean;
  ready?: boolean;
  engine?: string;
  revision?: string;
  device?: string;
  dtype?: string;
  threads?: number;
  max_tokens?: number;
  warmup_ms?: number;
  model?: string;
  latency_ms?: number;
  error?: string;
};

export type RoutingRow = { label: string; model: string; count: number; pct: number };

export interface Snapshot {
  baseUrl: string;
  attached: boolean;
  envUrl?: string;
  health: boolean;
  diag: DiagSystemOne | null;
  stats: HistoryStats | null;
}

export type JsonStats = { overall: { calls: number; completed_calls: number; failed_calls: number }; models: Array<{ model: string; routed_calls: number; native_calls: number; reasoning_modes: Array<{ mode: string; calls: number }> }> };
export type HistoryLatency = { average_ms: number | null; p50_ms: number | null; p95_ms: number | null };
export type HistoryStats = JsonStats & {
  latencies?: { routing: HistoryLatency; provider: HistoryLatency; overall: HistoryLatency };
};

export function historyRoutedRows(s: HistoryStats): RoutingRow[] {
  const total = s.overall.calls || 1;
  return s.models.filter((x) => x.routed_calls > 0).map((x) => ({ label: 'routed', model: x.model, count: x.routed_calls, pct: x.routed_calls * 100 / total }));
}

/** Total calls recorded in the persistent history. */
export function totalRequests(s: HistoryStats): number {
  return s.overall.calls;
}

/** Calls per model for router decisions (routed), as a share of all calls. */
export function routedRowsByModel(s: HistoryStats): RoutingRow[] {
  return aggregateByModel(s, (m) => m.routed_calls);
}

/** Same split for native traffic, which bypasses the router and is not a routing decision. */
export function nativeRowsByModel(s: HistoryStats): RoutingRow[] {
  return aggregateByModel(s, (m) => m.native_calls);
}

function aggregateByModel(s: HistoryStats, pick: (m: JsonStats['models'][number]) => number): RoutingRow[] {
  const total = totalRequests(s);
  return s.models
    .filter((m) => pick(m) > 0)
    .map((m) => ({ label: '', model: m.model, count: pick(m), pct: total === 0 ? 0 : (pick(m) / total) * 100 }))
    // The router returns its rows in a stable order, but sorting here anyway
    // keeps older routers (random map order in Go) from reshuffling the panel.
    .sort((a, b) => (b.count - a.count) || a.model.localeCompare(b.model));
}

/** Reasoning-mode split for one model, as a share of that model's own calls. */
export function effortRowsForModel(s: HistoryStats, model: string): RoutingRow[] {
  const row = s.models.find((m) => m.model === model);
  if (!row) return [];
  const modes = row.reasoning_modes ?? [];
  const modelTotal = modes.reduce((sum, mode) => sum + mode.calls, 0);
  return modes
    .map((mode) => ({
      label: mode.mode || 'default',
      model,
      count: mode.calls,
      pct: modelTotal === 0 ? 0 : (mode.calls / modelTotal) * 100,
    }))
    .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label));
}

/** Routing latency in seconds, read from the history percentiles (may be null). */
export function routingLatency(s: HistoryStats): { mean: number | null; p50: number | null; p95: number | null } {
  const routing = s.latencies?.routing;
  const toSeconds = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : ms / 1000);
  return { mean: toSeconds(routing?.average_ms), p50: toSeconds(routing?.p50_ms), p95: toSeconds(routing?.p95_ms) };
}

/**
 * Share of calls that ended in failure. The router does not report a routing
 * fallback counter anymore (a SystemOne failure aborts the request instead of
 * silently picking another model), so the CLI derives the degraded-request
 * share from the history it already receives.
 */
export function fallbackPct(s: HistoryStats): number {
  const total = totalRequests(s);
  return total === 0 ? 0 : (s.overall.failed_calls / total) * 100;
}

export async function probeHealth(baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

export type HealthResponse = {
  status: string;
  instance_id: string;
  profile: string;
  version: string;
  pid: number;
  config: string;
  routing_ready: boolean;
  routing_checked: boolean;
  codex_router?: string;
  authentication?: string;
  capability?: string;
};

export async function fetchHealth(baseUrl: string): Promise<HealthResponse | null> {
  try {
    const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    return (await r.json()) as HealthResponse;
  } catch {
    return null;
  }
}

export async function fetchDiag(baseUrl: string): Promise<DiagSystemOne | null> {
  try {
    const r = await fetch(`${baseUrl}/api/v1/diag/systemone`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    return (await r.json()) as DiagSystemOne;
  } catch {
    return null;
  }
}

export type EconomicsModelStats = {
  model: string;
  requests: number;
  input_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
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
  // Second, opus-anchored baseline: savings vs sending every priced request to
  // claude-opus, independent of which model is the most expensive observed.
  // Omitted by the router when opus is not priced in the active pool.
  savings_pct_vs_opus?: number;
  baseline_model?: string;
  pricing_available: boolean;
  note?: string;
};

export async function fetchEconomics(baseUrl: string, baselineModel?: string): Promise<EconomicsResponse | null> {
  try {
    const query = baselineModel ? `?baseline_model=${encodeURIComponent(baselineModel)}` : '';
    const r = await fetch(`${baseUrl}/api/v1/economics${query}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    return (await r.json()) as EconomicsResponse;
  } catch {
    return null;
  }
}

export async function fetchStats(baseUrl: string): Promise<HistoryStats | null> {
  try { const r = await fetch(`${baseUrl}/api/v1/stats`, { signal: AbortSignal.timeout(4000) }); return r.ok ? await r.json() as JsonStats : null; } catch { return null; }
}

/** One-shot fetch of everything the status/dashboard views need. */
export async function fetchSnapshot(baseUrl: string, envUrl?: string, attached?: boolean): Promise<Snapshot> {
  const [health, diag] = await Promise.all([probeHealth(baseUrl), fetchDiag(baseUrl)]);
  const stats = health ? await fetchStats(baseUrl) : null;
  return { baseUrl, envUrl, attached: attached ?? (envUrl === baseUrl), health, diag, stats };
}

/**
 * Clear persistent call history so the dashboard starts fresh without a
 * restart. The endpoint lives on the main proxy port; returns true on success.
 */
export async function resetMetrics(baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/api/v1/stats/clear`, {
      method: 'POST',
      signal: AbortSignal.timeout(4000),
    });
    return r.ok;
  } catch {
    return false;
  }
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
export type UnifiedEconomy = {
  source: 'real' | 'estimate' | 'unavailable';
  savedPct: number;
  // Present only when source === 'real':
  totalInputTokens?: number;
  // Anthropic prompt-cache counters (0 for routers that predate cache
  // tracking): most of a long session's context arrives as cache reads,
  // which is why totalInputTokens alone looks tiny next to Claude Code's
  // context meter.
  totalCacheCreationTokens?: number;
  totalCacheReadTokens?: number;
  totalOutputTokens?: number;
  mostExpensiveModel?: string;
  // Opus-anchored savings (source === 'real' only): present when the router
  // reports savings_pct_vs_opus, i.e. opus is priced in the active pool. Lets
  // the dashboard show a "vs opus" figure even when a pricier model (Fable)
  // owns the most-expensive baseline above.
  savedPctVsOpus?: number;
  baselineModel?: string;
  note?: string;
  // Present only when source === 'estimate' (request-count estimate):
  totalRoutedReqs?: number;
};

// Prefers real token-based savings from /api/v1/economics when the router
// exposes it AND has actual data (pricing_available && at least one model
// with non-zero estimated_cost_units contributing to the baseline).
// Falls back to the request-count estimate otherwise (older router,
// endpoint unreachable, or no priced traffic yet).
export function unifyEconomy(econ: EconomicsResponse | null, m: HistoryStats, baselineModel?: string): UnifiedEconomy {
  const totals = econ ? {
    totalInputTokens: econ.models.reduce((sum, row) => sum + row.input_tokens, 0),
    totalCacheCreationTokens: econ.models.reduce((sum, row) => sum + (row.cache_creation_input_tokens ?? 0), 0),
    totalCacheReadTokens: econ.models.reduce((sum, row) => sum + (row.cache_read_input_tokens ?? 0), 0),
    totalOutputTokens: econ.models.reduce((sum, row) => sum + row.output_tokens, 0),
  } : {};
  if (econ && econ.pricing_available && econ.baseline_cost_units_all_expensive > 0) {
    return {
      source: 'real',
      savedPct: econ.savings_pct,
      ...totals,
      mostExpensiveModel: econ.most_expensive_model,
      savedPctVsOpus: econ.savings_pct_vs_opus,
      baselineModel: econ.baseline_model ?? baselineModel,
      note: econ.note,
    };
  }
  if (baselineModel) {
    return { source: 'unavailable', savedPct: 0, ...totals, baselineModel, note: econ?.note };
  }
  const legacy = historyEconomy(m);
  return {
    source: 'estimate',
    savedPct: legacy.savedPct,
    totalRoutedReqs: legacy.totalRoutedReqs,
  };
}

function historyEconomy(m: HistoryStats): Economy {
  const routed = historyRoutedRows(m); let actualUnits = 0; let totalRoutedReqs = 0;
  for (const row of routed) { actualUnits += row.count * blendedPricePerReq(row.model); totalRoutedReqs += row.count; }
  const opusUnits = totalRoutedReqs * OPUS_BLENDED;
  return { actualUnits, opusUnits, savedPct: opusUnits ? (1 - actualUnits / opusUnits) * 100 : 0, totalRoutedReqs };
}

export function formatLatency(seconds: number): string {
  if (!isFinite(seconds)) return '>10s';
  const ms = seconds * 1000;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}
