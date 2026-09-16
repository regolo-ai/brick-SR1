import { describe, expect, it } from 'vitest';
import { CACHE_ROUTING_OPTIONS, addModelAtomic, activeModels, editThinkingGlobal, hasPendingEnvChanges, normalizeRoutingInvariants, removeModelAtomic } from '../config/editor.js';
import { catalog } from '../catalog/index.js';

function config(): any {
  return {
    default_model: 'glm5.2',
    model_config: { 'glm5.2': { preferred_endpoints: ['regolo'] } },
    decisions: [],
    skill_router: {
      enabled: true,
      active_models: ['glm5.2'],
      models: [{ model: 'glm5.2', skill_vector: [0.6, 0.6, 0.6, 0.6, 0.6, 0.6] }],
    },
    anthropic_passthrough: { fixed_model: 'glm5.2', model_map: { easy: 'glm5.2' } },
    brick: { enabled: true, fixed_model: 'glm5.2' },
  };
}

describe('unified settings model invariants', () => {
  it('treats a pending API-key update as a settings change', async () => {
    const readValue = async (_path: string, key: string) => key === 'REGOLO_API_KEY' ? 'old-key' : null;

    await expect(hasPendingEnvChanges('/profile/.env', { REGOLO_API_KEY: 'new-key' }, readValue)).resolves.toBe(true);
    await expect(hasPendingEnvChanges('/profile/.env', { REGOLO_API_KEY: 'old-key' }, readValue)).resolves.toBe(false);
  });

  it('offers only the three supported cache-aware routing modes with explanations', () => {
    expect(CACHE_ROUTING_OPTIONS.map((option) => option.value)).toEqual(['off', 'sticky', 'smartsqueeze']);
    expect(CACHE_ROUTING_OPTIONS.every((option) => /\(.+\)/.test(option.label))).toBe(true);
  });

  it('returns to the Thinking model submenu after editing one model', async () => {
    const cfg = config();
    const picks = ['glm5.2', '__back__'];
    const menus: Array<Array<{ value: string; label: string }>> = [];
    const edited: string[] = [];

    const changed = await editThinkingGlobal(
      cfg,
      async (_message, choices) => {
        menus.push(choices);
        return picks.shift() ?? null;
      },
      async (_config, model) => {
        edited.push(model);
        return true;
      },
    );

    expect(changed).toBe(true);
    expect(edited).toEqual(['glm5.2']);
    expect(menus).toHaveLength(2);
    expect(menus[1].at(-1)).toEqual({ value: '__back__', label: '← back' });
  });

  it('adds one model to multiple endpoints without duplicating the pool entry', () => {
    const cfg = config();
    const card = { provider: 'regolo', source: 'benchmark', skill_vector: [0.7, 0.5, 0.6, 0.8, 0.6, 0.7], confidence: Array(6).fill('medium') };
    addModelAtomic(cfg, 'qwen3.6-27b', 'regolo', card, {
      baseUrl: 'https://api.regolo.ai/v1', apiKeyEnv: 'REGOLO_API_KEY',
    });
    addModelAtomic(cfg, 'qwen3.6-27b', 'regolo-pool-models', card);
    expect(cfg.model_config['qwen3.6-27b'].preferred_endpoints).toEqual(['regolo', 'regolo-pool-models']);
    expect(cfg.skill_router.models.filter((entry: any) => entry.model === 'qwen3.6-27b')).toHaveLength(1);
    expect(cfg.skill_router.models.find((entry: any) => entry.model === 'qwen3.6-27b')).toMatchObject({
      base_url: 'https://api.regolo.ai/v1', api_key_env: 'REGOLO_API_KEY',
    });
    expect(activeModels(cfg)).toEqual(['glm5.2', 'qwen3.6-27b']);
  });

  it('records an explicit context limit when adding a Codex pool model', () => {
    const cfg = config();
    const card = { skill_vector: Array(6).fill(0.7) };
    addModelAtomic(cfg, 'new-model', 'regolo', card, undefined, 128000);
    expect(cfg.model_config['new-model'].context_window_size).toBe(128000);
  });

  it('removes all references atomically and chooses a valid default', () => {
    const cfg = config();
    const card = { provider: 'regolo', source: 'benchmark', skill_vector: Array(6).fill(0.7) };
    addModelAtomic(cfg, 'qwen3.6-27b', 'regolo-pool-models', card);
    removeModelAtomic(cfg, 'glm5.2');
    normalizeRoutingInvariants(cfg);
    expect(cfg.default_model).toBe('qwen3.6-27b');
    expect(cfg.skill_router.active_models).toEqual(['qwen3.6-27b']);
    expect(cfg.anthropic_passthrough.fixed_model).toBeUndefined();
    expect(cfg.brick.fixed_model).toBeUndefined();
  });

  it('rejects an enabled empty pool', () => {
    const cfg = config();
    removeModelAtomic(cfg, 'glm5.2');
    expect(() => normalizeRoutingInvariants(cfg)).toThrow('active model pool is empty');
  });

  it('openai-codex catalog provides fallback discoverable models', () => {
    const cat: any = (catalog as any)['openai-codex'];
    expect(cat.models.length).toBeGreaterThan(0);
    const defaultIds = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'];
    for (const id of defaultIds) {
      expect(cat.models.some((m: any) => m.id === id)).toBe(true);
    }
    const discoveredIds: string[] = cat.models.map((m: any) => m.id);
    expect(discoveredIds).toEqual(expect.arrayContaining(defaultIds));
  });
});
