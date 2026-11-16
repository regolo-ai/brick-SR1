import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { atomicWrite } from '../config/atomic-file.js';
import { paths } from '../config/paths.js';
import { ensureProfilePricing } from '../config/pricing.js';
import { eurUsdRate, type FxRate } from './fx.js';
import { mergePricing } from './merge.js';
import {
  SOURCE_OPENROUTER,
  SOURCE_REGOLO,
  dumpPricingYaml,
  normalizePrice,
  readPricingFile,
  snapshotOf,
  type PricingEntry,
  type SyncedSnapshot,
} from './table.js';
import { REGOLO_PRICING_URL, fetchRegoloPricing } from './sources/regolo.js';
import { OPENROUTER_MODELS_URL, fetchOpenRouterPricing, resolveOpenRouterId } from './sources/openrouter.js';

export interface SyncOptions {
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  warn?: (message: string) => void;
  /** Price every model in the upstream catalogues instead of the profile pool. */
  all?: boolean;
}

export interface SyncResult {
  profile: string;
  file: string;
  written: boolean;
  pool: string[];
  added: string[];
  updated: string[];
  /** Local rows we deliberately left alone (edited by hand or from an older release). */
  kept: string[];
  /** Pool models no source could price. */
  unpriced: string[];
  sources: string[];
  fx?: Pick<FxRate, 'rate' | 'date' | 'stale'>;
}

export function pricingCacheDir(explicit?: string): string {
  return explicit ?? join(homedir(), '.brick', 'cache', 'pricing');
}

/** The price table shipped with this CLI, used to recognise untouched rows. */
function seedPricingPath(): string {
  return fileURLToPath(new URL('../../../assets/pricing.yaml', import.meta.url));
}

function sameRow(a: PricingEntry, b: PricingEntry): boolean {
  return a.input_price === b.input_price
    && a.output_price === b.output_price
    && (a.currency ?? '') === (b.currency ?? '')
    && (a.provider ?? '') === (b.provider ?? '')
    && (a.source ?? '') === (b.source ?? '');
}

/**
 * Rows that are still byte-for-byte the shipped seed values: nobody edited
 * them, so the sync may migrate them (e.g. Regolo EUR → USD) instead of
 * keeping a legacy currency forever. A hand-edited value breaks the match and
 * the row is protected.
 */
async function adoptableRows(existing: PricingEntry[]): Promise<Set<string>> {
  let seed: PricingEntry[] = [];
  try { seed = await readPricingFile(seedPricingPath()); }
  catch { return new Set(); }
  const byModel = new Map(seed.map((row) => [row.model, row]));
  const adopt = new Set<string>();
  for (const row of existing) {
    const original = byModel.get(row.model);
    if (original && sameRow(row, original)) adopt.add(row.model);
  }
  return adopt;
}

function lastSyncPath(profile: string, cacheDir?: string): string {
  return join(pricingCacheDir(cacheDir), `last-sync-${profile}.json`);
}

async function readLastSync(path: string): Promise<Record<string, SyncedSnapshot>> {
  try { return JSON.parse(await readFile(path, 'utf8')) as Record<string, SyncedSnapshot>; }
  catch { return {}; }
}

function profilePool(raw: any): { pool: string[]; endpoints: Record<string, string> } {
  const config = raw?.model_config ?? {};
  const pool = Object.keys(config);
  const endpoints: Record<string, string> = {};
  for (const id of pool) {
    const preferred = config[id]?.preferred_endpoints;
    endpoints[id] = Array.isArray(preferred) && typeof preferred[0] === 'string' ? preferred[0] : '';
  }
  return { pool, endpoints };
}

function nowIso(options: SyncOptions): string {
  return new Date(options.now?.() ?? Date.now()).toISOString();
}

/**
 * Refresh the profile's pricing.yaml from the public sources, normalised to USD
 * so the router can compare every model in the pool on one currency.
 */
