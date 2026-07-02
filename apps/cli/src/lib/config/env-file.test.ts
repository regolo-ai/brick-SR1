import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnvValue, upsertEnvValues } from './env-file.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'brick-env-'));
}

describe('upsertEnvValues', () => {
  it('creates a new .env file with the given key', async () => {
    const dir = tmpDir();
    try {
      const env = join(dir, '.env');
      await upsertEnvValues(env, { REGOLO_API_KEY: 'sk-abc' });
      expect(readFileSync(env, 'utf8')).toBe('REGOLO_API_KEY=sk-abc\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces an existing key in place, preserving other lines and comments', async () => {
    const dir = tmpDir();
    try {
      const env = join(dir, '.env');
      writeFileSync(
        env,
        '# a comment\nREGOLO_API_KEY=old\nBRICK_CLASSIFIER_TOKEN=tok123\n',
      );
      await upsertEnvValues(env, { REGOLO_API_KEY: 'new' });
      const out = readFileSync(env, 'utf8');
      expect(out).toContain('# a comment');
      expect(out).toContain('REGOLO_API_KEY=new');
      expect(out).toContain('BRICK_CLASSIFIER_TOKEN=tok123');
      expect(out).not.toContain('REGOLO_API_KEY=old');
      // exactly one REGOLO_API_KEY line
      expect(out.match(/REGOLO_API_KEY=/g)?.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces an empty placeholder value', async () => {
    const dir = tmpDir();
    try {
      const env = join(dir, '.env');
      writeFileSync(env, '# header\nREGOLO_API_KEY=\nOTHER=1\n');
      await upsertEnvValues(env, { REGOLO_API_KEY: 'filled' });
      const out = readFileSync(env, 'utf8');
      expect(out).toContain('REGOLO_API_KEY=filled');
      expect(out).toContain('OTHER=1');
      expect(out.match(/REGOLO_API_KEY=/g)?.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends a new key when the file exists without it', async () => {
    const dir = tmpDir();
    try {
      const env = join(dir, '.env');
      writeFileSync(env, 'EXISTING=1\n');
      await upsertEnvValues(env, { REGOLO_API_KEY: 'sk' });
      const out = readFileSync(env, 'utf8');
      expect(out).toContain('EXISTING=1');
      expect(out).toContain('REGOLO_API_KEY=sk');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readEnvValue', () => {
  it('returns the value of an existing key', async () => {
    const dir = tmpDir();
    try {
      const env = join(dir, '.env');
      writeFileSync(env, 'REGOLO_API_KEY=sk-xyz\n');
      expect(await readEnvValue(env, 'REGOLO_API_KEY')).toBe('sk-xyz');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty string for an empty placeholder', async () => {
    const dir = tmpDir();
    try {
      const env = join(dir, '.env');
      writeFileSync(env, 'REGOLO_API_KEY=\n');
      expect(await readEnvValue(env, 'REGOLO_API_KEY')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a missing key', async () => {
    const dir = tmpDir();
    try {
      const env = join(dir, '.env');
      writeFileSync(env, 'OTHER=1\n');
      expect(await readEnvValue(env, 'REGOLO_API_KEY')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a missing file', async () => {
    const dir = tmpDir();
    try {
      expect(await readEnvValue(join(dir, 'nope.env'), 'REGOLO_API_KEY')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
