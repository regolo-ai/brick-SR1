import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The OpenCode profile lifecycle (what `brick start opencode` / `brick stop
// opencode` drive through the harness port) is exercised end to end against a
// throwaway HOME and a fake router on an ephemeral port. The real
// ~/.config/opencode and ~/.brick are never read or written.

const pluginMock = vi.hoisted(() => ({
  define: vi.fn((config: unknown) => config),
  providerIDMake: vi.fn((id: string) => id),
  modelIDMake: vi.fn((id: string) => id),
  modelDefault: vi.fn((providerID: string, id: string) => ({ providerID, id, name: id })),
}));

vi.mock('@opencode/plugin', () => ({
  Plugin: { define: pluginMock.define },
  Provider: { ID: { make: pluginMock.providerIDMake } },
  Model: { ID: { make: pluginMock.modelIDMake }, Info: { default: pluginMock.modelDefault } },
}));

const realHome = homedir();
const realOpencodeDir = join(realHome, '.config', 'opencode');
const realBrickHome = join(realHome, '.brick');

type HarnessModule = typeof import('../harness.js');
type WiringModule = typeof import('./wiring.js');
type PluginInstallModule = typeof import('./plugin-install.js');
type BootstrapModule = typeof import('./bootstrap.js');
type CatalogModule = typeof import('../catalog/opencode.js');
type NetModule = typeof import('../net/local.js');

let suite: string;
let home: string;
let brickHome: string;
let server: Server;
let port: number;
let harness: HarnessModule;
let wiring: WiringModule;
let pluginInstall: PluginInstallModule;
let bootstrap: BootstrapModule;
let opencodeCatalog: CatalogModule['opencodeCatalog'];
let localBaseUrl: NetModule['localBaseUrl'];

const ORIGINAL_CONFIG = `{
  "$schema": "https://opencode.ai/config.json",
  // user-owned comment that must survive
  "provider": {
    "acme": { "npm": "@acme/provider" }
  },
  "models": { "quick": { "provider": "acme" } }
}
`;

function configPath(): string {
  return wiring.opencodeConfigPath();
}

function statePath(): string {
  return join(brickHome, 'profiles', 'opencode', 'runtime', 'harness.json');
}

function parseJsonc(text: string): any {
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return JSON.parse(withoutComments);
}

function snapshotTree(dir: string): Record<string, { size: number; mtimeMs: number }> | null {
  if (!existsSync(dir)) return null;
  const out: Record<string, { size: number; mtimeMs: number }> = {};
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const s = statSync(full);
        out[relative(dir, full)] = { size: s.size, mtimeMs: s.mtimeMs };
      }
    }
  };
  walk(dir);
  return out;
}

function fakeRouter(): Server {
  return createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', routing_ready: true, codex_router: 'native-responses-v1' }));
      return;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'brick' }, { id: 'qwen3.5-122b' }, { slug: 'gpt-5.4-mini' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
}

beforeAll(async () => {
  suite = mkdtempSync(join(tmpdir(), 'brick-opencode-lifecycle-'));
  home = join(suite, 'home');
  brickHome = join(suite, 'brickhome');
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), ORIGINAL_CONFIG);
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  process.env.BRICK_HOME = brickHome;

  harness = await import('../harness.js');
  wiring = await import('./wiring.js');
  pluginInstall = await import('./plugin-install.js');
  bootstrap = await import('./bootstrap.js');
  opencodeCatalog = (await import('../catalog/opencode.js')).opencodeCatalog;
  localBaseUrl = (await import('../net/local.js')).localBaseUrl;

  server = fakeRouter();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no ephemeral port assigned');
  port = address.port;
});

afterAll(async () => {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.BRICK_HOME;
  rmSync(suite, { recursive: true, force: true });
});

