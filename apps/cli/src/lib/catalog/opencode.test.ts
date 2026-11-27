import { describe, expect, it } from 'vitest';
import { catalog } from './index.js';
import { BRICK_ROUTER_MODEL, OPENCODE_DEFAULT_PORT, opencodeCatalog, opencodeCatalogForPort, opencodeModels } from './opencode.js';

const publicModelIds = new Set(
  Object.values(catalog).flatMap((provider) => provider.models.map((model) => model.id)),
);

describe('opencode catalog entry', () => {
  it('has valid id, label, type, base_url and models', () => {
    expect(opencodeCatalog.id).toBe('opencode');
    expect(opencodeCatalog.label).toBeTruthy();
    expect(opencodeCatalog.type).toBe('openai_compatible');
    expect(opencodeCatalog.base_url).toBe(`http://127.0.0.1:${OPENCODE_DEFAULT_PORT}/v1`);
    expect(opencodeCatalog.models.length).toBeGreaterThan(1);
    for (const model of opencodeCatalog.models) {
      expect(model.id).toBeTruthy();
      expect(model.label).toBeTruthy();
      expect(model.param_size).toBeTruthy();
    }
  });

  it('contains the brick router model and every model comes from the public catalog', () => {
    const ids = opencodeCatalog.models.map((model) => model.id);
    expect(ids[0]).toBe(BRICK_ROUTER_MODEL.id);
    expect(ids).toContain('brick');
    expect(publicModelIds.size).toBeGreaterThan(0);
    for (const id of ids) {
      if (id === BRICK_ROUTER_MODEL.id) continue;
      expect(publicModelIds.has(id)).toBe(true);
    }
  });

  it('deduplicates model ids and does not duplicate the router model', () => {
    const ids = opencodeModels().map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === 'brick')).toHaveLength(1);
  });

  it('targets the loopback /v1 endpoint of the requested port', () => {
    const entry = opencodeCatalogForPort(9123);
    expect(entry.base_url).toBe('http://127.0.0.1:9123/v1');
    expect(entry.models.map((model) => model.id)).toEqual(opencodeCatalog.models.map((model) => model.id));
  });
});
