import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let home: string;
let ensureDefaultCodexProfile: () => Promise<string>;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'brick-codex-bootstrap-'));
  process.env.BRICK_HOME = home;
  process.env.BRICK_SKILLS_OFFLINE = '1';
  process.env.CODEX_HOME = join(home, 'codex-home');
  await mkdir(process.env.CODEX_HOME);
  await writeFile(join(process.env.CODEX_HOME, 'models_cache.json'), JSON.stringify({ models: [
    {
      slug: 'gpt-6.1-terra',
      context_window: 500000,
      effective_context_window_percent: 95,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }],
    },
    {
      slug: 'gpt-6-luna',
      context_window: 272000,
      effective_context_window_percent: 95,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }],
    },
  ] }));
  ({ ensureDefaultCodexProfile } = await import('./bootstrap.js'));
});

afterAll(async () => {
  delete process.env.BRICK_HOME;
  delete process.env.BRICK_SKILLS_OFFLINE;
  delete process.env.CODEX_HOME;
  await rm(home, { recursive: true, force: true });
});

describe('managed Codex profile', () => {
  it('creates a routing-ready profile with only the 6.x Codex pool', async () => {
    const profile = await ensureDefaultCodexProfile();
    expect(profile).toBe('codex');
    const cfg = yaml.load(await readFile(join(home, 'profiles', 'codex', 'config.yaml'), 'utf8')) as any;

    expect(cfg.default_model).toBe('gpt-6.1-terra');
    expect(cfg.providers).toEqual({ 'openai-codex': { base_url: 'https://chatgpt.com/backend-api/codex' } });
    expect(cfg.provider_endpoints.map((entry: any) => entry.name)).toEqual(['openai-codex']);
    expect(cfg.provider_profiles['openai-codex']).toEqual(expect.objectContaining({ protocol: 'responses', auth_source: 'codex_request' }));

    expect(cfg.skill_router.models.map((entry: any) => entry.model)).toEqual(['gpt-6-luna', 'gpt-6.1-terra']);
    expect(cfg.skill_router.active_models).toEqual(['gpt-6-luna', 'gpt-6.1-terra']);
    expect(cfg.skill_router.keywords).toEqual([
      expect.objectContaining({ name: 'strong-agentic', model: 'gpt-6.1-terra' }),
    ]);

    expect(cfg.model_config['gpt-6-luna']).toEqual(expect.objectContaining({
      preferred_endpoints: ['openai-codex'],
      context_window_size: 258400,
    }));
    expect(cfg.model_config['gpt-6.1-terra']).toEqual(expect.objectContaining({
      preferred_endpoints: ['openai-codex'],
      context_window_size: 475000,
    }));
    expect(cfg.model_config['gpt-6.1-terra'].allowed_thinking_modes).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(cfg.model_config['gpt-6-luna'].allowed_thinking_modes).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);

    const { loadConfig } = await import('../config/load.js');
    const loaded = await loadConfig('codex');
    expect(loaded.skill_router.active_models).toEqual(['gpt-6-luna', 'gpt-6.1-terra']);
    expect(loaded.model_config['gpt-6.1-terra'].context_window_size).toBe(475000);
  });
});
