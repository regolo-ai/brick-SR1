import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANAGED_BEGIN,
  MANAGED_END,
  hasUnmanagedBrickProvider,
  isWired,
  opencodeConfigPath,
  stripManagedBlock,
  unwireOpencode,
  wireOpencode,
} from './wiring.js';
import {
  clearOpencodeWiring,
  opencodeWiringPath,
  readOpencodeWiring,
  writeOpencodeWiring,
} from './wiring-state.js';
import { RESERVED_PROFILES, validateProfileName } from '../config/paths.js';

let home: string;
const saved = { HOME: process.env.HOME, BRICK_HOME: process.env.BRICK_HOME };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'brick-opencode-'));
  process.env.HOME = home;
  process.env.BRICK_HOME = join(home, '.brick');
});

afterEach(() => {
  if (saved.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = saved.HOME;
  if (saved.BRICK_HOME === undefined) delete process.env.BRICK_HOME;
  else process.env.BRICK_HOME = saved.BRICK_HOME;
  rmSync(home, { recursive: true, force: true });
});

function readConfig(): string {
  return readFileSync(opencodeConfigPath(), 'utf8');
}

function writeConfig(text: string): void {
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(opencodeConfigPath(), text);
}

/** Parse JSONC by dropping line/block comments outside of strings. */
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

function listFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(full.slice(base.length + 1).split('\\').join('/'));
  }
  return out.sort();
}

const SAMPLE = `{
  // user settings, do not lose these
  "$schema": "https://opencode.ai/config.json",
  "theme": "dark",
  "provider": {
    /* the upstream provider */
    "regolo": {
      "npm": "@ai-sdk/openai",
      "options": { "baseURL": "https://api.regolo.ai/v1" }
    }
  }
}
`;

