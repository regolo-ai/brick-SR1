import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// All modules are imported after HOME/XDG_CONFIG_HOME/BRICK_HOME point at a
// throwaway directory, so the real ~/.config/opencode and ~/.brick are never
// read or written.
type WiringModule = typeof import('./wiring.js');
type WiringStateModule = typeof import('./wiring-state.js');
type PathsModule = typeof import('../config/paths.js');

let suite: string;
let home: string;
let brickHome: string;
let wiring: WiringModule;
let state: WiringStateModule;
let pathsMod: PathsModule;

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

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

beforeAll(async () => {
  suite = mkdtempSync(join(tmpdir(), 'brick-opencode-'));
  home = join(suite, 'home');
  brickHome = join(suite, 'brickhome');
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  process.env.BRICK_HOME = brickHome;
  delete process.env.OPENCODE_CONFIG_HOME;
  wiring = await import('./wiring.js');
  state = await import('./wiring-state.js');
  pathsMod = await import('../config/paths.js');
});

afterAll(() => {
  delete process.env.BRICK_HOME;
  rmSync(suite, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(wiring.opencodeConfigPath(), { force: true });
  rmSync(statePath(), { force: true });
});

const CATALOG = [
  { id: 'brick' },
  { id: 'qwen3-coder', label: 'Qwen 3 Coder' },
];

describe('opencode wiring', () => {
  it('writes provider.brick with npm, a loopback baseURL and the model catalog', () => {
    const result = wiring.wireOpencode('http://127.0.0.1:8123', CATALOG);
    expect(result.createdFile).toBe(true);
    expect(result.providerExisted).toBe(false);
    expect(existsSync(configPath())).toBe(true);

    const text = wiring.readOpencodeConfig();
    expect(wiring.isWired(text)).toBe(true);
    const parsed = parseJsonc(text);
    expect(parsed.provider.brick.npm).toBe('@ai-sdk/openai');
    expect(parsed.provider.brick.options.baseURL).toBe('http://127.0.0.1:8123/v1');
    expect(parsed.provider.brick.models.brick).toBeTruthy();
    expect(parsed.provider.brick.models['qwen3-coder'].name).toBe('Qwen 3 Coder');
  });

  it('preserves JSONC comments and unrelated keys byte-for-byte outside the managed block', () => {
    const original = `{
  "$schema": "https://opencode.ai/config.json",
  // keep this comment
  "mcp": { "flywheel": { "type": "remote", "url": "https://example.test" } },
  "providers": {
    "regolo-ai": { "name": "Regolo.ai" }
  }
}
`;
    writeFileSync(configPath(), original);
    wiring.wireOpencode('http://127.0.0.1:8123', CATALOG);

    const text = wiring.readOpencodeConfig();
    for (const line of original.split('\n')) {
      if (line.trim() !== '') expect(text).toContain(line);
    }
    expect(text).toContain('// keep this comment');
    const parsed = parseJsonc(text);
    expect(parsed.providers['regolo-ai'].name).toBe('Regolo.ai');
    expect(parsed.mcp.flywheel.url).toBe('https://example.test');
    expect(parsed.provider.brick.options.baseURL).toBe('http://127.0.0.1:8123/v1');
  });

  it('adds provider.brick inside an existing provider object without disturbing its keys', () => {
    const original = `{
  "provider": {
    "existing": { "npm": "@acme/provider" }
  }
}
`;
    writeFileSync(configPath(), original);
    const result = wiring.wireOpencode('http://127.0.0.1:8123', CATALOG);
    expect(result.providerExisted).toBe(true);

    const text = wiring.readOpencodeConfig();
    const parsed = parseJsonc(text);
    expect(parsed.provider.existing.npm).toBe('@acme/provider');
    expect(parsed.provider.brick.npm).toBe('@ai-sdk/openai');
    expect(text).toContain('"existing"');
  });

  it('re-running the wiring is idempotent (byte-identical)', () => {
    wiring.wireOpencode('http://127.0.0.1:8123', CATALOG);
    const first = wiring.readOpencodeConfig();
    wiring.wireOpencode('http://127.0.0.1:8123', CATALOG);
    const second = wiring.readOpencodeConfig();
    expect(second).toBe(first);
    expect(second.split('brick opencode managed block (do not edit)').length - 1).toBe(1);
  });

  it('refuses a pre-existing unmanaged provider.brick', () => {
    const unmanaged = `{
  "provider": {
    "brick": { "npm": "@ai-sdk/openai", "options": { "baseURL": "http://127.0.0.1:1/v1" } }
  }
}
`;
    writeFileSync(configPath(), unmanaged);
    expect(wiring.hasUnmanagedBrickProvider(unmanaged)).toBe(true);
    expect(() => wiring.wireOpencode('http://127.0.0.1:8123', CATALOG)).toThrow(/unmanaged/);
    expect(readFileSync(configPath(), 'utf8')).toBe(unmanaged);
  });

  it('disconnect restores exactly the previous values', () => {
    const original = `{
  "$schema": "https://opencode.ai/config.json",
  // unrelated
  "provider": {
    "existing": { "npm": "@acme/provider" }
  },
  "providers": {
    "regolo-ai": { "name": "Regolo.ai" }
  }
}
`;
    writeFileSync(configPath(), original);
    const result = wiring.wireOpencode('http://127.0.0.1:8123', CATALOG);
    expect(wiring.readOpencodeConfig()).not.toBe(original);
    wiring.unwireOpencode({ createdFile: result.createdFile, providerExisted: result.providerExisted });
    expect(wiring.readOpencodeConfig()).toBe(original);
  });

  it('disconnect removes a config it created', () => {
    expect(existsSync(configPath())).toBe(false);
    const result = wiring.wireOpencode('http://127.0.0.1:8123', CATALOG);
    wiring.unwireOpencode({ createdFile: result.createdFile, providerExisted: result.providerExisted });
    expect(existsSync(configPath())).toBe(false);
  });

  it('rejects non-loopback base URLs', () => {
    expect(() => wiring.wireOpencode('http://0.0.0.0:8123', CATALOG)).toThrow(/loopback/);
    expect(() => wiring.wireOpencode('https://example.com/v1', CATALOG)).toThrow(/loopback/);
    expect(existsSync(configPath())).toBe(false);
  });
});

describe('opencode reserved profile', () => {
  it("treats 'opencode' as reserved", () => {
    expect(pathsMod.RESERVED_PROFILES.has('opencode')).toBe(true);
    expect(() => pathsMod.validateProfileName('opencode')).toThrow(/reserved/);
    expect(pathsMod.validateProfileName('opencode', { allowReserved: true })).toBe('opencode');
  });
});

describe('opencode wiring state', () => {
  it('round-trips and clears the wiring state', () => {
    expect(state.readOpencodeWiring()).toBeNull();
    state.writeOpencodeWiring({
      wired: true,
      baseUrl: 'http://127.0.0.1:8123',
      models: CATALOG,
      createdFile: true,
      providerExisted: false,
    });
    expect(existsSync(statePath())).toBe(true);
    const read = state.readOpencodeWiring();
    expect(read).toEqual({
      wired: true,
      baseUrl: 'http://127.0.0.1:8123',
      models: CATALOG,
      createdFile: true,
      providerExisted: false,
    });
    state.clearOpencodeWiring();
    expect(state.readOpencodeWiring()).toBeNull();
  });
});

describe('opencode wiring writes only allowed files', () => {
  it('touches only the opencode config and the wiring state file', () => {
    writeFileSync(configPath(), '{\n  "model": "x"\n}\n');
    const before = new Set(walkFiles(suite));
    const beforeContents = new Map([...before].map((p) => [p, readFileSync(p, 'utf8')]));

    const result = wiring.wireOpencode('http://127.0.0.1:8123', CATALOG);
    state.writeOpencodeWiring({
      wired: true,
      baseUrl: 'http://127.0.0.1:8123',
      models: CATALOG,
      createdFile: result.createdFile,
      providerExisted: result.providerExisted,
    });

    const after = walkFiles(suite);
    const changed = after.filter((p) => !before.has(p) || readFileSync(p, 'utf8') !== beforeContents.get(p));
    expect(changed.sort()).toEqual([configPath(), statePath()].sort());
    for (const p of after) expect(statSync(p).isFile()).toBe(true);
  });
});
