import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The bundled plugin imports `@opencode/plugin`, which OpenCode provides at
// runtime and the repository does not depend on. Mirror the mock used by the
// plugin-install unit test.
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

import { refreshBrickModels } from '../assets/opencode-plugin/index.js';

interface RecordedEditor {
  models: { id: string }[];
}

function fakeContext(baseURL: string) {
  const recorded: RecordedEditor = { models: [] };
  const provider = {
    get: vi.fn(async ({ providerID }: { providerID: string }) => ({ id: providerID, settings: { baseURL } })),
    transform: vi.fn(async (callback: (editor: unknown) => void) => {
      callback({
        models: {
          set: (_providerID: string, models: { id: string }[]) => {
            recorded.models = models;
          },
        },
      });
    }),
  };
  return { ctx: { provider }, recorded };
}

function startFakeRouter(models: { id: string }[]): Promise<{ server: Server; port: number; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    requests.push(url);
    if (url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: models }));
      return;
    }
    // Any other probe (health, economics, stats) is reported as absent so the
    // status/agent views fall back to their empty state.
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({}));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, requests });
    });
  });
}

/** Parse JSONC by dropping comments outside of strings (test-local helper). */
function parseJsoncLoose(text: string): any {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return JSON.parse(out);
}

let home: string;
let server: Server | undefined;
const saved = { HOME: process.env.HOME, BRICK_HOME: process.env.BRICK_HOME };

const SAMPLE_OPENCODE = `{
  // user settings, do not lose these
  "$schema": "https://opencode.ai/config.json",
  "theme": "dark",
  "provider": {
    "regolo": { "npm": "@ai-sdk/openai", "options": { "baseURL": "https://api.regolo.ai/v1" } }
  }
}
`;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'brick-opencode-lifecycle-'));
  process.env.HOME = home;
  process.env.BRICK_HOME = join(home, '.brick');
  vi.resetModules();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  if (saved.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = saved.HOME;
  if (saved.BRICK_HOME === undefined) delete process.env.BRICK_HOME;
  else process.env.BRICK_HOME = saved.BRICK_HOME;
  await rm(home, { recursive: true, force: true });
});

describe('opencode profile lifecycle', () => {
  it('bootstraps, wires, is idempotent, refreshes, feeds the plugin, and restores', async () => {
    const profileMod = await import('../src/lib/runtime/opencode-profile.js');
    const harness = await import('../src/lib/harness.js');
    const wiring = await import('../src/lib/opencode/wiring.js');
    const pluginInstall = await import('../src/lib/opencode/plugin-install.js');

    expect(await profileMod.ensureDefaultOpencodeProfile()).toBe('opencode');
    const configPath = wiring.opencodeConfigPath();
    await mkdir(join(home, '.config', 'opencode'), { recursive: true });
    await writeFile(configPath, SAMPLE_OPENCODE);
    const original = await readFile(configPath, 'utf8');

    const fake = await startFakeRouter([{ id: 'brick' }, { id: 'gpt-6.1-terra' }]);
    server = fake.server;
    const baseUrl = `http://127.0.0.1:${fake.port}`;

    await harness.connectOfficialHarness('opencode', fake.port);

    const wired = await readFile(configPath, 'utf8');
    expect(wired).not.toBe(original);
    expect(wired).toContain('// user settings, do not lose these');
    expect(wiring.isWired(wired)).toBe(true);
    const parsed = parseJsoncLoose(wired);
    expect(parsed.provider.brick.npm).toBe('@ai-sdk/openai');
    expect(parsed.provider.brick.options.baseURL).toBe(`${baseUrl}/v1`);
    expect(parsed.provider.regolo.npm).toBe('@ai-sdk/openai');
    expect(Object.keys(parsed.provider.brick.models)).toContain('brick');
    expect(pluginInstall.isOpencodePluginInstalled()).toBe(true);
    expect(await readFile(pluginInstall.opencodePluginPath(), 'utf8')).toBe(await readFile(pluginInstall.pluginAssetPath(), 'utf8'));

    const connection = harness.harnessConnection('opencode', baseUrl);
    expect(connection.attached).toBe(true);
    expect(connection.label).toBe('OpenCode config');
    expect(connection.url).toBe(baseUrl);

    // A second start must change nothing.
    await harness.connectOfficialHarness('opencode', fake.port);
    expect(await readFile(configPath, 'utf8')).toBe(wired);

    // The written block points at the free port and the plugin consumes /v1/models there.
    const { ctx, recorded } = fakeContext(`${baseUrl}/v1`);
    await refreshBrickModels(ctx);
    expect(fake.requests).toContain('/v1/models');
    expect(recorded.models.map((model) => model.id)).toEqual(['brick', 'gpt-6.1-terra']);

    // Refresh re-points the managed block at the new port.
    await harness.refreshOfficialHarness('opencode', fake.port + 1);
    const refreshed = parseJsoncLoose(await readFile(configPath, 'utf8'));
    expect(refreshed.provider.brick.options.baseURL).toBe(`http://127.0.0.1:${fake.port + 1}/v1`);

    // Stop restores the original file and removes the managed plugin.
    await harness.disconnectOfficialHarness('opencode');
    expect(await readFile(configPath, 'utf8')).toBe(original);
    expect(pluginInstall.isOpencodePluginInstalled()).toBe(false);
  });

  it('keeps the agent report on the v2.0 schema for the wired profile', async () => {
    const profileMod = await import('../src/lib/runtime/opencode-profile.js');
    const harness = await import('../src/lib/harness.js');
    const reportMod = await import('../src/lib/status/agent-report.js');
    const loadMod = await import('../src/lib/config/load.js');

    expect(reportMod.AGENT_REPORT_SCHEMA_VERSION).toBe('2.0');
    await profileMod.ensureDefaultOpencodeProfile();
    const fake = await startFakeRouter([{ id: 'brick' }]);
    server = fake.server;

    // The agent report derives its base URL from the profile's server_port, so
    // point it at the same free port Brick is wired to.
    const pathsMod = await import('../src/lib/config/paths.js');
    const pp = pathsMod.paths('opencode');
    const raw = yaml.load(await readFile(pp.config, 'utf8')) as any;
    raw.server_port = fake.port;
    await writeFile(pp.config, yaml.dump(raw));

    await harness.connectOfficialHarness('opencode', fake.port);

    const cfg = await loadMod.loadConfig('opencode');
    const report = await reportMod.buildAgentReport('opencode', cfg);

    expect(report.schema_version).toBe('2.0');
    expect(report.profile).toBe('opencode');
    expect(report.harness.label).toBe('OpenCode config');
    expect(report.harness.attached).toBe(true);
  });
});
