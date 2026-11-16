import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWrite } from '../../config/atomic-file.js';

/**
 * OpenRouter's model catalogue is public: the endpoint answers without any
 * Authorization header, so every Brick install can read prices with no key.
 */
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export interface OpenRouterPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read tokens, when the provider publishes one. */
  cached_input?: number;
}

export interface OpenRouterSourceOptions {
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  warn?: (message: string) => void;
}

interface OpenRouterCache { fetched_at: string; prices: Record<string, OpenRouterPrice> }

export function openRouterCachePath(cacheDir?: string): string {
  return join(cacheDir ?? join(homedir(), '.brick', 'cache', 'pricing'), 'openrouter.json');
}

/**
 * Explicit aliases for pool ids whose OpenRouter slug cannot be derived from the
 * model name alone. Extend this when a profile starts using a new family.
 */
export const OPENROUTER_ALIASES: Record<string, string> = {
  'gpt-6.1-terra': 'openai/gpt-6.1-terra',
  'gpt-6.1-sol': 'openai/gpt-6.1-sol',
  'gpt-6-luna': 'openai/gpt-6-luna',
  'gpt-5.6-sol': 'openai/gpt-5.6-sol',
  'gpt-5.6-terra': 'openai/gpt-5.6-terra',
  'gpt-5.6-luna': 'openai/gpt-5.6-luna',
  'gpt-oss-120b': 'openai/gpt-oss-120b',
  'gpt-oss-20b': 'openai/gpt-oss-20b',
};

function perMillion(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0) return undefined;
  // OpenRouter quotes USD per token; round to avoid 1e-17 noise leaking into YAML.
  return Math.round(parsed * 1_000_000 * 1e6) / 1e6;
}

/** Normalise the public catalogue into USD per 1M tokens, keyed by slug. */
export function parseOpenRouterModels(body: unknown): Map<string, OpenRouterPrice> {
  const data = (body as { data?: unknown })?.data;
  const prices = new Map<string, OpenRouterPrice>();
  if (!Array.isArray(data)) return prices;
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const model = raw as { id?: unknown; pricing?: Record<string, unknown> };
    if (typeof model.id !== 'string' || model.id === '') continue;
    const input = perMillion(model.pricing?.prompt);
    const output = perMillion(model.pricing?.completion);
    if (input === undefined || output === undefined) continue;
    prices.set(model.id, { input, output, cached_input: perMillion(model.pricing?.input_cache_read) });
  }
  return prices;
}

/**
 * Map a profile pool id ("gpt-6.1-terra") onto an OpenRouter slug
 * ("openai/gpt-6.1-terra"). Ambiguous suffix matches are rejected so we never
 * silently price a model with the wrong number.
 */
export function resolveOpenRouterId(model: string, available: Iterable<string>): string | undefined {
  const ids = [...available];
  const alias = OPENROUTER_ALIASES[model];
  if (alias && ids.includes(alias)) return alias;
  if (ids.includes(model)) return model;
  const suffix = ids.filter((id) => id.split('/').pop() === model || id.split('/').pop()?.split(':')[0] === model);
  return suffix.length === 1 ? suffix[0] : undefined;
}

async function readCache(path: string): Promise<OpenRouterCache | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as OpenRouterCache; }
  catch { return null; }
}

export async function fetchOpenRouterPricing(options: OpenRouterSourceOptions = {}): Promise<{ prices: Map<string, OpenRouterPrice>; cached: boolean }> {
  const path = openRouterCachePath(options.cacheDir);
  try {
    const response = await (options.fetchImpl ?? fetch)(OPENROUTER_MODELS_URL, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
      headers: { 'User-Agent': 'brick-pricing/1.0' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const prices = parseOpenRouterModels(await response.json());
    if (prices.size === 0) throw new Error('catalogue contained no priced models');
    const cache: OpenRouterCache = { fetched_at: new Date().toISOString(), prices: Object.fromEntries(prices) };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicWrite(path, JSON.stringify(cache), 0o600);
    return { prices, cached: false };
  } catch (error: any) {
    const cache = await readCache(path);
    if (!cache?.prices) throw new Error(`OpenRouter pricing unavailable: ${error?.message ?? error}`);
    options.warn?.(`using cached OpenRouter prices from ${cache.fetched_at} (${error?.message ?? error})`);
    return { prices: new Map(Object.entries(cache.prices)), cached: true };
  }
}
