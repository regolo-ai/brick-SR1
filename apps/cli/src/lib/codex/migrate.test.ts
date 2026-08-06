import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it, beforeAll, beforeEach } from 'vitest';

let home: string;
let migrateCodexProfile: (profile: string) => Promise<any>;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'brick-codex-migrate-'));
  process.env.BRICK_HOME = home;
  ({ migrateCodexProfile } = await import('./migrate.js'));
});

beforeEach(async () => {
  await rm(join(home, 'profiles', 'codex'), { recursive: true, force: true });
  await mkdir(join(home, 'profiles', 'codex'), { recursive: true });
});

describe('Codex profile migration', () => {
  it('adds the GPT-5.6 starter pool and repairs a stale router image', async () => {
    const dir = join(home, 'profiles', 'codex');
    await writeFile(join(dir, 'config.yaml'), yaml.dump({ model: { name: 'old' }, skill_router: { models: [] } }));
    await writeFile(join(dir, 'docker-compose.yml'), 'services:\n  router:\n    image: docker.io/regolo/brick-cc-router:old\n');

    const result = await migrateCodexProfile('codex');
    const cfg = yaml.load(await readFile(join(dir, 'config.yaml'), 'utf8')) as any;
    const compose = await readFile(join(dir, 'docker-compose.yml'), 'utf8');

    expect(result.poolAdded).toBe(true);
    expect(cfg.default_model).toBe('gpt-5.6-terra');
    expect(cfg.skill_router.models.map((m: any) => m.model)).toEqual(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']);
    expect(compose).toContain('image: docker.io/regolo/brick:latest');
  });

  it('converts the previous generated eight-model pool to GPT-5.6 only', async () => {
    const dir = join(home, 'profiles', 'codex');
    const legacy = ['gpt-5.6-luna', 'gpt-5.4-mini', 'o3-mini', 'gpt-5.6-terra', 'gpt-5.4', 'o3', 'gpt-5.5', 'gpt-5.6-sol'];
    await writeFile(join(dir, 'config.yaml'), yaml.dump({
      model: { name: 'old' },
      brick: { enabled: true, use_model_routing: true, fixed_model: 'gpt-5.4' },
      skill_router: { models: legacy.map((model) => ({ model, skill_vector: [0.1, 0.2] })) },
    }));
    await writeFile(join(dir, 'docker-compose.yml'), 'services:\n  router:\n    image: brick-codex-local:latest\n');

    await migrateCodexProfile('codex');
    const cfg = yaml.load(await readFile(join(dir, 'config.yaml'), 'utf8')) as any;
    const compose = await readFile(join(dir, 'docker-compose.yml'), 'utf8');
    expect(cfg.skill_router.models.map((m: any) => m.model)).toEqual(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']);
    expect(cfg.brick.fixed_model).toBeUndefined();
    expect(compose).toContain('docker.io/regolo/brick:latest');
  });

  it('preserves a non-empty custom pool and its settings', async () => {
    const dir = join(home, 'profiles', 'codex');
    await writeFile(join(dir, 'config.yaml'), yaml.dump({
      model: { name: 'custom' },
      default_model: 'my-model',
      providers: { custom: { type: 'openai_compatible', base_url: 'https://example.com/v1' } },
      skill_router: { models: [{ model: 'my-model', skill_vector: [0.1, 0.2], cost_weight: 0.7 }] },
    }));
    await writeFile(join(dir, 'docker-compose.yml'), 'services:\n  router:\n    image: docker.io/regolo/brick:latest\n');

    const result = await migrateCodexProfile('codex');
    const cfg = yaml.load(await readFile(join(dir, 'config.yaml'), 'utf8')) as any;
    expect(result.poolAdded).toBe(false);
    expect(cfg.default_model).toBe('my-model');
    expect(cfg.skill_router.models).toHaveLength(1);
    expect(cfg.skill_router.models[0].model).toBe('my-model');
    expect(cfg.providers.custom.base_url).toBe('https://example.com/v1');
  });
});
