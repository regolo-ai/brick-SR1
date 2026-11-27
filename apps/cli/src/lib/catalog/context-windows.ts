import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';

export const CONTEXT_CACHE_VERSION = 1;
export const CONTEXT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const REGOLO_MODEL_INFO_URL = 'https://api.regolo.ai/v1/model/info';

export type ContextDiscoveryState = 'live' | 'cache' | 'error';

export interface ContextWindowResolution {
  model: string;
  sourceModel: string;
  provider: string;
  source: string;
  totalTokens?: number;
  maxOutputTokens?: number;
  maxInputTokens?: number;
  verifiedAt: string;
  state: ContextDiscoveryState;
  error?: string;
}

export interface ContextDiscoveryOptions {
  fetchImpl?: typeof fetch;
  runCodex?: () => Promise<string>;
  cacheDir?: string;
  timeoutMs?: number;
  now?: Date;
  env?: Record<string, string | undefined>;
}

interface ModelRequest {
  model: string;
  provider: string;
  sourceModel: string;
  sourceKey: string;
  source: string;
  apiKeyEnv?: string;
  manual?: number;
}

interface CachedSource {
  version: number;
  source: string;
  verified_at: string;
  models: Array<Omit<ContextWindowResolution, 'state' | 'verifiedAt'>>;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${field} must be a positive integer`);
  return Number(value);
}

function sourceCachePath(sourceKey: string, cacheDir: string): string {
  const digest = createHash('sha256').update(sourceKey).digest('hex').slice(0, 24);
  return join(cacheDir, `${digest}.json`);
}

export function contextCacheDir(): string {
  return join(process.env.BRICK_HOME ?? join(homedir(), '.brick'), 'cache', 'model-context');
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function getJson(url: string, options: ContextDiscoveryOptions, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: 'GET',
    headers: { Accept: 'application/json', ...headers },
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (response.status >= 300 && response.status < 400) throw new Error(`redirect refused (HTTP ${response.status})`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Map only the documented Anthropic spelling transform. */
export function openRouterModelId(provider: string, model: string): string {
  if (provider === 'openrouter') {
    if (!/^[^/]+\/[^/]+$/.test(model)) throw new Error(`OpenRouter model '${model}' must be a qualified id`);
    return model;
  }
  if (provider === 'openai') {
    if (model.includes('/')) throw new Error(`OpenAI model '${model}' must be unqualified`);
    return `openai/${model}`;
  }
  if (['anthropic', 'claude-api', 'claude-code'].includes(provider)) {
    if (model.includes('/')) throw new Error(`Claude model '${model}' must be unqualified`);
    const dotted = model.match(/^(claude-(?:haiku|sonnet|opus|fable))-(\d+)-(\d+)$/);
    if (dotted) return `anthropic/${dotted[1]}-${dotted[2]}.${dotted[3]}`;
    if (/^claude-(?:haiku|sonnet|opus|fable)-\d+\.\d+$/.test(model)) return `anthropic/${model}`;
    throw new Error(`Claude model '${model}' has no exact OpenRouter mapping`);
  }
  throw new Error(`provider '${provider}' does not use OpenRouter context discovery`);
}

function uniqueRecord(items: unknown[], id: string, identify: (item: any) => unknown, label: string): any {
  const matches = items.filter((item: any) => identify(item) === id);
  if (matches.length === 0) throw new Error(`${label} model '${id}' is absent`);
  if (matches.length > 1) throw new Error(`${label} model '${id}' is ambiguous`);
  return matches[0];
}

export function parseOpenRouterModel(payload: unknown, id: string): { totalTokens: number; maxOutputTokens: number; maxInputTokens: number } {
  const data = (payload as any)?.data;
  if (!Array.isArray(data)) throw new Error('OpenRouter response must contain a data array');
  const item = uniqueRecord(data, id, (entry) => entry?.id, 'OpenRouter');
  const advertised = positiveInteger(item.context_length, 'context_length');
  const provider = positiveInteger(item.top_provider?.context_length, 'top_provider.context_length');
  const output = positiveInteger(item.top_provider?.max_completion_tokens, 'top_provider.max_completion_tokens');
  const total = Math.min(advertised, provider);
  if (output >= total) throw new Error(`max_completion_tokens must be smaller than context_length for '${id}'`);
  return { totalTokens: total, maxOutputTokens: output, maxInputTokens: total - output };
}

function regoloItems(payload: any): unknown[] {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.model_info)) return payload.model_info;
  throw new Error('Regolo response must contain a data array');
}

export function parseRegoloModel(payload: unknown, id: string): { totalTokens?: number; maxOutputTokens?: number; maxInputTokens: number } {
  const item = uniqueRecord(regoloItems(payload), id, (entry) => entry?.model_name ?? entry?.model_group ?? entry?.id, 'Regolo');
  const info = item?.model_info && typeof item.model_info === 'object' ? item.model_info : item;
  const input = positiveInteger(info.max_input_tokens, 'model_info.max_input_tokens');
  const total = info.max_tokens == null ? undefined : positiveInteger(info.max_tokens, 'model_info.max_tokens');
  const output = info.max_output_tokens == null ? undefined : positiveInteger(info.max_output_tokens, 'model_info.max_output_tokens');
  if (total != null && input > total) throw new Error(`max_input_tokens exceeds max_tokens for '${id}'`);
  return { ...(total == null ? {} : { totalTokens: total }), ...(output == null ? {} : { maxOutputTokens: output }), maxInputTokens: input };
}

export function parseCodexModel(payload: unknown, id: string): { totalTokens: number; maxInputTokens: number } {
  const models = (payload as any)?.models;
  if (!Array.isArray(models)) throw new Error('codex debug models response must contain a models array');
  const item = uniqueRecord(models, id, (entry) => entry?.slug, 'Codex');
  const total = positiveInteger(item.context_window, 'context_window');
  const percent = positiveInteger(item.effective_context_window_percent, 'effective_context_window_percent');
  if (percent > 100) throw new Error('effective_context_window_percent must not exceed 100');
  const input = Math.floor(total * percent / 100);
  if (input <= 0) throw new Error(`effective context window is invalid for '${id}'`);
  return { totalTokens: total, maxInputTokens: input };
}

function parseCustomModel(payload: unknown, id: string): { totalTokens?: number; maxOutputTokens?: number; maxInputTokens: number } {
  const data = (payload as any)?.data;
  if (!Array.isArray(data)) throw new Error('custom /models response must contain a data array');
  const item = uniqueRecord(data, id, (entry) => entry?.id, 'custom provider');
  const info = item?.model_info && typeof item.model_info === 'object' ? item.model_info : item;
  if (info.max_input_tokens != null) return { maxInputTokens: positiveInteger(info.max_input_tokens, 'max_input_tokens') };
  if (info.context_window != null && info.max_output_tokens != null) {
    const total = positiveInteger(info.context_window, 'context_window');
    const output = positiveInteger(info.max_output_tokens, 'max_output_tokens');
    if (output >= total) throw new Error('max_output_tokens must be smaller than context_window');
    return { totalTokens: total, maxOutputTokens: output, maxInputTokens: total - output };
  }
  throw new Error(`custom provider model '${id}' has no recognized explicit input limit`);
}

function requestsForConfig(config: any): ModelRequest[] {
  const configured = Array.isArray(config?.skill_router?.models) && config.skill_router.models.length
    ? config.skill_router.models.map((entry: any) => entry?.model)
    : (typeof config?.default_model === 'string' && config.default_model ? [config.default_model] : []);
  const active = Array.isArray(config?.skill_router?.active_models) && config.skill_router.active_models.length
    ? config.skill_router.active_models : configured;
  if (!active.length) throw new Error('The active routing pool is empty');
  return [...new Set<string>(active)].map((model) => {
    const mc = config?.model_config?.[model];
    const upstreamModel = typeof mc?.upstream_model === 'string' && mc.upstream_model ? mc.upstream_model : model;
    const endpointNames = mc?.preferred_endpoints;
    if (!Array.isArray(endpointNames) || endpointNames.length !== 1) throw new Error(`Model '${model}' needs exactly one authoritative endpoint`);
    const endpoint = config?.provider_endpoints?.find((entry: any) => entry?.name === endpointNames[0]);
    if (!endpoint) throw new Error(`Model '${model}' references unknown endpoint '${endpointNames[0]}'`);
    const provider = endpoint.provider_profile;
    const profile = config?.provider_profiles?.[provider] ?? config?.providers?.[provider];
    if (!profile) throw new Error(`Model '${model}' references unknown provider '${provider}'`);
    if (provider === 'regolo') return { model, provider, sourceModel: upstreamModel, sourceKey: 'regolo', source: REGOLO_MODEL_INFO_URL };
    if (provider === 'openai-codex') return { model, provider, sourceModel: upstreamModel, sourceKey: 'openai-codex', source: 'codex debug models' };
    if (['openai', 'anthropic', 'claude-api', 'claude-code', 'openrouter'].includes(provider)) {
      return { model, provider, sourceModel: openRouterModelId(provider, upstreamModel), sourceKey: 'openrouter', source: OPENROUTER_MODELS_URL };
    }
    const baseUrl = String(profile.base_url ?? '').replace(/\/+$/, '');
    return {
      model, provider, sourceModel: upstreamModel, sourceKey: `custom:${provider}:${baseUrl}`, source: `${baseUrl}/models`,
      apiKeyEnv: profile.api_key_env ?? `${String(provider).toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_API_KEY`,
      manual: Number.isInteger(mc.context_window_size) && mc.context_window_size > 0 ? mc.context_window_size : undefined,
    };
  });
}

async function liveSource(requests: ModelRequest[], options: ContextDiscoveryOptions, now: Date): Promise<ContextWindowResolution[]> {
  const first = requests[0];
  let payload: unknown;
  if (first.sourceKey === 'regolo') {
    const key = options.env?.REGOLO_API_KEY;
    if (!key?.trim()) throw new Error('REGOLO_API_KEY is required for context discovery');
    payload = await getJson(REGOLO_MODEL_INFO_URL, options, { Authorization: `Bearer ${key}` });
  } else if (first.sourceKey === 'openrouter') {
    payload = await getJson(OPENROUTER_MODELS_URL, options);
  } else if (first.sourceKey === 'openai-codex') {
    const stdout = options.runCodex ? await options.runCodex() : (await execa('codex', ['debug', 'models'], { reject: true, timeout: options.timeoutMs ?? 10_000 })).stdout;
    try { payload = JSON.parse(stdout); } catch { throw new Error('codex debug models returned invalid JSON'); }
  } else {
    const headers: Record<string, string> = {};
    const key = first.apiKeyEnv ? options.env?.[first.apiKeyEnv] : undefined;
    if (key?.trim()) headers.Authorization = `Bearer ${key}`;
    payload = await getJson(first.source, options, headers);
  }
  return requests.map((request) => {
    const values = request.sourceKey === 'regolo' ? parseRegoloModel(payload, request.sourceModel)
      : request.sourceKey === 'openrouter' ? parseOpenRouterModel(payload, request.sourceModel)
      : request.sourceKey === 'openai-codex' ? parseCodexModel(payload, request.sourceModel)
      : parseCustomModel(payload, request.sourceModel);
    return { model: request.model, sourceModel: request.sourceModel, provider: request.provider, source: request.source, ...values, verifiedAt: now.toISOString(), state: 'live' as const };
  });
}

async function cachedSource(requests: ModelRequest[], options: ContextDiscoveryOptions, now: Date): Promise<ContextWindowResolution[]> {
  const path = sourceCachePath(requests[0].sourceKey, options.cacheDir ?? contextCacheDir());
  const cached = JSON.parse(await readFile(path, 'utf8')) as CachedSource;
  if (cached.version !== CONTEXT_CACHE_VERSION || !Array.isArray(cached.models)) throw new Error('cache version or shape is invalid');
  const age = now.getTime() - new Date(cached.verified_at).getTime();
  if (!Number.isFinite(age) || age < 0 || age > CONTEXT_CACHE_TTL_MS) throw new Error('cache is older than 24 hours');
  return requests.map((request) => {
    const matches = cached.models.filter((entry) => entry.model === request.model && entry.provider === request.provider && entry.sourceModel === request.sourceModel);
    if (matches.length !== 1) throw new Error(`cache has no unique entry for '${request.model}'`);
    const entry = matches[0];
    positiveInteger(entry.maxInputTokens, 'cached maxInputTokens');
    if (entry.totalTokens != null) positiveInteger(entry.totalTokens, 'cached totalTokens');
    if (entry.maxOutputTokens != null) positiveInteger(entry.maxOutputTokens, 'cached maxOutputTokens');
    if (entry.source !== request.source) throw new Error(`cache source mismatch for '${request.model}'`);
    return { ...entry, verifiedAt: cached.verified_at, state: 'cache' };
  });
}

export async function resolveContextWindows(config: any, options: ContextDiscoveryOptions = {}): Promise<ContextWindowResolution[]> {
  const now = options.now ?? new Date();
  const groups = new Map<string, ModelRequest[]>();
  for (const request of requestsForConfig(config)) groups.set(request.sourceKey, [...(groups.get(request.sourceKey) ?? []), request]);
  const all: ContextWindowResolution[] = [];
  for (const requests of groups.values()) {
    try {
      const live = await liveSource(requests, options, now);
      const cache: CachedSource = {
        version: CONTEXT_CACHE_VERSION,
        source: requests[0].source,
        verified_at: now.toISOString(),
        models: live.map(({ state: _state, verifiedAt: _verifiedAt, ...entry }) => entry),
      };
      await atomicWriteJson(sourceCachePath(requests[0].sourceKey, options.cacheDir ?? contextCacheDir()), cache);
      all.push(...live);
      continue;
    } catch (liveError: any) {
      try { all.push(...await cachedSource(requests, options, now)); continue; } catch { /* use manual custom values or report the live error */ }
      for (const request of requests) {
        if (request.sourceKey.startsWith('custom:') && request.manual) {
          all.push({ model: request.model, sourceModel: request.sourceModel, provider: request.provider, source: 'manual configuration', maxInputTokens: request.manual, verifiedAt: now.toISOString(), state: 'live' });
        } else {
          all.push({ model: request.model, sourceModel: request.sourceModel, provider: request.provider, source: request.source, verifiedAt: now.toISOString(), state: 'error', error: liveError?.message ?? String(liveError) });
        }
      }
    }
  }
  return all;
}

export function assertVerifiedContextWindows(results: ContextWindowResolution[]): void {
  const failures = results.filter((result) => result.state === 'error' || !result.maxInputTokens);
  if (failures.length) throw new Error(`Context discovery failed: ${failures.map((item) => `${item.model}: ${item.error ?? 'unverified limit'}`).join('; ')}`);
}

export async function writeContextDiscoverySnapshot(profile: string, results: ContextWindowResolution[], cacheDir = contextCacheDir()): Promise<string> {
  const path = join(cacheDir, `profile-${createHash('sha256').update(profile).digest('hex').slice(0, 24)}.json`);
  await atomicWriteJson(path, { version: CONTEXT_CACHE_VERSION, profile, updated_at: new Date().toISOString(), results });
  return path;
}

export async function readContextDiscoverySnapshot(profile: string, cacheDir = contextCacheDir()): Promise<ContextWindowResolution[]> {
  const path = join(cacheDir, `profile-${createHash('sha256').update(profile).digest('hex').slice(0, 24)}.json`);
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (parsed?.version !== CONTEXT_CACHE_VERSION || parsed?.profile !== profile || !Array.isArray(parsed.results)) throw new Error('invalid context discovery snapshot');
  return parsed.results;
}
