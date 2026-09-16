import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const failures = vi.hoisted(() => ({ diskFull: false, renameDenied: false }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<any>();
  return { ...fs,
    writeFile: async (...args: any[]) => {
      if (failures.diskFull && String(args[0]).endsWith('.tmp')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return fs.writeFile(...args);
    },
    rename: async (...args: any[]) => {
      if (failures.renameDenied) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return fs.rename(...args);
    },
  };
});
import { atomicWrite } from './atomic-file.js';
import { upsertEnvValues } from './env-file.js';
describe('atomic profile persistence', () => {
  afterEach(() => { failures.diskFull = false; failures.renameDenied = false; });
  it.each(['diskFull', 'renameDenied'] as const)('preserves previous config after %s', async failure => {
    const dir = await mkdtemp(join(tmpdir(), 'brick-save-'));
    const file = join(dir, 'config.yaml');
    try {
      await writeFile(file, 'previous configuration');
      failures[failure] = true;
      await expect(atomicWrite(file, 'replacement')).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe('previous configuration');
      expect(await readdir(dir)).toEqual(['config.yaml']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('removes duplicate stale credentials and rejects multiline injection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'brick-env-'));
    const file = join(dir, '.env');
    try {
      await writeFile(file, '# preserved\nKEY=old\nOTHER=keep\nKEY=stale\n');
      await upsertEnvValues(file, { KEY: 'new' });
      const saved = await readFile(file, 'utf8');
      expect(saved).toBe('# preserved\nKEY=new\nOTHER=keep\n');
      await expect(upsertEnvValues(file, { KEY: 'secret\nOTHER=changed' })).rejects.toThrow('multiline');
      expect(await readFile(file, 'utf8')).toBe(saved);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