export async function syncProfilePricing(profile: string, options: SyncOptions = {}): Promise<SyncResult> {
  const pp = paths(profile);
  // First start on a profile that has never been seeded still gets a table.
  await ensureProfilePricing(profile);
  const raw = yaml.load(await readFile(pp.config, 'utf8')) as any;
  const { pool, endpoints } = profilePool(raw);
  const result: SyncResult = {
    profile, file: pp.profileDir + '/pricing.yaml', written: false,
    pool, added: [], updated: [], kept: [], unpriced: [], sources: [],
  };
  if (pool.length === 0) return result;

  const [regolo, openrouter, fx] = await Promise.allSettled([
    fetchRegoloPricing(options),
    fetchOpenRouterPricing(options),
    eurUsdRate(options),
  ]);
  if (regolo.status === 'rejected') options.warn?.(`regolo prices unavailable: ${regolo.reason?.message ?? regolo.reason}`);
  if (openrouter.status === 'rejected') options.warn?.(`openrouter prices unavailable: ${openrouter.reason?.message ?? openrouter.reason}`);
  if (fx.status === 'rejected') options.warn?.(`fx unavailable: ${fx.reason?.message ?? fx.reason}`);

  const regoloPrices = regolo.status === 'fulfilled' ? regolo.value.prices : new Map();
  const openRouterPrices = openrouter.status === 'fulfilled' ? openrouter.value.prices : new Map();
  const rate = fx.status === 'fulfilled' ? fx.value : undefined;
  if (regolo.status === 'fulfilled') result.sources.push(regolo.value.cached ? 'regolo(cached)' : 'regolo');
  if (openrouter.status === 'fulfilled') result.sources.push(openrouter.value.cached ? 'openrouter(cached)' : 'openrouter');
  if (rate) result.fx = { rate: rate.rate, date: rate.date, stale: rate.stale };

  const models = options.all
    ? [...new Set([...pool, ...regoloPrices.keys(), ...openRouterPrices.keys()])]
    : pool;

  const fetchedAt = nowIso(options);
  const incoming: PricingEntry[] = [];
  for (const model of models) {
    const endpoint = endpoints[model] ?? '';
    const regoloServed = /regolo/i.test(endpoint) || (!endpoint && regoloPrices.has(model));
    if (regoloServed && regoloPrices.has(model) && rate) {
      const price = regoloPrices.get(model)!;
      incoming.push({
        provider: 'regolo',
        model,
        input_price: normalizePrice(price.input * rate.rate),
        output_price: normalizePrice(price.output * rate.rate),
        currency: 'USD',
        source: SOURCE_REGOLO,
        source_url: REGOLO_PRICING_URL,
        fetched_at: fetchedAt,
        source_currency: 'EUR',
        source_input_price: price.input,
        source_output_price: price.output,
        fx_rate: rate.rate,
        fx_date: rate.date,
      });
      continue;
    }
    const slug = resolveOpenRouterId(model, openRouterPrices.keys());
    const price = slug ? openRouterPrices.get(slug) : undefined;
    if (slug && price) {
      incoming.push({
        provider: slug.split('/')[0],
        model,
        input_price: normalizePrice(price.input),
        output_price: normalizePrice(price.output),
        cached_input_price: price.cached_input === undefined ? undefined : normalizePrice(price.cached_input),
        currency: 'USD',
        source: SOURCE_OPENROUTER,
        source_url: OPENROUTER_MODELS_URL,
        source_model: slug,
        fetched_at: fetchedAt,
      });
      continue;
    }
    result.unpriced.push(model);
  }

  const existing = await readPricingFile(result.file);
  const statePath = lastSyncPath(profile, options.cacheDir);
  const lastSynced = await readLastSync(statePath);
  const adopt = await adoptableRows(existing);
  const merged = mergePricing(existing, incoming, lastSynced, adopt);
  result.added = merged.added;
  result.updated = merged.updated;
  result.kept = merged.kept;

  const next = dumpPricingYaml(merged.rows);
  if (next !== dumpPricingYaml(existing)) {
    await atomicWrite(result.file, next, 0o600);
    result.written = true;
  }

  // Remember exactly what we wrote, so the next sync can tell a stale row of
  // ours from a price the user edited by hand.
  const written = new Map<string, SyncedSnapshot>();
  for (const row of merged.rows) {
    if (row.source === SOURCE_REGOLO || row.source === SOURCE_OPENROUTER) written.set(row.model, snapshotOf(row));
  }
  await mkdir(pricingCacheDir(options.cacheDir), { recursive: true, mode: 0o700 });
  await atomicWrite(statePath, JSON.stringify(Object.fromEntries(written), null, 2), 0o600);
  return result;
}
