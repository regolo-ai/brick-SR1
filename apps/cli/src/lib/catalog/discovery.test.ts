import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { discoverModels, normalizeModelsResponse } from './discovery.js';

describe('OpenAI-compatible model discovery', () => {
  it('deduplicates a live /models response and writes cache', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'brick-models-'));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'glm5.2' }, { id: 'glm5.2' }, { id: 'qwen3.6-27b' }] }), { status: 200 })) as any;
    const result = await discoverModels('regolo-pool-models', 'https://api.regolo.ai/v1/', { cacheDir, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.regolo.ai/v1/models', expect.objectContaining({ method: 'GET' }));
    expect(result.source).toBe('live');
    expect(result.models.map((model) => model.id)).toEqual(['glm5.2', 'qwen3.6-27b']);
    expect(JSON.parse(await readFile(result.cachePath, 'utf8')).models).toHaveLength(2);
  });

  it('falls back to cache when live discovery fails', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'brick-models-'));
    await discoverModels('regolo', 'https://api.regolo.ai/v1', {
      cacheDir,
      fetchImpl: (async () => new Response(JSON.stringify({ data: [{ id: 'glm5.2' }] }), { status: 200 })) as any,
    });
    const result = await discoverModels('regolo', 'https://api.regolo.ai/v1', {
      cacheDir,
      fetchImpl: (async () => { throw new Error('offline'); }) as any,
    });
    expect(result.source).toBe('cache');
    expect(result.models[0].id).toBe('glm5.2');
  });

  it('reports a useful error when neither live data nor cache exists', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'brick-models-'));
    await expect(discoverModels('missing', 'https://example.invalid/v1', {
      cacheDir,
      fetchImpl: (async () => new Response('', { status: 503 })) as any,
    })).rejects.toThrow('/models');
  });

  it('rejects malformed payloads', () => {
    expect(() => normalizeModelsResponse({ models: [] })).toThrow('expected { data: [...] }');
  });
});
