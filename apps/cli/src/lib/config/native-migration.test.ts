import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { nativeConfig, nativeConfigWithWarnings } from './native-migration.js';

const dimensions = ['coding', 'creative_synthesis', 'instruction_following', 'math_reasoning', 'planning_agentic', 'world_knowledge'];
const legacy = () => ({ config_version: 1, providers: { custom: { base_url: 'https://provider.test', api_key: '${PROVIDER_KEY}' } },
  model_config: { first: { access_key_env: 'PROVIDER_KEY' }, second: { use_client_key: true } },
  complexity_service: { enabled: true, base_url: 'http://classifier:8094', auto_spawn: true },
  brick: { enabled: true, routing_mode: 'smartsqueeze', sticky_ttl_seconds: 60 },
  skill_router: { enabled: true, capabilities: dimensions, active_models: ['second', 'first'],
    capability_model: { labels: dimensions }, complexity_model: { bearer_token: '${OLD_CLASSIFIER_KEY}' },
    math: { routing_preference: .4, tau: { easy: .55 }, complexity_mu: .5 }, dynamic_effort: true,
    models: [{ model: 'second', skill_vector: [.1,.2,.3,.4,.5,.6], cost_weight: .7 }, { model: 'first', skill_vector: [0,1,0,1,0,1] }],
    keyword_rules: [{ name: 'override', keywords: ['code'], model: 'second', mode: 'override', importance: 10 }] } });

