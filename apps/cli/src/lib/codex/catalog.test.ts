import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

import {
  activeBrickContextWindow,
  authenticatedCatalogPath,
  missingCatalogModels,
  preserveRequiredModels,
  readCodexCatalogForSetup,
  withBrickModel,
} from './catalog.js';

describe('withBrickModel', () => {
  it('preserves every Codex model and appends only the virtual Brick model', () => {
    const source = {
      fetched_at: '2026-08-20T00:00:00Z',
      client_version: '0.148.0',
      models: [
        { slug: 'gpt-current', display_name: 'Current', priority: 1, visibility: 'list', schema_field: true },
        { slug: 'codex-review', display_name: 'Review', priority: 7, visibility: 'list', schema_field: true },
      ],
    };

    const result = withBrickModel(source, 128000);

    expect(result.models.map((model) => model.slug)).toEqual(['gpt-current', 'codex-review', 'brick']);
    expect(result.models[0]).toEqual(source.models[0]);
    expect(result.models[1]).toEqual(source.models[1]);
    expect(result.models[2]).toMatchObject({
      slug: 'brick',
      display_name: 'Brick Router',
      visibility: 'list',
      priority: 8,
      schema_field: true,
      context_window: 128000,
      max_context_window: 128000,
      effective_context_window_percent: 100,
    });
    expect(source.models).toHaveLength(2);
  });

  it('does not leak backend models or duplicate an existing Brick entry', () => {
    const result = withBrickModel({
      models: [
        { slug: 'gpt-current', priority: 1 },
        { slug: 'brick', priority: 2 },
      ],
    }, 64000);

    expect(result.models.map((model) => model.slug)).toEqual(['gpt-current', 'brick']);
  });

  it('rejects an empty cache instead of substituting a hardcoded catalog', () => {
    expect(() => withBrickModel({ models: [] }, 128000)).toThrow('contains no models');
  });

  it('rejects an unknown pool context instead of inheriting the first official model', () => {
    expect(() => withBrickModel({ models: [{ slug: 'official', context_window: 999999 }] }, 0)).toThrow('context_window_size');
  });

  it('uses the minimum active pool context and rejects unknown active models', () => {
		const config = { skill_router: { models: [{ model: 'a' }, { model: 'b' }], active_models: ['a', 'b'] }, model_config: { a: { context_window_size: 128000 }, b: { context_window_size: 64000 } } };
		expect(activeBrickContextWindow(config)).toBe(64000);
		expect(() => activeBrickContextWindow({ ...config, model_config: { a: config.model_config.a } })).toThrow('context_window_size');
	});
});

describe('authenticated catalog source', () => {
  let home: string;
  let codex: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'brick-catalog-source-'));
    codex = join(home, 'codex-home');
    process.env.BRICK_HOME = home;
    process.env.CODEX_HOME = codex;
    await mkdir(codex, { recursive: true });
  });

  afterAll(async () => {
    delete process.env.BRICK_HOME;
    delete process.env.CODEX_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it('reads Codex own cache when model_catalog_json points at the managed catalog', async () => {
    const { paths } = await import('../config/paths.js');
    await writeFile(join(codex, 'config.toml'), `model_catalog_json = "${paths('codex').codexCatalog}"\n`);
    expect(authenticatedCatalogPath()).toBe(join(codex, 'models_cache.json'));
  });

  it('honours a user-configured catalog path', async () => {
    await writeFile(join(codex, 'config.toml'), 'model_catalog_json = "/tmp/other-catalog.json"\n');
    expect(authenticatedCatalogPath()).toBe('/tmp/other-catalog.json');
  });

  it('reports active pool models absent from the authenticated catalog', () => {
    const catalog = { models: [{ slug: 'gpt-6-luna' }, { slug: 'brick' }] };
    const config = {
      skill_router: {
        models: [{ model: 'gpt-6-luna' }, { model: 'gpt-6.1-terra' }],
        active_models: ['gpt-6-luna', 'gpt-6.1-terra'],
      },
    };
    expect(missingCatalogModels(config, catalog as any)).toEqual(['gpt-6.1-terra']);
    expect(missingCatalogModels(config, { models: [] } as any)).toEqual([]);
  });

  it('preserves active pool models the cache momentarily omits', () => {
    const source = { models: [{ slug: 'gpt-6-luna', priority: 1 }] };
    const previous = { models: [{ slug: 'gpt-6-luna' }, { slug: 'gpt-6.1-terra', priority: 3 }] };
    const merged = preserveRequiredModels(source as any, previous as any, ['gpt-6.1-terra']);
    expect(merged.models.map((model: any) => model.slug)).toEqual(['gpt-6-luna', 'gpt-6.1-terra']);
    expect(preserveRequiredModels(source as any, previous as any, ['gpt-6-luna'])).toBe(source);
  });
});

describe('readCodexCatalogForSetup stale-cache handling', () => {
  it('merges the Codex client catalog when the cache omits a required pool model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'brick-catalog-stale-'));
    const prevHome = process.env.BRICK_HOME;
    const prevCodex = process.env.CODEX_HOME;
    process.env.BRICK_HOME = dir;
    process.env.CODEX_HOME = join(dir, 'codex-home');
    await mkdir(process.env.CODEX_HOME, { recursive: true });
    // Cache lists only old models; the client still advertises the 6.x pool.
    await writeFile(join(process.env.CODEX_HOME, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-5.6-terra' }] }));
    const live = { models: [{ slug: 'gpt-5.6-terra' }, { slug: 'gpt-6-luna' }, { slug: 'gpt-6.1-terra' }] };
    execaMock.mockResolvedValue({ stdout: JSON.stringify(live) });
    try {
      const catalog = await readCodexCatalogForSetup(['gpt-6-luna', 'gpt-6.1-terra']);
      expect(catalog.models.map((m) => m.slug)).toEqual(['gpt-5.6-terra', 'gpt-6-luna', 'gpt-6.1-terra']);
      expect(execaMock).toHaveBeenCalledWith('codex', ['debug', 'models'], expect.anything());
    } finally {
      execaMock.mockReset();
      if (prevHome === undefined) delete process.env.BRICK_HOME; else process.env.BRICK_HOME = prevHome;
      if (prevCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodex;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
