import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  wireCodex,
  unwireCodex,
  getTopLevelModel,
  getTopLevelModelProvider,
  getTopLevelProfile,
  isWired,
  readCodexConfig,
  codexConfigPath,
} from './config-toml.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brick-codex-'));
  process.env.CODEX_HOME = dir;
});

afterEach(() => {
  delete process.env.CODEX_HOME;
  rmSync(dir, { recursive: true, force: true });
});

describe('codex config.toml wiring', () => {
  it('wires an absent config with top-level model/provider and a managed provider block', () => {
    const res = wireCodex('http://localhost:8000');
    expect(res.createdFile).toBe(true);
    expect(res.previousModel).toBeNull();
    expect(res.previousModelProvider).toBeNull();

    const text = readCodexConfig();
    expect(existsSync(codexConfigPath())).toBe(true);
    expect(getTopLevelModel(text)).toBe('brick');
    expect(getTopLevelModelProvider(text)).toBe('brick');
    expect(getTopLevelProfile(text)).toBeNull();
    expect(isWired(text)).toBe(true);
    expect(text).toContain('wire_api = "chat"');
    expect(text).toContain('requires_openai_auth = true');
    expect(text).toContain('base_url = "http://localhost:8000/v1"');
    expect(text).not.toContain('[profiles.brick]');
  });

  it('captures and restores prior top-level model/provider values', () => {
    writeFileSync(
      codexConfigPath(),
      'model = "gpt-5.4"\nmodel_provider = "openai"\n\n[history]\npersistence = "save-all"\n'
    );
    const res = wireCodex('http://localhost:8000');
    expect(res.createdFile).toBe(false);
    expect(res.previousModel).toBe('gpt-5.4');
    expect(res.previousModelProvider).toBe('openai');
    expect(getTopLevelModel(readCodexConfig())).toBe('brick');
    expect(getTopLevelModelProvider(readCodexConfig())).toBe('brick');

    unwireCodex(res);
    const after = readCodexConfig();
    expect(getTopLevelModel(after)).toBe('gpt-5.4');
    expect(getTopLevelModelProvider(after)).toBe('openai');
    expect(isWired(after)).toBe(false);
    expect(after).toContain('[history]');
  });

  it('cleans up legacy top-level profile = brick without restoring it', () => {
    writeFileSync(codexConfigPath(), 'profile = "brick"\nmodel = "gpt-5.4"\nmodel_provider = "openai"\n');
    const res = wireCodex('http://localhost:8000');
    expect(getTopLevelProfile(readCodexConfig())).toBeNull();

    unwireCodex(res);
    const after = readCodexConfig();
    expect(getTopLevelProfile(after)).toBeNull();
    expect(getTopLevelModel(after)).toBe('gpt-5.4');
    expect(getTopLevelModelProvider(after)).toBe('openai');
  });

  it('preserves a non-brick top-level profile while wiring modern keys', () => {
    writeFileSync(codexConfigPath(), 'profile = "default"\nmodel = "gpt-5.4"\nmodel_provider = "openai"\n');
    const res = wireCodex('http://localhost:8000');
    expect(getTopLevelProfile(readCodexConfig())).toBe('default');

    unwireCodex(res);
    const after = readCodexConfig();
    expect(getTopLevelProfile(after)).toBe('default');
    expect(getTopLevelModel(after)).toBe('gpt-5.4');
    expect(getTopLevelModelProvider(after)).toBe('openai');
  });

  it('is idempotent and leaves a single managed provider block', () => {
    wireCodex('http://localhost:8000');
    wireCodex('http://localhost:8000');
    const text = readCodexConfig();
    const occurrences = text.split('[model_providers.brick]').length - 1;
    expect(occurrences).toBe(1);
    expect(getTopLevelModel(text)).toBe('brick');
    expect(getTopLevelModelProvider(text)).toBe('brick');
  });

  it('off on a config with no prior model/provider removes the brick keys and block', () => {
    const res = wireCodex('http://localhost:8000');
    unwireCodex(res);
    const after = readCodexConfig();
    expect(isWired(after)).toBe(false);
    expect(getTopLevelModel(after)).toBeNull();
    expect(getTopLevelModelProvider(after)).toBeNull();
  });

  it('refuses to overwrite an unmanaged brick provider table', () => {
    writeFileSync(codexConfigPath(), '[model_providers.brick]\nbase_url = "http://example.test/v1"\n');
    expect(() => wireCodex('http://localhost:8000')).toThrow(/unmanaged \[model_providers\.brick\]/);
  });
});
