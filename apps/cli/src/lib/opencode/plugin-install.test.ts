import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

import {
  installOpencodePlugin,
  isManagedPlugin,
  isOpencodePluginInstalled,
  opencodePluginPath,
  readPluginSource,
  uninstallOpencodePlugin,
} from './plugin-install.js';

interface RecordedEditor {
  add: number;
  update: number;
  set: { providerID: string; models: { id: string }[] }[];
}

function fakeContext(baseURL: string | null = 'http://127.0.0.1:8000/v1') {
  const recorded: RecordedEditor = { add: 0, update: 0, set: [] };
  const provider = {
    get: vi.fn(async ({ providerID }: { providerID: string }) =>
      baseURL === null ? undefined : { id: providerID, settings: { baseURL } }
    ),
    transform: vi.fn(async (callback: (editor: unknown) => void) => {
      callback({
        add: () => {
          recorded.add += 1;
        },
        update: () => {
          recorded.update += 1;
        },
        models: {
          set: (providerID: string, models: { id: string }[]) => {
            recorded.set.push({ providerID, models });
          },
        },
      });
    }),
  };
  return { ctx: { provider }, recorded };
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

let plugin: {
  default: { id: string; setup: (ctx: unknown) => Promise<unknown> };
  refreshBrickModels: (ctx: unknown, fetchImpl?: unknown) => Promise<void>;
};

beforeAll(async () => {
  plugin = (await import('../../../assets/opencode-plugin/index.js')) as unknown as typeof plugin;
});

describe('brick OpenCode plugin', () => {
  it('refreshes the existing brick provider from /v1/models without adding a provider', async () => {
    const { ctx, recorded } = fakeContext();
    const fetchImpl = vi.fn(async () =>
      okResponse({ data: [{ id: 'brick' }, { id: 'gpt-5.4-mini' }, { slug: 'gpt-5.6-luna' }] })
    );

    await plugin.refreshBrickModels(ctx, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:8000/v1/models');
    expect(recorded.add).toBe(0);
    expect(recorded.update).toBe(0);
    expect(recorded.set).toHaveLength(1);
    expect(recorded.set[0].providerID).toBe('brick');
    expect(recorded.set[0].models.map((model) => model.id)).toEqual(['brick', 'gpt-5.4-mini', 'gpt-5.6-luna']);
  });

  it('does nothing when the brick provider is not configured', async () => {
    const { ctx, recorded } = fakeContext(null);
    const fetchImpl = vi.fn();

    await plugin.refreshBrickModels(ctx, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(recorded.set).toHaveLength(0);
  });

  it('logs and completes setup when the router is down', async () => {
    const { ctx, recorded } = fakeContext();
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchImpl);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(plugin.default.setup(ctx)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[brick]'));
    expect(recorded.add).toBe(0);
    expect(recorded.set).toHaveLength(0);
    warn.mockRestore();
    vi.unstubAllGlobals();
  });

  it('registers itself as the brick plugin and keeps setup offline-safe on an HTTP error', async () => {
    expect(plugin.default.id).toBe('brick');
    expect(pluginMock.define).toHaveBeenCalledWith(expect.objectContaining({ id: 'brick' }));

    const { ctx, recorded } = fakeContext();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(plugin.default.setup(ctx)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(recorded.set).toHaveLength(0);
    warn.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe('opencode plugin installer', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    home = await mkdtemp(join(tmpdir(), 'brick-opencode-'));
    process.env.HOME = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it('writes the managed plugin to ~/.config/opencode/plugins/brick/index.js', async () => {
    const result = installOpencodePlugin();
    const expected = join(home, '.config', 'opencode', 'plugins', 'brick', 'index.js');

    expect(result).toEqual({ path: expected, created: true, changed: true });
    expect(existsSync(expected)).toBe(true);
    const written = await readFile(expected, 'utf8');
    expect(written).toBe(readPluginSource());
    expect(isManagedPlugin(written)).toBe(true);
    expect(written).toContain("Plugin.define({");
    expect(written).toContain("id: 'brick'");
    expect(isOpencodePluginInstalled()).toBe(true);
  });

  it('is idempotent: a second install leaves the file byte-for-byte unchanged', async () => {
    installOpencodePlugin();
    const expected = opencodePluginPath();
    const first = await readFile(expected, 'utf8');

    const second = installOpencodePlugin();

    expect(second).toEqual({ path: expected, created: false, changed: false });
    expect(await readFile(expected, 'utf8')).toBe(first);
  });

  it('refuses to overwrite an unmanaged index.js', async () => {
    const dir = join(home, '.config', 'opencode', 'plugins', 'brick');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.js'), '// somebody else wrote this\n');

    expect(() => installOpencodePlugin()).toThrow(/unmanaged/);
    expect(await readFile(join(dir, 'index.js'), 'utf8')).toBe('// somebody else wrote this\n');
  });

  it('removes its own file and the empty directory on uninstall', async () => {
    installOpencodePlugin();
    const expected = opencodePluginPath();
    const dir = join(home, '.config', 'opencode', 'plugins', 'brick');

    expect(uninstallOpencodePlugin()).toEqual({ removed: true });
    expect(existsSync(expected)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(uninstallOpencodePlugin()).toEqual({ removed: false });
  });

  it('leaves a foreign index.js in place on uninstall', async () => {
    const dir = join(home, '.config', 'opencode', 'plugins', 'brick');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.js'), '// somebody else wrote this\n');

    expect(uninstallOpencodePlugin()).toEqual({ removed: false });
    expect(await readFile(join(dir, 'index.js'), 'utf8')).toBe('// somebody else wrote this\n');
  });
});
