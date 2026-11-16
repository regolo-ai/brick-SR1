import { describe, expect, it } from 'vitest';
import { nativeCodexTransport, CODEX_UPSTREAM, pruneOfficialCodexModels } from './native-transport.js';

describe('pruneOfficialCodexModels', () => {
  const config = () => ({
    provider_endpoints: [{ name: 'codex', provider_profile: 'openai-codex' }, { name: 'regolo', provider_profile: 'regolo' }],
    default_model: 'gpt-keep',
    model_config: {
      'gpt-keep': { preferred_endpoints: ['codex'] },
      'gpt-stale': { preferred_endpoints: ['codex'] },
      'gpt-stale-active': { preferred_endpoints: ['codex'] },
      'regolo-stale': { preferred_endpoints: ['regolo'] },
      brick: { preferred_endpoints: ['codex'] },
    },
    skill_router: {
      models: [{ model: 'gpt-keep' }, { model: 'gpt-stale' }, { model: 'gpt-stale-active' }, { model: 'regolo-stale' }],
      active_models: ['gpt-keep', 'gpt-stale-active'],
    },
  });
  const catalog = { models: [{ slug: 'gpt-keep' }, { slug: 'gpt-stale-active' }] };

  it('removes stale Codex models but keeps the default, active pool, Brick and other providers', () => {
    const cfg = config();
    const pruned = pruneOfficialCodexModels(cfg, catalog);
    expect(pruned).toEqual(['gpt-stale']);
    expect(Object.keys(cfg.model_config).sort()).toEqual(['brick', 'gpt-keep', 'gpt-stale-active', 'regolo-stale'].sort());
    expect(cfg.skill_router.models.map((entry: any) => entry.model)).toEqual(['gpt-keep', 'gpt-stale-active', 'regolo-stale']);
  });

  it('prunes nothing when the catalog is empty or the model is still advertised', () => {
    const cfg = config();
    expect(pruneOfficialCodexModels(cfg, { models: [] })).toEqual([]);
    expect(pruneOfficialCodexModels(cfg, { models: [{ slug: 'gpt-keep' }, { slug: 'gpt-stale' }, { slug: 'gpt-stale-active' }] })).toEqual([]);
  });
});

describe('native Codex transport migration', () => {
  const source = () => ({
    provider_profiles: { 'openai-codex': { base_url: 'http://host.docker.internal:18080/v1' } },
    provider_endpoints: [{ name: 'codex', provider_profile: 'openai-codex' }],
    model_config: { m: { preferred_endpoints: ['codex'] } },
    skill_router: { models: [{ model: 'm', base_url: 'http://host.docker.internal:18080/v1', api_key_env: 'CODEX_FLAT_BRIDGE_TOKEN', skill_vector: [0.7] }], active_models: ['m'] },
  });
  it('migrates matching copies while preserving the pool and source', () => {
    const original = source();
    const result = nativeCodexTransport(original);
    expect(result.provider_profiles['openai-codex'].base_url).toBe(CODEX_UPSTREAM);
    expect(result.skill_router.models).toEqual([{ model: 'm', skill_vector: [0.7] }]);
    expect(result.skill_router.active_models).toEqual(['m']);
    expect(original.skill_router.models[0].api_key_env).toBe('CODEX_FLAT_BRIDGE_TOKEN');
    expect(nativeCodexTransport(result)).toEqual(result);
  });
  it('rejects conflicting inline transports', () => {
    const original = source(); original.skill_router.models[0].base_url = 'https://other.example/v1';
    expect(() => nativeCodexTransport(original)).toThrow('conflicting inline');
    expect(original.provider_profiles['openai-codex'].base_url).not.toBe(CODEX_UPSTREAM);
  });
});

it('does not reinterpret explicit API billing as subscription authentication', () => {
  expect(() => nativeCodexTransport({ provider_profiles: { 'openai-codex': { base_url: 'https://api.openai.com/v1', auth_source: 'provider_env', api_key_env: 'OPENAI_API_KEY' } } })).toThrow('separate profile');
});
