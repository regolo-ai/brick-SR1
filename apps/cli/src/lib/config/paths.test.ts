import { afterEach, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
afterEach(() => { delete process.env.BRICK_HOME; vi.resetModules(); });
it('resolves relative storage roots and rejects paths outside a named profile', async () => {
  process.env.BRICK_HOME = 'relative-brick-home';
  vi.resetModules();
  const { paths } = await import('./paths.js');
  expect(paths('work').profileDir).toBe(resolve('relative-brick-home/profiles/work'));
  for (const invalid of ['..', '../work', '/tmp/work', '', 'work/../../other']) expect(() => paths(invalid)).toThrow('invalid profile name');
  expect(paths('codex').profile).toBe('codex');
});
