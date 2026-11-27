import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const HEADER = 'model,coding,creative_synthesis,instruction_following,math_reasoning,planning_agentic,world_knowledge';
const capabilities = ['coding', 'creative_synthesis', 'instruction_following', 'math_reasoning', 'planning_agentic', 'world_knowledge'];

let home: string;
let syncSkillCards: (profile: string, options?: any) => Promise<void>;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'brick-serve-sync-'));
  process.env.BRICK_HOME = home;
  // config/paths.ts resolves BRICK_HOME at import time.
  vi.resetModules();
  ({ syncSkillCards } = await import('./serve.js'));
});

afterAll(async () => {
  delete process.env.BRICK_HOME;
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(join(home, 'profiles', 'codex'), { recursive: true, force: true });
  await mkdir(join(home, 'profiles', 'codex'), { recursive: true });
});

function config() {
  return {
    default_model: 'alpha',
    provider_profiles: { local: { type: 'openai_compatible', base_url: 'https://example.com/v1' } },
    provider_endpoints: [{ name: 'local', provider_profile: 'local', weight: 1 }],
    model_config: { alpha: { preferred_endpoints: ['local'] }, beta: { preferred_endpoints: ['local'] } },
    skill_router: {
      capabilities,
      models: [
        { model: 'alpha', skill_vector: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1] },
        { model: 'beta', skill_vector: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2] },
      ],
      active_models: ['alpha', 'beta'],
    },
  };
}

async function writeProfile(): Promise<string> {
  const path = join(home, 'profiles', 'codex', 'config.yaml');
  await writeFile(path, yaml.dump(config()));
  return path;
}

describe('syncSkillCards', () => {
  it('keeps pool models the published table omits instead of dropping them', async () => {
    const path = await writeProfile();
    const csv = `${HEADER}\nalpha,0.9,0.8,0.7,0.6,0.5,0.4\n`;
    await syncSkillCards('codex', {
      refresh: true,
      cacheDir: join(home, 'cache', 'sync'),
      fetchImpl: async () => new Response(csv),
    });

    const cfg = yaml.load(await readFile(path, 'utf8')) as any;
    const byModel = Object.fromEntries(cfg.skill_router.models.map((entry: any) => [entry.model, entry.skill_vector]));
    expect(Object.keys(byModel).sort()).toEqual(['alpha', 'beta']);
    expect(byModel.alpha).toEqual([0.9, 0.8, 0.7, 0.6, 0.5, 0.4]);
    expect(byModel.beta).toEqual([0.2, 0.2, 0.2, 0.2, 0.2, 0.2]);
    expect(cfg.skill_router.active_models).toEqual(['alpha', 'beta']);
  });

  it('keeps the configured vectors when the published table is semantically invalid', async () => {
    const path = await writeProfile();
    const before = await readFile(path, 'utf8');
    await syncSkillCards('codex', {
      refresh: true,
      cacheDir: join(home, 'cache', 'bad'),
      fetchImpl: async () => new Response('model,wrong\nx,y'),
    });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('keeps the configured vectors when the table cannot be reached', async () => {
    const path = await writeProfile();
    const before = await readFile(path, 'utf8');
    await syncSkillCards('codex', {
      refresh: true,
      cacheDir: join(home, 'cache', 'offline'),
      fetchImpl: (async () => { throw new Error('offline'); }) as any,
    });
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});
