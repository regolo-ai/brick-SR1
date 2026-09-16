import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
afterEach(() => { delete process.env.BRICK_HOME; vi.resetModules(); });
it('migrates the single-profile layout with prices, credentials and usage history intact', async () => {
  const home = await mkdtemp(join(tmpdir(), 'brick-layout-'));
  process.env.BRICK_HOME = home;
  vi.resetModules();
  const { migrateLegacyLayout } = await import('./migrate.js');
  const files = { 'config.yaml': 'default_model: test\n', '.env': 'KEY=secret\n', 'pricing.yaml': 'custom: prices\n', 'call_history.jsonl': '{"history":true}\n', 'routing_events.jsonl': '{"routing":true}\n', 'economics_snapshot.json': '{"cost":42}' };
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(join(home, name), text);
    expect((await migrateLegacyLayout()).migrated).toBe(true);
    for (const [name, text] of Object.entries(files)) {
      expect(await readFile(join(home, 'profiles/default', name), 'utf8')).toBe(text);
      expect(await readFile(join(home, name), 'utf8')).toBe(text);
    }
    expect((await migrateLegacyLayout()).migrated).toBe(false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
