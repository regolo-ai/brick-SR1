import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { nativeConfig } from './native-migration.js';

const dimensions = ['coding', 'creative_synthesis', 'instruction_following', 'math_reasoning', 'planning_agentic', 'world_knowledge'];
const legacy = () => ({ config_version: 1, providers: { custom: { base_url: 'https://provider.test', api_key: '${PROVIDER_KEY}' } },
  model_config: { first: { access_key_env: 'PROVIDER_KEY' }, second: { use_client_key: true } },
  complexity_service: { enabled: true, base_url: 'http://classifier:8094', auto_spawn: true },
  brick: { enabled: true, routing_mode: 'smartsqueeze', sticky_ttl_seconds: 60 },
  skill_router: { enabled: true, capabilities: dimensions, active_models: ['second', 'first'],
    capability_model: { labels: dimensions }, complexity_model: { bearer_token: '${OLD_CLASSIFIER_KEY}' },
    math: { routing_preference: .4, tau: { easy: .55 }, complexity_mu: .5 }, dynamic_effort: true,
    models: [{ model: 'second', skill_vector: [.1,.2,.3,.4,.5,.6], cost_weight: .7 }, { model: 'first', skill_vector: [0,1,0,1,0,1] }],
    keyword_rules: [{ name: 'override', keywords: ['code'] }] } });

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
    expect(() => nativeConfig({ ...nativeConfig(legacy()), complexity_service: {} })).toThrow('Unknown configuration field');
    expect(() => nativeConfig({ ...nativeConfig(legacy()), skill_router: { ...nativeConfig(legacy()).skill_router, knob: 2 } })).toThrow('Routing knob');
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
