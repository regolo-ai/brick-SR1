import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';

let home: string;
let migrateCodexProfile: (profile: string) => Promise<any>;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'brick-codex-migrate-'));
  process.env.BRICK_HOME = home;
  process.env.CODEX_HOME = join(home, 'codex-home');
  await mkdir(process.env.CODEX_HOME);
  await writeFile(join(process.env.CODEX_HOME, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'gpt-5.6-terra', context_window: 272000 },
    { slug: 'gpt-5.6-luna', context_window: 272000 },
  ] }));
  ({ migrateCodexProfile } = await import('./migrate.js'));
});

beforeEach(async () => {
  await rm(join(home, 'profiles', 'codex'), { recursive: true, force: true });
  await mkdir(join(home, 'profiles', 'codex'), { recursive: true });
});

afterAll(async () => { delete process.env.BRICK_HOME; delete process.env.CODEX_HOME; await rm(home, { recursive: true, force: true }); });

describe('Codex profile migration', () => {
  it('populates a dormant profile and preserves legacy deployment files', async () => {
    const dir = join(home, 'profiles', 'codex');
    await writeFile(join(dir, 'config.yaml'), yaml.dump({ model: { name: 'old' }, skill_router: { models: [] } }));
    await writeFile(join(dir, 'docker-compose.yml'), 'services:\n  router:\n    image: docker.io/regolo/brick-cc-router:old\n');

    const result = await migrateCodexProfile('codex');
    const cfg = yaml.load(await readFile(join(dir, 'config.yaml'), 'utf8')) as any;
    const compose = await readFile(join(dir, 'docker-compose.yml'), 'utf8');

    expect(result.poolAdded).toBe(true);
    expect(cfg.default_model).toBe('qwen3.5-122b');
    expect(cfg.skill_router.models.map((entry: any) => entry.model)).toEqual(['qwen3.5-122b', 'gpt-5.6-terra']);
    expect(cfg.skill_router.active_models).toEqual(['qwen3.5-122b', 'gpt-5.6-terra']);
    expect(compose).toContain('image: docker.io/regolo/brick-cc-router:old');
  });

  it('rejects an ambiguous legacy pool without deleting it', async () => {
    const dir = join(home, 'profiles', 'codex');
    const original = yaml.dump({ skill_router: { models: [{ model: 'gpt-5.4', skill_vector: [0.1] }] } });
    await writeFile(join(dir, 'config.yaml'), original);
    await expect(migrateCodexProfile('codex')).rejects.toThrow('authoritative endpoint');
    expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toBe(original);
  });

  it('preserves a non-empty custom pool and its settings', async () => {
    const dir = join(home, 'profiles', 'codex');
    await writeFile(join(dir, 'config.yaml'), yaml.dump({
      model: { name: 'custom' },
      default_model: 'my-model',
      provider_profiles: { custom: { type: 'openai_compatible', base_url: 'https://example.com/v1' } },
      provider_endpoints: [{ name: 'custom', provider_profile: 'custom' }],
      model_config: { 'my-model': { preferred_endpoints: ['custom'], context_window_size: 64000 } },
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

  it('does not reintroduce OpenAI into a Regolo-only Codex profile', async () => {
    const dir = join(home, 'profiles', 'codex');
    await writeFile(join(dir, 'config.yaml'), yaml.dump({
      model: { name: 'regolo-only' },
      providers: { regolo: { type: 'openai_compatible', base_url: 'https://api.regolo.ai/v1' } },
      provider_profiles: { regolo: { type: 'openai_compatible', base_url: 'https://api.regolo.ai/v1' } },
      provider_endpoints: [{ name: 'regolo', provider_profile: 'regolo', weight: 1 }],
      model_config: { 'gpt-oss-20b': { preferred_endpoints: ['regolo'], context_window_size: 128000 } },
      skill_router: { models: [{ model: 'gpt-oss-20b', skill_vector: [0.1, 0.2] }] },
    }));
    await writeFile(join(dir, 'docker-compose.yml'), 'services:\n  router:\n    image: docker.io/regolo/brick:latest\n');

    await migrateCodexProfile('codex');
    const cfg = yaml.load(await readFile(join(dir, 'config.yaml'), 'utf8')) as any;
    expect(cfg.providers).toEqual({ regolo: { base_url: 'https://api.regolo.ai/v1' } });
    expect(cfg.model_config['gpt-oss-20b'].preferred_endpoints).toEqual(['regolo']);
  });

  it('creates dormant routing with isolated provider configuration', async () => {
    const dir = join(home, 'profiles', 'codex');
    await writeFile(join(dir, 'config.yaml'), yaml.dump({ model: { name: 'old' }, skill_router: { models: [] } }));
    await writeFile(join(dir, 'docker-compose.yml'), 'services:\n  router:\n    image: docker.io/regolo/brick:latest\n');

    await migrateCodexProfile('codex');
    const cfg = yaml.load(await readFile(join(dir, 'config.yaml'), 'utf8')) as any;
    expect(cfg.model_config['qwen3.5-122b'].preferred_endpoints).toEqual(['regolo']);
    expect(cfg.model_config['gpt-5.6-terra'].preferred_endpoints).toEqual(['openai-codex']);
    expect(cfg.providers['openai-codex']).toEqual({ base_url: 'https://chatgpt.com/backend-api/codex' });
    expect(cfg.provider_profiles['openai-codex']).toEqual(expect.objectContaining({ type: 'openai_compatible', base_url: 'https://chatgpt.com/backend-api/codex', auth_source: 'codex_request', protocol: 'responses' }));
    expect(cfg.skill_router.models.map((entry: any) => entry.model)).toEqual(['qwen3.5-122b', 'gpt-5.6-terra']);
    expect(cfg.providers.openai).toBeUndefined();
    expect(cfg.provider_profiles.openai).toBeUndefined();
  });

  it('repairs missing transport, updates only the historical bridge URL, and is idempotent', async () => {
    const dir = join(home, 'profiles', 'codex');
    await writeFile(join(dir, 'config.yaml'), yaml.dump({
      providers: { 'openai-codex': { type: 'openai_compatible', base_url: 'https://api.openai.com/v1' } },
      provider_profiles: { 'openai-codex': { type: 'openai_compatible', base_url: 'https://api.openai.com/v1' } },
      provider_endpoints: [{ name: 'openai-codex', provider_profile: 'openai-codex', weight: 1 }],
      model_config: { 'gpt-5.6-terra': { preferred_endpoints: ['openai-codex'], context_window_size: 272000 } },
      skill_router: { models: [{ model: 'gpt-5.6-terra', skill_vector: [0.1, 0.2] }] },
    }));
    await writeFile(join(dir, 'docker-compose.yml'), 'services:\n  router:\n    image: docker.io/regolo/brick:latest\n');

    const first = await migrateCodexProfile('codex');
    const firstText = await readFile(join(dir, 'config.yaml'), 'utf8');
    const cfg = yaml.load(firstText) as any;
    expect(first.changed).toBe(true);
    expect(cfg.skill_router.models[0]).toEqual({ model: 'gpt-5.6-terra', skill_vector: [0.1, 0.2] });
    const second = await migrateCodexProfile('codex');
    expect(second.changed).toBe(false);
    expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toBe(firstText);
  });

  it('preserves an existing openai reasoning_family when pool already exists', async () => {
    const dir = join(home, 'profiles', 'codex');
    await writeFile(join(dir, 'config.yaml'), yaml.dump({
      model: { name: 'existing' },
      providers: { 'openai-codex': { type: 'openai_compatible', base_url: 'https://api.openai.com/v1' } },
      provider_profiles: { 'openai-codex': { type: 'openai_compatible', base_url: 'https://api.openai.com/v1' } },
      provider_endpoints: [{ name: 'openai-codex', provider_profile: 'openai-codex', weight: 1 }],
      model_config: { 'gpt-5.6-terra': { preferred_endpoints: ['openai-codex'], param_size: 'unknown', reasoning_family: 'openai_reasoning', context_window_size: 272000 } },
      skill_router: { models: [{ model: 'gpt-5.6-terra', skill_vector: [0.1, 0.2] }] },
    }));
    await writeFile(join(dir, 'docker-compose.yml'), 'services:\n  router:\n    image: docker.io/regolo/brick:latest\n');

    await migrateCodexProfile('codex');
    const cfg = yaml.load(await readFile(join(dir, 'config.yaml'), 'utf8')) as any;
    expect(cfg.model_config['gpt-5.6-terra'].reasoning_family).toBe('openai_reasoning');
    expect(cfg.model_config['gpt-5.6-terra'].preferred_endpoints).toEqual(['openai-codex']);
  });

  it('leaves provider limits to start-time discovery', async () => {
    const dir = join(home, 'profiles', 'codex');
    await writeFile(join(dir, 'config.yaml'), yaml.dump({
      providers: {
        regolo: { type: 'openai_compatible', base_url: 'https://api.regolo.ai/v1' },
        'openai-codex': { type: 'openai_compatible', base_url: 'https://api.openai.com/v1' },
      },
      provider_profiles: {
        regolo: { type: 'openai_compatible', base_url: 'https://api.regolo.ai/v1' },
        'openai-codex': { type: 'openai_compatible', base_url: 'https://api.openai.com/v1' },
      },
      provider_endpoints: [
        { name: 'regolo', provider_profile: 'regolo' },
        { name: 'openai-codex', provider_profile: 'openai-codex' },
      ],
      model_config: {
        'glm5.2': { preferred_endpoints: ['regolo'] },
        'gpt-5.6-luna': { preferred_endpoints: ['openai-codex'] },
      },
      skill_router: {
        models: [
          { model: 'glm5.2', skill_vector: [0.1, 0.2] },
          { model: 'gpt-5.6-luna', skill_vector: [0.1, 0.2] },
        ],
        active_models: ['glm5.2', 'gpt-5.6-luna'],
      },
    }));

    await migrateCodexProfile('codex');
    const cfg = yaml.load(await readFile(join(dir, 'config.yaml'), 'utf8')) as any;
    expect(cfg.model_config['glm5.2'].context_window_size).toBeUndefined();
    expect(cfg.model_config['gpt-5.6-luna'].context_window_size).toBeUndefined();
  });
});
