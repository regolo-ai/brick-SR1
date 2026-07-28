import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ModelCatalogEntry {
  id: string;
  owned_by?: string;
  provider?: string;
  metadata?: Record<string, unknown>;
}

export interface DiscoveryResult {
  models: ModelCatalogEntry[];
  source: 'live' | 'cache';
  cachePath: string;
}

export function normalizeModelsResponse(payload: unknown, provider?: string): ModelCatalogEntry[] {
  const data = (payload as any)?.data;
  if (!Array.isArray(data)) throw new Error('malformed /models response: expected { data: [...] }');
  const seen = new Set<string>();
  const out: ModelCatalogEntry[] = [];
  for (const item of data) {
    const rawId = typeof item === 'string' ? item : item?.id;
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id || seen.has(id)) continue;
    out.push({
      id,
      ...(typeof item?.owned_by === 'string' ? { owned_by: item.owned_by } : {}),
      ...(provider ? { provider } : {}),
      ...(item && typeof item === 'object' ? { metadata: item } : {}),
    });
  }
  return out;
}

export function modelCatalogCachePath(provider: string, cacheDir = join(homedir(), '.brick', 'cache', 'model-catalog')): string {
  return join(cacheDir, `${provider}.json`);
}

export async function discoverModels(
  provider: string,
  baseUrl: string,
  options: { fetchImpl?: typeof fetch; cacheDir?: string; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<DiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cachePath = modelCatalogCachePath(provider, options.cacheDir);
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/models`;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), options.timeoutMs ?? 10_000);
    const response = await fetchImpl(endpoint, { method: 'GET', headers: options.headers, signal: ctl.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const models = normalizeModelsResponse(await response.json(), provider);
    if (!models.length) throw new Error('malformed /models response: no model ids');
    await mkdir(join(cachePath, '..'), { recursive: true });
    await writeFile(cachePath, JSON.stringify({ provider, base_url: baseUrl, models, updated_at: new Date().toISOString() }, null, 2));
    return { models, source: 'live', cachePath };
  } catch (error) {
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8'));
      const models = normalizeModelsResponse({ data: cached.models }, provider);
      if (models.length) return { models, source: 'cache', cachePath };
    } catch { /* no usable cache */ }
    throw new Error(`unable to discover models for ${provider} (${endpoint}) and no valid cache is available`, { cause: error as Error });
  }
}
