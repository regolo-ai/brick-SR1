import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let home: string;
let discoverAndApplyContextWindows: typeof import('./context-discovery.js').discoverAndApplyContextWindows;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'brick-context-apply-'));
  process.env.BRICK_HOME = home;
  ({ discoverAndApplyContextWindows } = await import('./context-discovery.js'));
});

afterAll(async () => {
  delete process.env.BRICK_HOME;
  await rm(home, { recursive: true, force: true });
});

function profileConfig(): any {
  return {
    trusted_proxy_header: 'X-Custom-Credential',
    model: { name: 'discovery-test' },
    server_port: 8000,
    auto_model_name: 'brick',
    providers: { openai: { type: 'openai_compatible', base_url: 'https://api.openai.com/v1' } },
    provider_profiles: { openai: { type: 'openai_compatible', base_url: 'https://api.openai.com/v1' } },
    provider_endpoints: [{ name: 'openai', provider_profile: 'openai', weight: 1 }],
    default_model: 'gpt-a',
    model_config: {
      'gpt-a': { preferred_endpoints: ['openai'], context_window_size: 1 },
      'gpt-b': { preferred_endpoints: ['openai'] },
    },
    reasoning_families: {},
    default_reasoning_effort: 'medium',
    skill_router: {
      enabled: true,
      capabilities: ['coding'],
      capability_model: { model_id: "installed" },
      complexity_model: {},
      math: {},
      models: [
        { model: 'gpt-a', skill_vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] },
        { model: 'gpt-b', skill_vector: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7] },
      ],
      active_models: ['gpt-a', 'gpt-b'],
      keyword_rules: [],
    },
    keyword_rules: [],
    decisions: [],
  };
}

describe('start-time context application', () => {
  it('refreshes only the required source, overwrites YAML values, and supports pool minimum recalculation', async () => {
    const profile = 'work';
    const dir = join(home, 'profiles', profile);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.yaml'), yaml.dump(profileConfig()));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'openai/gpt-a', context_length: 100_000, top_provider: { context_length: 90_000, max_completion_tokens: 10_000 } },
      { id: 'openai/gpt-b', context_length: 70_000, top_provider: { context_length: 70_000, max_completion_tokens: 5_000 } },
    ] }), { status: 200 })) as unknown as typeof fetch;

    const applied = await discoverAndApplyContextWindows(profile, undefined, { fetchImpl, cacheDir: join(home, 'cache-test') });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(applied.changed).toBe(true);
    expect(applied.config.model_config['gpt-a'].context_window_size).toBe(80_000);
    expect(applied.config.model_config['gpt-b'].context_window_size).toBe(65_000);
    const saved = yaml.load(await readFile(join(dir, 'config.yaml'), 'utf8')) as any;
    expect(saved.model_config['gpt-a'].context_window_size).toBe(80_000);
    expect(saved.model_config['gpt-b'].context_window_size).toBe(65_000);
    expect(saved.trusted_proxy_header).toEqual('X-Custom-Credential');
    expect(Math.min(...applied.results.map((item) => item.maxInputTokens!))).toBe(65_000);
  });

  it('does not update YAML when one active model is unverified', async () => {
    const profile = 'blocked';
    const dir = join(home, 'profiles', profile);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.yaml'), yaml.dump(profileConfig()));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'openai/gpt-a', context_length: 100_000, top_provider: { context_length: 90_000, max_completion_tokens: 10_000 } },
    ] }), { status: 200 })) as unknown as typeof fetch;

    await expect(discoverAndApplyContextWindows(profile, undefined, { fetchImpl, cacheDir: join(home, 'cache-blocked') })).rejects.toThrow("gpt-a: OpenRouter model 'openai/gpt-b' is absent");
    const saved = yaml.load(await readFile(join(dir, 'config.yaml'), 'utf8')) as any;
    expect(saved.model_config['gpt-a'].context_window_size).toBe(1);
    expect(saved.model_config['gpt-b'].context_window_size).toBeUndefined();
  });
});
