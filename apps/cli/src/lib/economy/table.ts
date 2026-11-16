import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';

/** Marker for rows written by the CLI sync (Regolo listino). */
export const SOURCE_REGOLO = 'regolo_scrape';
/** Marker for rows written by the CLI sync (OpenRouter feed). */
export const SOURCE_OPENROUTER = 'openrouter';

export const SYNCED_SOURCES = new Set([SOURCE_REGOLO, SOURCE_OPENROUTER]);

/**
 * One row of pricing.yaml. Unknown fields are preserved verbatim so manual
 * annotations added by users survive a sync.
 */
export interface PricingEntry {
  model: string;
  input_price: number;
  output_price: number;
  cached_input_price?: number;
  currency: string;
  provider?: string;
  source?: string;
  source_url?: string;
  fetched_at?: string;
  source_currency?: string;
  source_input_price?: number;
  source_output_price?: number;
  fx_rate?: number;
  fx_date?: string;
  [key: string]: unknown;
}

export class InvalidPricingError extends Error {}

function finite(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Parse a pricing.yaml body; malformed rows are dropped, not fatal. */
export function parsePricingYaml(text: string): PricingEntry[] {
  let parsed: unknown;
  try { parsed = yaml.load(text); }
  catch (error: any) { throw new InvalidPricingError(`pricing.yaml is not valid YAML: ${error?.message ?? error}`); }
  if (parsed == null) return [];
  if (!Array.isArray(parsed)) throw new InvalidPricingError('pricing.yaml must contain a list of price entries');
  const rows: PricingEntry[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.model !== 'string' || row.model === '') continue;
    const input = finite(row.input_price);
    const output = finite(row.output_price);
    if (input === undefined || output === undefined) continue;
    rows.push({
      ...row,
      model: row.model,
      input_price: input,
      output_price: output,
      cached_input_price: finite(row.cached_input_price),
      currency: typeof row.currency === 'string' && row.currency !== '' ? row.currency : 'USD',
    });
  }
  return rows;
}

export function dumpPricingYaml(rows: PricingEntry[]): string {
  // Keep the file diff-friendly: one row block per model, stable key order.
  const ordered = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const key of ['provider', 'model', 'input_price', 'cached_input_price', 'output_price', 'currency']) {
      if (row[key] !== undefined) out[key] = row[key];
    }
    for (const [key, value] of Object.entries(row)) {
      if (!(key in out) && value !== undefined) out[key] = value;
    }
    return out;
  });
  return yaml.dump(ordered, { lineWidth: 120, noRefs: true, sortKeys: false });
}

export async function readPricingFile(path: string): Promise<PricingEntry[]> {
  try { return parsePricingYaml(await readFile(path, 'utf8')); }
  catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** Prices are quoted per 1M tokens; four decimals are plenty for display. */
export function normalizePrice(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

export function isSyncedRow(row: PricingEntry): boolean {
  return typeof row.source === 'string' && SYNCED_SOURCES.has(row.source);
}

/** Snapshot used to detect rows a user edited by hand after our last write. */
export interface SyncedSnapshot {
  input_price: number;
  output_price: number;
  currency: string;
}

export function snapshotOf(row: PricingEntry): SyncedSnapshot {
  return { input_price: row.input_price, output_price: row.output_price, currency: row.currency };
}

export function sameSnapshot(a: SyncedSnapshot, b: SyncedSnapshot): boolean {
  return a.input_price === b.input_price && a.output_price === b.output_price && a.currency === b.currency;
}
