import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWrite } from '../config/atomic-file.js';

/** ECB reference rates, published once per business day, no API key needed. */
export const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD';
export const FX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface FxRate {
  /** USD per 1 EUR. */
  rate: number;
  /** ECB publication date (YYYY-MM-DD). */
  date: string;
  /** When this value was fetched (ISO). */
  fetched_at: string;
  stale?: boolean;
}

export interface FxOptions {
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAgeMs?: number;
  now?: () => number;
  warn?: (message: string) => void;
}

export function fxCachePath(cacheDir?: string): string {
  return join(cacheDir ?? join(homedir(), '.brick', 'cache', 'pricing'), 'fx.json');
}

function validRate(value: unknown): value is FxRate {
  if (!value || typeof value !== 'object') return false;
  const row = value as FxRate;
  return typeof row.rate === 'number' && Number.isFinite(row.rate) && row.rate > 0 && typeof row.date === 'string';
}

async function readCache(path: string): Promise<FxRate | null> {
  try { const parsed = JSON.parse(await readFile(path, 'utf8')); return validRate(parsed) ? parsed : null; }
  catch { return null; }
}

async function fetchRate(options: FxOptions): Promise<FxRate> {
  const response = await (options.fetchImpl ?? fetch)(FX_URL, { signal: AbortSignal.timeout(options.timeoutMs ?? 5000) });
  if (!response.ok) throw new Error(`frankfurter returned HTTP ${response.status}`);
  const body = await response.json() as { date?: string; rates?: { USD?: number } };
  const rate = body?.rates?.USD;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) throw new Error('frankfurter response has no USD rate');
  return { rate, date: body.date ?? '', fetched_at: new Date(options.now?.() ?? Date.now()).toISOString() };
}

/**
 * USD per EUR. Refreshed at most once a day; when the upstream is unreachable
 * the last cached rate is reused (flagged `stale`) so a sync never loses the
 * Regolo rows over a transient network error.
 */
export async function eurUsdRate(options: FxOptions = {}): Promise<FxRate> {
  const path = fxCachePath(options.cacheDir);
  const now = options.now?.() ?? Date.now();
  const cached = await readCache(path);
  if (cached && now - Date.parse(cached.fetched_at) < (options.maxAgeMs ?? FX_MAX_AGE_MS)) return cached;
  try {
    const fresh = await fetchRate(options);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicWrite(path, JSON.stringify(fresh), 0o600);
    return fresh;
  } catch (error: any) {
    if (cached) {
      options.warn?.(`using cached EUR→USD rate ${cached.rate} from ${cached.date} (${error?.message ?? error})`);
      return { ...cached, stale: true };
    }
    throw new Error(`EUR→USD rate unavailable: ${error?.message ?? error}`);
  }
}
