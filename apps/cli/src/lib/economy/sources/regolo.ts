import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWrite } from '../../config/atomic-file.js';

/**
 * Regolo has no machine-readable price feed (its /v1/models endpoint exposes
 * names and a usage_multiplier only), so the public pricing table is the source
 * of truth for models Brick serves through Regolo.
 */
export const REGOLO_PRICING_URL = 'https://regolo.ai/pricing/';
/** A healthy scrape always finds at least the whole model catalogue. */
export const REGOLO_MIN_ROWS = 8;

export interface RegoloPrice { input: number; output: number }

export interface RegoloSourceOptions {
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  warn?: (message: string) => void;
}

interface RegoloCache { fetched_at: string; prices: Record<string, RegoloPrice> }

export function regoloCachePath(cacheDir?: string): string {
  return join(cacheDir ?? join(homedir(), '.brick', 'cache', 'pricing'), 'regolo.json');
}

export class InvalidRegoloPricingError extends Error {}

function euro(value: string): number | undefined {
  const match = value.replace(/\s|\u00a0/g, '').match(/^€?([0-9]+(?:[.,][0-9]+)?)$/);
  if (!match) return undefined;
  const parsed = Number(match[1].replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * The page renders a four-column grid per model: name, €/1M input, €/1M output,
 * plan availability. Parsing those rows is less brittle than the surrounding
 * markup, and any structural change trips the row-count guard below.
 */
export function parseRegoloPricing(html: string): Map<string, RegoloPrice> {
  const rows = new Map<string, RegoloPrice>();
  const rowRe = /grid-template-columns:\s*repeat\(\s*4\s*,\s*minmax\(0,\s*1fr\)\);?">\s*<div[^>]*>([^<]*)<\/div>\s*<div[^>]*>([^<]*)<\/div>\s*<div[^>]*>([^<]*)<\/div>/g;
  for (const row of html.matchAll(rowRe)) {
    const [model, inputRaw, outputRaw] = [row[1].trim(), row[2].trim(), row[3].trim()];
    if (!model || /^model$/i.test(model)) continue;
    const input = euro(inputRaw);
    const output = euro(outputRaw);
    // Header cells ("Input cost per 1M tokens") fail the euro() parse.
    if (input === undefined || output === undefined) continue;
    rows.set(model, { input, output });
  }
  return rows;
}

async function readCache(path: string): Promise<RegoloCache | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as RegoloCache; }
  catch { return null; }
}

export async function fetchRegoloPricing(options: RegoloSourceOptions = {}): Promise<{ prices: Map<string, RegoloPrice>; cached: boolean }> {
  const path = regoloCachePath(options.cacheDir);
  try {
    const response = await (options.fetchImpl ?? fetch)(REGOLO_PRICING_URL, { signal: AbortSignal.timeout(options.timeoutMs ?? 8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const prices = parseRegoloPricing(await response.text());
    if (prices.size < REGOLO_MIN_ROWS) throw new InvalidRegoloPricingError(`only ${prices.size} price rows found (expected at least ${REGOLO_MIN_ROWS})`);
    const cache: RegoloCache = { fetched_at: new Date().toISOString(), prices: Object.fromEntries(prices) };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicWrite(path, JSON.stringify(cache), 0o600);
    return { prices, cached: false };
  } catch (error: any) {
    const cache = await readCache(path);
    if (!cache?.prices) throw new Error(`Regolo pricing unavailable: ${error?.message ?? error}`);
    options.warn?.(`using cached Regolo prices from ${cache.fetched_at} (${error?.message ?? error})`);
    return { prices: new Map(Object.entries(cache.prices)), cached: true };
  }
}