describe('SystemOne v2 migration', () => {
  afterEach(() => { delete process.env.BRICK_HOME; vi.resetModules(); });
  it('preserves credentials, vectors, dimension order, pool priority and active order', () => {
    const input = legacy(); const copy = structuredClone(input); const migrated = nativeConfig(input);
    expect(input).toEqual(copy);
    expect(migrated.config_version).toBe(2);
    expect(migrated.providers).toEqual(input.providers);
    expect(migrated.model_config).toEqual(input.model_config);
    expect(migrated.skill_router.capabilities).toEqual(dimensions);
    expect(migrated.skill_router.active_models).toEqual(['second', 'first']);
    expect(migrated.skill_router.models.map((m: any) => m.skill_vector)).toEqual(input.skill_router.models.map(m => m.skill_vector));
    expect(migrated.skill_router.knob).toBe(.4);
    expect(migrated.skill_router.systemone).toEqual({ local_path: 'models/systemone' });
    expect(migrated.complexity_service).toBeUndefined();
    expect(migrated.skill_router.math).toBeUndefined();
    expect(migrated.skill_router.dynamic_effort).toBeUndefined();
    expect(migrated.skill_router.keyword_rules).toBeUndefined();
    expect(migrated.skill_router.keywords).toEqual([{ name: 'override', keywords: ['code'], model: 'second' }]);
    expect(migrated.brick.routing_mode).toBeUndefined();
    expect(nativeConfig(migrated)).toEqual(migrated);
  });
  it('rejects incompatible dimensions, vectors, knobs and version-2 obsolete fields', () => {
    const input = legacy(); input.skill_router.models[0].skill_vector = [.1];
    expect(() => nativeConfig(input)).toThrow('files were not changed');
    for (const value of [NaN, Infinity, -0.1, 1.1]) {
      const bad = legacy(); bad.skill_router.models[0].skill_vector[0] = value;
      expect(() => nativeConfig(bad)).toThrow('files were not changed');
    }
    const bad = legacy(); bad.skill_router.capabilities = ['unknown', ...dimensions.slice(1)];
    expect(() => nativeConfig(bad)).toThrow('files were not changed');
    expect(() => nativeConfig({ ...nativeConfig(legacy()), unknown_section: {} })).toThrow('Unknown configuration field');
    expect(() => nativeConfig({ ...nativeConfig(legacy()), skill_router: { ...nativeConfig(legacy()).skill_router, knob: 2 } })).toThrow('Routing knob');
  });
  it('keeps strict overrides only and refuses to turn a soft bias into one', () => {
    const strict = legacy();
    expect(nativeConfig(strict).skill_router.keywords).toEqual([{ name: 'override', keywords: ['code'], model: 'second' }]);
    for (const mode of [undefined, 'bias', 'BIAS', ' ']) {
      const input = legacy();
      input.skill_router.keyword_rules[0] = { name: 'coding_bias', keywords: ['code'], model: 'second', ...(mode === undefined ? {} : { mode }) };
      const expected = mode === undefined || mode === ' ' ? 'bias' : mode.toLowerCase();
      expect(() => nativeConfig(input)).toThrow(`uses removed mode "${expected}"`);
    }
    const scored = legacy();
    scored.skill_router.keyword_rules[0] = { name: 'scored', keywords: ['code'], model: 'second', mode: 'override', capability: 'coding', bias: { coding: 1 } };
    expect(() => nativeConfig(scored)).toThrow('uses capability/bias scores');
    const both = legacy();
    both.skill_router.keywords = [{ name: 'kept', keywords: ['code'], model: 'second' }];
    expect(() => nativeConfig(both)).toThrow('cannot be used together');
    const { warnings } = nativeConfigWithWarnings(legacy());
    expect(warnings).toContain('skill_router.keyword_rules was renamed to skill_router.keywords');
    expect(warnings.some(warning => warning.includes('.importance is ignored'))).toBe(true);
    expect(warnings.some(warning => warning.includes('complexity_service is removed'))).toBe(true);
    expect(warnings.some(warning => warning.includes('math.routing_preference mapped to skill_router.knob=0.40'))).toBe(true);
  });
  it('validates migrated keyword rules before the runtime rejects them', () => {
    const variant = (mutate: (rule: any) => void, sr?: (config: any) => void) => {
      const input: any = legacy();
      mutate(input.skill_router.keyword_rules[0]);
      sr?.(input.skill_router);
      return input;
    };
    expect(() => nativeConfig(variant(rule => { delete rule.model; }))).toThrow('.model is required');
    expect(() => nativeConfig(variant(rule => { rule.model = 'first'; }, sr => { sr.active_models = ['second']; }))).toThrow('is not an active routing candidate');
    expect(() => nativeConfig(variant(rule => { rule.model = 'missing'; }))).toThrow('is not listed in skill_router.models');
    expect(() => nativeConfig(variant(rule => { rule.keywords = []; }))).toThrow('.keywords cannot be empty');
    expect(() => nativeConfig(variant(rule => { rule.keywords = ['ok', ' ']; }))).toThrow('cannot contain empty entries');
    expect(() => nativeConfig(variant(rule => { rule.operator = 'XOR'; }))).toThrow('.operator must be OR or AND');
    expect(() => nativeConfig(variant(rule => { rule.name = ' '; }))).toThrow('.name cannot be empty');
    expect(() => nativeConfig(variant(rule => { rule.name = 'first_name'; }, sr => { sr.active_models = undefined; }))).not.toThrow();
    const duplicate = legacy();
    duplicate.skill_router.keyword_rules.push(structuredClone(duplicate.skill_router.keyword_rules[0]));
    expect(() => nativeConfig(duplicate)).toThrow('duplicate skill_router.keywords[1].name');
    expect(nativeConfig(variant(rule => { rule.model = 'first'; }, sr => { sr.active_models = []; })).skill_router.keywords[0].model).toBe('first');
  });
  it('treats provider endpoint credentials as explicit server-side keys', () => {
    const input: any = {
      provider_endpoints: [{ name: 'ep', provider_profile: 'custom', api_key: 'sk-endpoint' }],
      model_config: { m: { preferred_endpoints: ['ep'] } },
      skill_router: { enabled: true, capabilities: dimensions, models: [{ model: 'm', skill_vector: [0, 0, 0, 0, 0, 0] }] },
    };
    const migrated = nativeConfig(input);
    expect(migrated.model_config.m.access_key).toBe('sk-endpoint');
    expect(migrated.model_config.m.use_client_key).toBeUndefined();
    expect(migrated.provider_endpoints[0].api_key).toBeUndefined();
  });
  it('accepts the over-capacity scoring weight and rejects out-of-range values', () => {
    const base = nativeConfig(legacy());
    expect(nativeConfig({ ...base, skill_router: { ...base.skill_router, over_capacity_weight: 0.25 } }).skill_router.over_capacity_weight).toBe(0.25);
    expect(() => nativeConfig({ ...base, skill_router: { ...base.skill_router, over_capacity_weight: 1.5 } })).toThrow('files were not changed');
  });
  it('keeps exact backups, atomically replaces the profile, and performs no second write', async () => {
    const home = await mkdtemp(join(tmpdir(), 'brick-systemone-migration-')); process.env.BRICK_HOME = home; vi.resetModules();
    const { migrateNativeProfile } = await import('./native-migration.js');
    const dir = join(home, 'profiles', 'test'); await mkdir(dir, { recursive: true });
    const text = '# Original comment\n' + yaml.dump(legacy()); const env = 'PROVIDER_KEY=keep\nOLD_CLASSIFIER_KEY=old\n';
    try {
      await writeFile(join(dir, 'config.yaml'), text); await writeFile(join(dir, '.env'), env);
      await migrateNativeProfile('test');
      const saved = await readFile(join(dir, 'config.yaml'), 'utf8'); const backups = await readdir(join(dir, 'backups'));
      expect(backups).toHaveLength(1);
      expect(await readFile(join(dir, 'backups', backups[0], 'config.yaml'), 'utf8')).toBe(text);
      expect(await readFile(join(dir, 'backups', backups[0], '.env'), 'utf8')).toBe(env);
      expect(await readFile(join(dir, '.env'), 'utf8')).toBe(env);
      await migrateNativeProfile('test');
      expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toBe(saved);
      expect(await readdir(join(dir, 'backups'))).toEqual(backups);
      const invalid = legacy(); invalid.skill_router.models[0].skill_vector = [0]; const invalidText = yaml.dump(invalid);
      await writeFile(join(dir, 'config.yaml'), invalidText);
      await expect(migrateNativeProfile('test')).rejects.toThrow('files were not changed');
      expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toBe(invalidText);
      expect(await readdir(join(dir, 'backups'))).toEqual(backups);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
