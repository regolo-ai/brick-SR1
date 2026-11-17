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

  it('resolves Regolo API ids through the canonical skill-table alias', async () => {
    const csv = [
      'model,coding,creative_synthesis,instruction_following,math_reasoning,planning_agentic,world_knowledge',
      'qwen3.5-122b-a10b,0.70,0.55,0.82,0.82,0.72,0.84',
      'glm-5.2,0.80,0.70,0.74,0.92,0.80,0.88',
    ].join('\n');
    const cards = await resolveSkillCards(['qwen3.5-122b', 'glm5.2'], {
      refresh: true,
      cacheDir: `/tmp/brick-alias-${process.pid}`,
      fetchImpl: async () => new Response(csv),
    });

    expect(cards.get('qwen3.5-122b')?.model).toBe('qwen3.5-122b-a10b');
    expect(cards.get('qwen3.5-122b')?.skill_vector).toEqual([0.70, 0.55, 0.82, 0.82, 0.72, 0.84]);
    expect(cards.get('glm5.2')?.model).toBe('glm-5.2');
  });

  it('falls back to the same-tier Codex vector while the table lags 6.2', async () => {
    const csv = [
      'model,coding,creative_synthesis,instruction_following,math_reasoning,planning_agentic,world_knowledge',
      'gpt-6.1-sol,0.73,0.80,0.5,0.94,0.66,0.86',
      'gpt-6-astra,0.26,0.27,0.5,0.31,0.42,0.65',
    ].join('\n');
    const cards = await resolveSkillCards(['gpt-6.2-sol', 'gpt-6.2-astra'], {
      refresh: true,
      cacheDir: `/tmp/brick-alias-62-${process.pid}`,
      fetchImpl: async () => new Response(csv),
    });

    expect(cards.get('gpt-6.2-sol')?.model).toBe('gpt-6.1-sol');
    expect(cards.get('gpt-6.2-astra')?.model).toBe('gpt-6-astra');
  });

  it('matches provider-cased ids case-insensitively', async () => {
    const csv = [
      'model,coding,creative_synthesis,instruction_following,math_reasoning,planning_agentic,world_knowledge',
      'Llama-3.3-70B-Instruct,0.5,0.5,0.5,0.5,0.5,0.5',
    ].join('\n');
    const cards = await resolveSkillCards(['llama-3.3-70b-instruct'], {
      refresh: true,
      cacheDir: `/tmp/brick-case-${process.pid}`,
      fetchImpl: async () => new Response(csv),
    });
    expect(cards.get('llama-3.3-70b-instruct')?.model).toBe('Llama-3.3-70B-Instruct');
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