describe('opencode wiring', () => {
  it('creates opencode.json from scratch with a managed brick provider', () => {
    expect(existsSync(opencodeConfigPath())).toBe(false);

    const result = wireOpencode('http://127.0.0.1:8000', ['brick', 'deepseek-v4.1-flash']);

    expect(result.createdFile).toBe(true);
    expect(result.previousProviderRaw).toBeNull();
    expect(existsSync(opencodeConfigPath())).toBe(true);
    expect(isWired(readConfig())).toBe(true);
    expect(result.models).toEqual(['brick', 'deepseek-v4.1-flash']);

    const parsed = parseJsoncLoose(readConfig());
    expect(parsed.provider.brick.npm).toBe('@ai-sdk/openai');
    expect(parsed.provider.brick.options.baseURL).toBe('http://127.0.0.1:8000/v1');
    expect(Object.keys(parsed.provider.brick.models)).toEqual(['brick', 'deepseek-v4.1-flash']);

    const state = readOpencodeWiring();
    expect(state).not.toBeNull();
    expect(state!.wired).toBe(true);
    expect(state!.baseUrl).toBe('http://127.0.0.1:8000');
    expect(state!.createdFile).toBe(true);
    expect(state!.previousProviderRaw).toBeNull();
  });

  it('is idempotent: a second run leaves the file byte-identical', () => {
    writeConfig(SAMPLE);
    wireOpencode('http://127.0.0.1:8000', ['brick', 'm1']);
    const first = readConfig();
    const stateAfterFirst = readFileSync(opencodeWiringPath(), 'utf8');

    wireOpencode('http://127.0.0.1:8000', ['brick', 'm1']);

    expect(readConfig()).toBe(first);
    expect(readFileSync(opencodeWiringPath(), 'utf8')).toBe(stateAfterFirst);
  });

  it('preserves comments and third-party keys', () => {
    writeConfig(SAMPLE);
    wireOpencode('http://127.0.0.1:8000');

    const text = readConfig();
    expect(text).toContain('// user settings, do not lose these');
    expect(text).toContain('/* the upstream provider */');
    expect(text).toContain('"theme": "dark"');
    expect(text).toContain('"$schema": "https://opencode.ai/config.json"');
    expect(text).toContain('https://api.regolo.ai/v1');

    const parsed = parseJsoncLoose(text);
    expect(parsed.theme).toBe('dark');
    expect(parsed.provider.regolo.npm).toBe('@ai-sdk/openai');
    expect(parsed.provider.brick.models.brick).toEqual({});
    expect(text.indexOf(MANAGED_BEGIN)).toBeLessThan(text.indexOf(MANAGED_END));
  });

  it('adds the managed provider to an existing empty provider object', () => {
    writeConfig('{\n  "provider": {}\n}\n');
    wireOpencode('http://localhost:8000');
    const parsed = parseJsoncLoose(readConfig());
    expect(parsed.provider.brick.options.baseURL).toBe('http://localhost:8000/v1');
  });

  it('refuses an unmanaged brick provider and leaves the file untouched', () => {
    const original = '{\n  "provider": {\n    "brick": { "npm": "someone-else" }\n  }\n}\n';
    writeConfig(original);
    expect(hasUnmanagedBrickProvider(original)).toBe(true);

    expect(() => wireOpencode('http://127.0.0.1:8000')).toThrow(/unmanaged provider\.brick/);
    expect(readConfig()).toBe(original);
    expect(readOpencodeWiring()).toBeNull();
  });

  it('restores the exact previous values on disconnect', () => {
    writeConfig(SAMPLE);
    wireOpencode('http://127.0.0.1:8000', ['brick', 'm1']);
    expect(readConfig()).not.toBe(SAMPLE);

    unwireOpencode();

    expect(readConfig()).toBe(SAMPLE);
    expect(isWired(readConfig())).toBe(false);
    expect(readOpencodeWiring()).toBeNull();
  });

  it('removes opencode.json again when disconnect unwires a file brick created', () => {
    wireOpencode('http://127.0.0.1:8000');
    expect(existsSync(opencodeConfigPath())).toBe(true);

    unwireOpencode();

    expect(existsSync(opencodeConfigPath())).toBe(false);
    expect(readOpencodeWiring()).toBeNull();
  });

  it('keeps unrelated keys added while wired when disconnecting', () => {
    wireOpencode('http://127.0.0.1:8000');
    const wired = readConfig();
    writeConfig(wired.replace('{\n', '{\n  "theme": "light",\n'));

    unwireOpencode();

    const parsed = parseJsoncLoose(readConfig());
    expect(parsed.theme).toBe('light');
    expect(parsed.provider).toBeUndefined();
  });

  it('refuses a non-loopback router URL and writes nothing', () => {
    expect(() => wireOpencode('http://10.0.0.5:8000')).toThrow(/loopback/);
    expect(() => wireOpencode('https://api.regolo.ai')).toThrow(/loopback/);
    expect(() => wireOpencode('not a url')).toThrow(/invalid router URL/);

    expect(existsSync(opencodeConfigPath())).toBe(false);
    expect(readOpencodeWiring()).toBeNull();
    expect(listFiles(home)).toEqual([]);
  });

  it('writes only opencode.json and the wiring state file', () => {
    writeConfig(SAMPLE);
    wireOpencode('http://127.0.0.1:8000');

    expect(listFiles(home)).toEqual([
      '.brick/profiles/opencode/runtime/harness.json',
      '.config/opencode/opencode.json',
    ]);

    unwireOpencode();
    expect(listFiles(home)).toEqual([
      '.brick/profiles/opencode/runtime/harness.json',
      '.config/opencode/opencode.json',
    ]);
  });

  it('does not write outside the config when the URL is refused after an existing file', () => {
    writeConfig(SAMPLE);
    expect(() => wireOpencode('http://192.168.1.10:8000')).toThrow(/loopback/);
    expect(readConfig()).toBe(SAMPLE);
    expect(listFiles(home)).toEqual(['.config/opencode/opencode.json']);
  });

  it('strips a managed block without touching neighbouring text', () => {
    const wired = `{
  "a": 1,
  // >>> brick opencode managed provider (do not edit) >>>
  "brick": { "x": 1 }
  // <<< brick opencode managed provider <<<
}
`;
    expect(stripManagedBlock(wired)).toBe('{\n  "a": 1\n}\n');
    expect(stripManagedBlock('{\n  "a": 1\n}\n')).toBe('{\n  "a": 1\n}\n');
  });

  it('round-trips the wiring state file', () => {
    const state = {
      wired: true as const,
      baseUrl: 'http://127.0.0.1:8000',
      configPath: opencodeConfigPath(),
      previousProviderRaw: null,
      createdFile: true,
      models: ['brick'],
    };
    writeOpencodeWiring(state);
    expect(readOpencodeWiring()).toEqual(state);
    clearOpencodeWiring();
    expect(readOpencodeWiring()).toBeNull();
  });

  it('reserves the opencode profile name', () => {
    expect(RESERVED_PROFILES.has('opencode')).toBe(true);
    expect(() => validateProfileName('opencode')).toThrow(/reserved/);
    expect(validateProfileName('opencode', { allowReserved: true })).toBe('opencode');
  });
});
