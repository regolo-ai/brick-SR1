import { describe, expect, it } from 'vitest';
import { opencodeCatalog } from './opencode.js';
import { regoloCatalog } from './regolo.js';
import { openaiCatalog } from './openai.js';
import { openaiCodexCatalog } from './openai-codex.js';
import { anthropicCatalog } from './anthropic.js';
import { claudeApiCatalog } from './claude-api.js';
import { claudeCodeCatalog } from './claude-code.js';
import { openrouterCatalog } from './openrouter.js';

// The public Brick catalog the OpenCode entry must mirror.
const upstreamCatalogs = [
  regoloCatalog,
  openaiCatalog,
  openaiCodexCatalog,
  anthropicCatalog,
  claudeApiCatalog,
  claudeCodeCatalog,
  openrouterCatalog,
];

describe('opencode catalog entry', () => {
  it('exposes a valid provider shape with no credential requirement', () => {
    expect(opencodeCatalog.id).toBe('opencode');
    expect(opencodeCatalog.label).toBeTruthy();
    expect(opencodeCatalog.type).toBe('openai_compatible');
    expect(opencodeCatalog.env_key).toBe('');
    expect(opencodeCatalog.optional).toBe(true);
    expect(opencodeCatalog.models.length).toBeGreaterThan(0);
    expect(opencodeCatalog.multimodal).toEqual({});
  });

  it('points at the loopback router and ends in /v1', () => {
    const url = new URL(opencodeCatalog.base_url);
    expect(url.protocol).toBe('http:');
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(url.hostname);
    expect(opencodeCatalog.base_url.endsWith('/v1')).toBe(true);
  });

  it('advertises the brick router model plus every existing catalog model', () => {
    const ids = opencodeCatalog.models.map((model) => model.id);
    expect(ids).toContain('brick');

    const existing = new Set(upstreamCatalogs.flatMap((catalog) => catalog.models.map((model) => model.id)));
    for (const id of ids) {
      if (id === 'brick') continue;
      expect(existing.has(id), `invented model id: ${id}`).toBe(true);
    }
    for (const id of existing) {
      expect(ids, `missing existing catalog model: ${id}`).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries the fields OpenCode needs for every model', () => {
    for (const model of opencodeCatalog.models) {
      expect(typeof model.id).toBe('string');
      expect(model.id).not.toBe('');
      expect(typeof model.label).toBe('string');
      expect(model.label).not.toBe('');
      expect(typeof model.param_size).toBe('string');
    }
  });
});