describe('OpenCode profile lifecycle', () => {
  it('bootstraps the reserved profile from the starter template', async () => {
    const profile = await bootstrap.ensureDefaultOpencodeProfile();
    expect(profile).toBe('opencode');
    const config = join(brickHome, 'profiles', 'opencode', 'config.yaml');
    expect(existsSync(config)).toBe(true);
    expect(existsSync(join(brickHome, 'profiles', 'opencode', '.env'))).toBe(true);
    expect(readFileSync(config, 'utf8')).toContain('auto_model_name: brick');
    // Idempotent: a second bootstrap leaves the profile untouched.
    expect(await bootstrap.ensureDefaultOpencodeProfile()).toBe('opencode');
  });

  it('wires opencode.json, installs the plugin, is idempotent, and restores on stop', async () => {
    const beforeRealOpencode = snapshotTree(realOpencodeDir);
    const beforeRealBrick = snapshotTree(realBrickHome);

    await harness.connectOfficialHarness('opencode', port);

    const text = wiring.readOpencodeConfig();
    expect(wiring.isWired(text)).toBe(true);
    const parsed = parseJsonc(text);
    expect(parsed.provider.acme.npm).toBe('@acme/provider');
    expect(parsed.provider.brick.npm).toBe('@ai-sdk/openai');
    expect(parsed.provider.brick.options.baseURL).toBe(localBaseUrl(port) + '/v1');
    expect(parsed.provider.brick.models.brick).toBeTruthy();
    for (const model of opencodeCatalog.models) {
      expect(parsed.provider.brick.models[model.id], `missing ${model.id}`).toBeTruthy();
    }

    expect(pluginInstall.isOpencodePluginInstalled()).toBe(true);
    expect(existsSync(join(home, '.config', 'opencode', 'plugins', 'brick', 'index.js'))).toBe(true);

    // `brick status opencode` recognises the wiring.
    const connection = harness.harnessConnection('opencode', localBaseUrl(port));
    expect(connection.attached).toBe(true);
    expect(connection.label).toBe('OpenCode config');

    // A second start changes nothing.
    const wiredOnce = readFileSync(configPath(), 'utf8');
    await harness.connectOfficialHarness('opencode', port);
    expect(readFileSync(configPath(), 'utf8')).toBe(wiredOnce);

    // The installed plugin consumes /v1/models from the fake router.
    const plugin = (await import('../../../assets/opencode-plugin/index.js')) as unknown as {
      refreshBrickModels: (ctx: unknown, fetchImpl?: unknown) => Promise<void>;
    };
    const seen: string[] = [];
    const ctx = {
      provider: {
        get: vi.fn(async () => ({ id: 'brick', settings: { baseURL: `${localBaseUrl(port)}/v1` } })),
        transform: vi.fn(async (callback: (editor: unknown) => void) => {
          callback({ models: { set: (_id: string, models: { id: string }[]) => seen.push(...models.map((m) => m.id)) } });
        }),
      },
    };
    await plugin.refreshBrickModels(ctx, globalThis.fetch);
    expect(seen).toEqual(['brick', 'qwen3.5-122b', 'gpt-5.4-mini']);

    // `brick stop opencode` restores the original file exactly and removes the plugin.
    await harness.disconnectOfficialHarness('opencode');
    expect(readFileSync(configPath(), 'utf8')).toBe(ORIGINAL_CONFIG);
    expect(pluginInstall.isOpencodePluginInstalled()).toBe(false);
    expect(existsSync(statePath())).toBe(false);

    // The real OpenCode state was never touched.
    expect(snapshotTree(realOpencodeDir)).toEqual(beforeRealOpencode);
    expect(snapshotTree(realBrickHome)).toEqual(beforeRealBrick);
  });

  it('reports detached when the managed plugin file is removed', async () => {
    await harness.connectOfficialHarness('opencode', port);
    expect(harness.harnessConnection('opencode', localBaseUrl(port)).attached).toBe(true);

    // The managed config block is still present, but the plugin is gone: the
    // harness must not claim it is attached.
    rmSync(pluginInstall.opencodePluginPath());
    expect(wiring.isWired(wiring.readOpencodeConfig())).toBe(true);
    expect(harness.harnessConnection('opencode', localBaseUrl(port)).attached).toBe(false);

    // Re-installing the plugin makes status attached again.
    pluginInstall.installOpencodePlugin();
    expect(harness.harnessConnection('opencode', localBaseUrl(port)).attached).toBe(true);

    await harness.disconnectOfficialHarness('opencode');
  });

  it('emits the schema v2.0 agent report after a stop', async () => {
    const { buildAgentReport, AGENT_REPORT_SCHEMA_VERSION } = await import('../status/agent-report.js');
    const { ConfigSchema } = await import('../config/schema.js');
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    try {
      const cfg = ConfigSchema.parse({
        default_model: 'brick',
        skill_router: {
          capabilities: ['instruction_following', 'coding', 'math_reasoning', 'world_knowledge', 'planning_agentic', 'creative_synthesis'],
          systemone: { local_path: 'models/systemone' },
          models: [{ model: 'brick', skill_vector: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5] }],
          active_models: ['brick'],
        },
      });
      const report = await buildAgentReport('opencode', cfg);
      expect(report.schema_version).toBe(AGENT_REPORT_SCHEMA_VERSION);
      expect(report.schema_version).toBe('2.0');
      expect(report.harness.attached).toBe(false);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      vi.unstubAllGlobals();
    }
  });

  it('leaves no listener behind when the fake router is closed', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(server.listening).toBe(false);
    await expect(fetch(`${localBaseUrl(port)}/health`)).rejects.toThrow();
  });
});
