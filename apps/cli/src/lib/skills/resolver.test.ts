import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { InvalidRemoteSkillTableError, loadSkillTable, resolveSkillCards, skillTableCachePath } from './resolver.js';

describe('CSV skill-card resolver', () => {
  it('parses the Hugging Face single-file format', async () => {
    const csv = [
      'model,coding,creative_synthesis,instruction_following,math_reasoning,planning_agentic,world_knowledge',
      'csv-model,0.8,0.7,0.6,0.5,0.4,0.3',
    ].join('\n');
    const cards = await resolveSkillCards(['csv-model'], {
      refresh: true,
      cacheDir: '/tmp/brick-csv-resolver-test',
      fetchImpl: async () => new Response(csv),
    });

    const card = cards.get('csv-model');
    expect(card?.model).toBe('csv-model');
    expect(card?.skill_vector).toEqual([0.8, 0.7, 0.6, 0.5, 0.4, 0.3]);
    expect(Object.keys(card ?? {})).toEqual(['model', 'skill_vector']);
  });

  it('falls back to an indefinitely old valid cache and warns with its date', async () => {
    const dir = join(tmpdir(), `brick-cache-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(skillTableCachePath(dir), `${['model','coding','creative_synthesis','instruction_following','math_reasoning','planning_agentic','world_knowledge'].join(',')}\n${'cached,0.1,0.2,0.3,0.4,0.5,0.6'}\n`);
    const warning = vi.fn();
    const table = await loadSkillTable({ cacheDir: dir, fetchImpl: vi.fn(async () => { throw new Error('offline'); }) as any, warn: warning });
    expect(table.has('cached')).toBe(true); expect(warning.mock.calls[0][0]).toMatch(/cached skill table from .*Z/);
  });

  it('never falls back when the remote CSV is semantically invalid', async () => {
    const dir = join(tmpdir(), `brick-invalid-${process.pid}-${Date.now()}`); await mkdir(dir, { recursive: true });
    await writeFile(skillTableCachePath(dir), `model,coding,creative_synthesis,instruction_following,math_reasoning,planning_agentic,world_knowledge\ncached,0.1,0.2,0.3,0.4,0.5,0.6\n`);
    await expect(loadSkillTable({ cacheDir: dir, fetchImpl: async () => new Response('bad,header\nx,y') })).rejects.toBeInstanceOf(InvalidRemoteSkillTableError);
  });

  it('writes the batch cache with mode 0600', async () => {
    const dir = join(tmpdir(), `brick-mode-${process.pid}-${Date.now()}`);
    const csv = `model,coding,creative_synthesis,instruction_following,math_reasoning,planning_agentic,world_knowledge\none,0.1,0.2,0.3,0.4,0.5,0.6\n`;
    await loadSkillTable({ cacheDir: dir, fetchImpl: async () => new Response(csv) });
    expect((await stat(skillTableCachePath(dir))).mode & 0o777).toBe(0o600);
  });
});
