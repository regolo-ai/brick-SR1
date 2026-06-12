// Shared metric fetching + Prometheus parsing for `brick claude status` and the
// live dashboard. Kept free of any rendering so both the one-shot text output
// and the ink TUI can reuse it.

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

export function parsePromExposition(body: string): ParsedMetrics {
  const out: ParsedMetrics = {
    requestsByLabelModel: new Map(),
    fallbackTotal: 0,
    classifyDurationCount: 0,
    classifyDurationSum: 0,
    classifyDurationBuckets: [],
  };

  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('brick_cc_requests_total')) {
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

const LABEL_ORDER = ['easy', 'medium', 'hard'];

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

export function classifierPercentiles(m: ParsedMetrics): { p50: number | null; p95: number | null } {
  return {
    p50: bucketPercentile(m.classifyDurationBuckets, m.classifyDurationCount, 0.5),
    p95: bucketPercentile(m.classifyDurationBuckets, m.classifyDurationCount, 0.95),
  };
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
