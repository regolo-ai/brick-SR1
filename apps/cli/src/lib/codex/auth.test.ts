import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexAuthMode, usesChatGPTSubscriptionAuth } from './auth.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brick-codex-auth-'));
  process.env.CODEX_HOME = dir;
});

afterEach(() => {
  delete process.env.CODEX_HOME;
  rmSync(dir, { recursive: true, force: true });
});

describe('Codex authentication mode', () => {
  it('detects ChatGPT subscription authentication without inspecting tokens', () => {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'secret' } }),
    );

    expect(readCodexAuthMode()).toBe('chatgpt');
    expect(usesChatGPTSubscriptionAuth()).toBe(true);
  });

  it('allows API-key authentication', () => {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'api' }));

    expect(readCodexAuthMode()).toBe('api');
    expect(usesChatGPTSubscriptionAuth()).toBe(false);
  });

  it('treats missing or malformed auth state as unknown', () => {
    expect(readCodexAuthMode()).toBeNull();
    writeFileSync(join(dir, 'auth.json'), '{broken');
    expect(readCodexAuthMode()).toBeNull();
  });
});
