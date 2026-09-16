import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { nativeConfig } from './native-migration.js';

describe('native profile migration', () => {
  it('rejects retired options in native profiles instead of ignoring them', () => {
    expect(() => nativeConfig({ config_version: 1, semantic_cache: { enabled: true } })).toThrow('Unknown configuration field');
    expect(() => nativeConfig({ config_version: 1, skill_router: { capability_model: { use_cpu: false } } })).toThrow('Unknown configuration field');
  });
  it('preserves an explicit provider credential during legacy migration', () => {
    const migrated = nativeConfig({ model_config: { test: { access_key_env: 'PROVIDER_KEY' } } });
    expect(migrated.model_config.test.access_key_env).toBe('PROVIDER_KEY');
    expect(migrated.model_config.test.use_client_key).toBeUndefined();
  });
  afterEach(() => { delete process.env.BRICK_HOME; vi.resetModules(); });
  it('rejects a local classifier before changing any values', () => {
    const original = { complexity_service: { auto_spawn: true, base_url: 'http://classifier:8094' } };
    const copy = structuredClone(original);
    expect(() => nativeConfig(original)).toThrow('files were not changed');
    expect(original).toEqual(copy);
  });
  it('preserves independent credentials and all routing settings', () => {
    const original = { providers: { regolo: { api_key: '${PROVIDER_KEY}' } },
      complexity_service: { base_url: 'https://api.regolo.ai', bearer_token: '${CLASSIFIER_KEY}', auto_spawn: false },
      skill_router: { math: { routing_preference: .4 }, keyword_rules: [{ name: 'code', keywords: ['code'] }] },
      semantic_cache: { enabled: true }, mom_registry: {} };
    const migrated = nativeConfig(original);
    expect(migrated.providers).toEqual(original.providers);
    expect(migrated.complexity_service.bearer_token).toBe('${CLASSIFIER_KEY}');
    expect(migrated.skill_router).toEqual(original.skill_router);
    expect(migrated.semantic_cache).toBeUndefined();
    expect(migrated.mom_registry).toBeUndefined();
    expect(() => nativeConfig({ ...original, unrecognized_field: true })).toThrow('Unknown configuration field');
    expect(nativeConfig(migrated)).toEqual(migrated);
  });
  it('keeps exact backups and performs no second write', async () => {
    const home = await mkdtemp(join(tmpdir(), 'brick-migration-'));
    process.env.BRICK_HOME = home;
    vi.resetModules();
    const { migrateNativeProfile } = await import('./native-migration.js');
    const dir = join(home, 'profiles', 'test');
    await mkdir(dir, { recursive: true });
    const original = '# Original comment\ncomplexity_service:\n  base_url: https://classifier.example\n  auto_spawn: false\n';
    try {
      await writeFile(join(dir, 'config.yaml'), original);
      await writeFile(join(dir, '.env'), 'CLASSIFIER_KEY=private\nPROVIDER_KEY=other\n');
      await migrateNativeProfile('test');
      const text = await readFile(join(dir, 'config.yaml'), 'utf8');
      const backups = await readdir(join(dir, 'backups'));
      expect(backups).toHaveLength(1);
      expect(await readFile(join(dir, 'backups', backups[0], 'config.yaml'), 'utf8')).toBe(original);
      expect(await readFile(join(dir, 'backups', backups[0], '.env'), 'utf8')).toBe('CLASSIFIER_KEY=private\nPROVIDER_KEY=other\n');
      expect((yaml.load(text) as any).config_version).toBe(1);
      await migrateNativeProfile('test');
      expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toBe(text);
      expect(await readdir(join(dir, 'backups'))).toEqual(backups);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
