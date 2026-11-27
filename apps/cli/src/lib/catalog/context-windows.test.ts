import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import {
  CONTEXT_CACHE_TTL_MS,
  openRouterModelId,
  parseCodexModel,
  parseOpenRouterModel,
  parseRegoloModel,
  resolveContextWindows,
} from './context-windows.js';

vi.mock('execa', () => ({ execa: vi.fn() }));

function config(provider: string, model: string, contextWindow?: number): any {
  return {
    provider_profiles: { [provider]: { type: 'openai_compatible', base_url: provider === 'custom' ? 'https://custom.invalid/v1' : 'https://unused.invalid' } },
    provider_endpoints: [{ name: 'endpoint', provider_profile: provider }],
    model_config: { [model]: { preferred_endpoints: ['endpoint'], ...(contextWindow ? { context_window_size: contextWindow } : {}) } },
    skill_router: { models: [{ model }], active_models: [model] },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('provider context parsing', () => {
  it('normalizes OpenRouter total minus output and uses the smaller provider context', () => {
    const payload = { data: [{ id: 'openai/gpt-x', context_length: 200_000, top_provider: { context_length: 180_000, max_completion_tokens: 20_000 } }] };
    expect(parseOpenRouterModel(payload, 'openai/gpt-x')).toEqual({ totalTokens: 180_000, maxOutputTokens: 20_000, maxInputTokens: 160_000 });
  });

  it('accepts Regolo model_info max_input_tokens without deriving a value', () => {
    const payload = { data: [{ model_name: 'qwen', model_info: { max_input_tokens: 123_456, max_output_tokens: 10_000 } }] };
    expect(parseRegoloModel(payload, 'qwen')).toEqual({ maxOutputTokens: 10_000, maxInputTokens: 123_456 });
  });

  it('applies the Codex effective percentage exactly once', () => {
    const payload = { models: [{ slug: 'gpt-x', context_window: 200_000, effective_context_window_percent: 95 }] };
    expect(parseCodexModel(payload, 'gpt-x')).toEqual({ totalTokens: 200_000, maxInputTokens: 190_000 });
  });

  it('maps only exact supported Claude spellings', () => {
    expect(openRouterModelId('claude-code', 'claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4.6');
    expect(openRouterModelId('anthropic', 'claude-sonnet-4.6')).toBe('anthropic/claude-sonnet-4.6');
    expect(() => openRouterModelId('anthropic', 'claude-3-5-sonnet')).toThrow('no exact OpenRouter mapping');
  });

  it('rejects absent, duplicate, null, and inconsistent fields', () => {
    expect(() => parseOpenRouterModel({ data: [] }, 'openai/a')).toThrow('absent');
    expect(() => parseOpenRouterModel({ data: [{ id: 'openai/a' }, { id: 'openai/a' }] }, 'openai/a')).toThrow('ambiguous');
    expect(() => parseOpenRouterModel({ data: [{ id: 'openai/a', context_length: null, top_provider: {} }] }, 'openai/a')).toThrow('positive integer');
    expect(() => parseOpenRouterModel({ data: [{ id: 'openai/a', context_length: 100, top_provider: { context_length: 100, max_completion_tokens: 100 } }] }, 'openai/a')).toThrow('smaller');
  });
});

describe('context discovery sources and cache', () => {
  it('uses separate headers and never sends provider credentials to OpenRouter', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
      expect(init?.redirect).toBe('manual');
      return jsonResponse({ data: [{ id: 'openai/gpt-x', context_length: 100_000, top_provider: { context_length: 90_000, max_completion_tokens: 10_000 } }] });
    }) as unknown as typeof fetch;
    const cacheDir = await mkdtemp(join(tmpdir(), 'brick-context-'));
    const results = await resolveContextWindows(config('openai', 'gpt-x'), { fetchImpl, cacheDir, env: { OPENAI_API_KEY: 'must-not-leak', REGOLO_API_KEY: 'also-private' } });
    expect(results[0]).toMatchObject({ sourceModel: 'openai/gpt-x', maxInputTokens: 80_000, state: 'live' });
    const files = (await import('node:fs/promises')).readdir(cacheDir);
    for (const name of await files) expect((await stat(join(cacheDir, name))).mode & 0o777).toBe(0o600);
  });

  it('runs the official Codex catalog command through the injected runner', async () => {
    const runCodex = vi.fn(async () => JSON.stringify({ models: [{ slug: 'gpt-x', context_window: 100_000, effective_context_window_percent: 95 }] }));
    const results = await resolveContextWindows(config('openai-codex', 'gpt-x'), { runCodex, cacheDir: await mkdtemp(join(tmpdir(), 'brick-context-')) });
    expect(runCodex).toHaveBeenCalledOnce();
    expect(results[0]).toMatchObject({ maxInputTokens: 95_000, state: 'live', source: 'codex debug models' });
  });

  it('invokes only the non-inference Codex catalog command', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: JSON.stringify({ models: [{ slug: 'gpt-x', context_window: 100_000, effective_context_window_percent: 95 }] }) } as any);
    await resolveContextWindows(config('openai-codex', 'gpt-x'), { cacheDir: await mkdtemp(join(tmpdir(), 'brick-context-')), timeoutMs: 1234 });
    expect(execa).toHaveBeenCalledWith('codex', ['debug', 'models'], { reject: true, timeout: 1234 });
  });

  it('sends the Regolo key only to the production model-info endpoint and never caches it', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'brick-context-'));
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.regolo.ai/v1/model/info');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer regolo-secret');
      return jsonResponse({ data: [{ model_name: 'qwen', model_info: { max_input_tokens: 120_000 } }] });
    }) as unknown as typeof fetch;
    await resolveContextWindows(config('regolo', 'qwen'), { fetchImpl, cacheDir, env: { REGOLO_API_KEY: 'regolo-secret' } });
    const names = await (await import('node:fs/promises')).readdir(cacheDir);
    expect(await readFile(join(cacheDir, names[0]), 'utf8')).not.toContain('regolo-secret');
  });

  it('falls back through the exact 24-hour boundary and rejects older cache', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'brick-context-'));
    const now = new Date('2026-01-02T00:00:00.000Z');
    const goodFetch = vi.fn(async () => jsonResponse({ data: [{ id: 'openai/gpt-x', context_length: 100_000, top_provider: { context_length: 100_000, max_completion_tokens: 10_000 } }] })) as unknown as typeof fetch;
    await resolveContextWindows(config('openai', 'gpt-x'), { fetchImpl: goodFetch, cacheDir, now: new Date(now.getTime() - CONTEXT_CACHE_TTL_MS) });
    const failedFetch = vi.fn(async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
    expect((await resolveContextWindows(config('openai', 'gpt-x'), { fetchImpl: failedFetch, cacheDir, now }))[0].state).toBe('cache');
    expect((await resolveContextWindows(config('openai', 'gpt-x'), { fetchImpl: failedFetch, cacheDir, now: new Date(now.getTime() + 1) }))[0]).toMatchObject({ state: 'error', error: 'timeout' });
  });

  it('enforces the configured request timeout', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true });
    })) as unknown as typeof fetch;
    const results = await resolveContextWindows(config('openai', 'gpt-x'), { fetchImpl, timeoutMs: 1, cacheDir: await mkdtemp(join(tmpdir(), 'brick-context-')) });
    expect(results[0]).toMatchObject({ state: 'error', error: 'aborted by timeout' });
  });

  it('rejects corrupt cache', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'brick-context-'));
    const goodFetch = vi.fn(async () => jsonResponse({ data: [{ id: 'openai/gpt-x', context_length: 100_000, top_provider: { context_length: 100_000, max_completion_tokens: 10_000 } }] })) as unknown as typeof fetch;
    await resolveContextWindows(config('openai', 'gpt-x'), { fetchImpl: goodFetch, cacheDir });
    const names = await (await import('node:fs/promises')).readdir(cacheDir);
    await writeFile(join(cacheDir, names[0]), '{broken');
    const failedFetch = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect((await resolveContextWindows(config('openai', 'gpt-x'), { fetchImpl: failedFetch, cacheDir }))[0]).toMatchObject({ state: 'error', error: 'offline' });
  });

  it('permits a custom provider manual fallback', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'brick-context-'));
    const failedFetch = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const results = await resolveContextWindows(config('custom', 'private-model', 64_000), { fetchImpl: failedFetch, cacheDir });
    expect(results[0]).toMatchObject({ source: 'manual configuration', maxInputTokens: 64_000, state: 'live' });
  });

  it('writes valid JSON under concurrent refreshes', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'brick-context-'));
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ model_name: 'qwen', model_info: { max_input_tokens: 120_000 } }] })) as unknown as typeof fetch;
    await Promise.all(Array.from({ length: 8 }, () => resolveContextWindows(config('regolo', 'qwen'), { fetchImpl, cacheDir, env: { REGOLO_API_KEY: 'secret' } })));
    const names = await (await import('node:fs/promises')).readdir(cacheDir);
    expect(names).toHaveLength(1);
    const cached = await readFile(join(cacheDir, names[0]), 'utf8');
    expect(() => JSON.parse(cached)).not.toThrow();
  });
});
