import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  wireCodex,
  unwireCodex,
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
  it('wires an absent config (creates file, sets profile, adds block)', () => {
    const res = wireCodex('http://localhost:8000');
    expect(res.createdFile).toBe(true);
    expect(res.previousProfile).toBeNull();

    const text = readCodexConfig();
    expect(existsSync(codexConfigPath())).toBe(true);
    expect(getTopLevelProfile(text)).toBe('brick');
    expect(isWired(text)).toBe(true);
    expect(text).toContain('wire_api = "chat"');
    expect(text).toContain('base_url = "http://localhost:8000/v1"');
    expect(text).toContain('[profiles.brick]');
  });

  it('captures and restores a prior top-level profile', () => {
    writeFileSync(
      codexConfigPath(),
      'profile = "default"\nmodel = "gpt-5.4"\n\n[profiles.default]\nmodel = "gpt-5.4"\n'
    );
    const res = wireCodex('http://localhost:8000');
    expect(res.createdFile).toBe(false);
    expect(res.previousProfile).toBe('default');
    expect(getTopLevelProfile(readCodexConfig())).toBe('brick');

    unwireCodex(res.previousProfile);
    const after = readCodexConfig();
    expect(getTopLevelProfile(after)).toBe('default');
    expect(isWired(after)).toBe(false);
    // pre-existing user content preserved
    expect(after).toContain('[profiles.default]');
    expect(after).toContain('model = "gpt-5.4"');
  });

  it('is idempotent (re-wiring leaves a single managed block)', () => {
    wireCodex('http://localhost:8000');
    wireCodex('http://localhost:8000');
    const text = readCodexConfig();
    const occurrences = text.split('[model_providers.brick]').length - 1;
    expect(occurrences).toBe(1);
    expect(getTopLevelProfile(text)).toBe('brick');
  });

  it('off on a config with no prior profile removes the brick block and the profile line', () => {
    const res = wireCodex('http://localhost:8000');
    unwireCodex(res.previousProfile);
    const after = readCodexConfig();
    expect(isWired(after)).toBe(false);
    expect(getTopLevelProfile(after)).toBeNull();
  });
});
