import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

async function statePath(): Promise<string> {
  return join(home, 'profiles', 'test', 'runtime', 'pricing-watch.json');
}

async function writeState(body: unknown): Promise<void> {
  const path = await statePath();
  await mkdir(join(home, 'profiles', 'test', 'runtime'), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(body));
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'brick-watch-'));
  process.env.BRICK_HOME = home;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.BRICK_HOME;
  vi.resetModules();
});

describe('pricingWatcherStatus', () => {
  it('reports a live watcher', async () => {
    const { pricingWatcherStatus } = await import('./watch.js');
    await writeState({ pid: process.pid, instance: 'i', profile: 'test', started_at: new Date().toISOString() });
    const state = await pricingWatcherStatus('test');
    expect(state?.pid).toBe(process.pid);
  });

  it('ignores a state file whose process is gone', async () => {
    const { pricingWatcherStatus } = await import('./watch.js');
    await writeState({ pid: 999_999, instance: 'i', profile: 'test', started_at: new Date().toISOString() });
    expect(await pricingWatcherStatus('test')).toBeNull();
  });

  it('returns null when no state file exists', async () => {
    const { pricingWatcherStatus } = await import('./watch.js');
    expect(await pricingWatcherStatus('test')).toBeNull();
  });
});
