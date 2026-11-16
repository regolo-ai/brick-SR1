import { describe, expect, it } from 'vitest';
import { mergePricing } from './merge.js';
import { SOURCE_OPENROUTER, SOURCE_REGOLO, type PricingEntry, type SyncedSnapshot } from './table.js';

function row(overrides: Partial<PricingEntry> = {}): PricingEntry {
  return {
    provider: 'openai',
    model: 'gpt-6.1-terra',
    input_price: 1,
    output_price: 5,
    currency: 'USD',
    source: SOURCE_OPENROUTER,
    source_url: 'https://openrouter.ai/api/v1/models',
    fetched_at: '2026-11-03T00:00:00.000Z',
    ...overrides,
  };
}

const lastSynced = (entry: PricingEntry): Record<string, SyncedSnapshot> => ({
  [entry.model]: { input_price: entry.input_price, output_price: entry.output_price, currency: entry.currency },
});

describe('mergePricing', () => {
  it('adds models that are not in the table yet', () => {
    const result = mergePricing([], [row()]);
    expect(result.rows).toHaveLength(1);
    expect(result.added).toEqual(['gpt-6.1-terra']);
    expect(result.kept).toEqual([]);
  });

  it('refreshes a row it wrote itself', () => {
    const existing = row();
    const result = mergePricing([existing], [row({ input_price: 2, output_price: 8 })], lastSynced(existing));
    expect(result.updated).toEqual(['gpt-6.1-terra']);
    expect(result.rows[0].input_price).toBe(2);
    expect(result.rows[0].output_price).toBe(8);
  });

  it('never overwrites a price the user edited by hand', () => {
    const written = row();
    const edited = row({ input_price: 42 });
    const result = mergePricing([edited], [row({ input_price: 2 })], lastSynced(written));
    expect(result.updated).toEqual([]);
    expect(result.kept).toEqual(['gpt-6.1-terra']);
    expect(result.rows[0].input_price).toBe(42);
  });

  it('never touches rows written by an older release or another tool', () => {
    const legacy = row({ source: 'static_curated', input_price: 1.11 });
    const result = mergePricing([legacy], [row({ input_price: 2 })], lastSynced(legacy));
    expect(result.updated).toEqual([]);
    expect(result.rows[0].input_price).toBe(1.11);
    expect(result.rows[0].source).toBe('static_curated');
  });

  it('does not rewrite a row when the price is unchanged', () => {
    const existing = row();
    const result = mergePricing([existing], [row()], lastSynced(existing));
    expect(result.updated).toEqual([]);
    expect(result.kept).toEqual([]);
  });

  it('keeps unrelated rows intact', () => {
    const glm: PricingEntry = row({ model: 'glm5.2', provider: 'regolo', source: SOURCE_REGOLO, input_price: 2.24 });
    const result = mergePricing([glm], [row()]);
    expect(result.rows.map((entry) => entry.model)).toEqual(['glm5.2', 'gpt-6.1-terra']);
  });

  it('migrates a row that is still an untouched copy of the shipped seed', () => {
    const legacy: PricingEntry = row({
      model: 'qwen3.5-122b', provider: 'regolo', source: 'static_curated', currency: 'EUR', input_price: 1, output_price: 4.2,
    });
    const converted: PricingEntry = row({
      model: 'qwen3.5-122b', provider: 'regolo', source: SOURCE_REGOLO, currency: 'USD', input_price: 1.1216, output_price: 4.7112,
    });
    const adopted = mergePricing([legacy], [converted], {}, new Set(['qwen3.5-122b']));
    expect(adopted.updated).toEqual(['qwen3.5-122b']);
    expect(adopted.rows[0].currency).toBe('USD');

    // The same row, but edited by hand, is out of the adopt set and survives.
    const edited = mergePricing([{ ...legacy, input_price: 3 }], [converted], {}, new Set());
    expect(edited.kept).toEqual(['qwen3.5-122b']);
    expect(edited.rows[0].input_price).toBe(3);
  });
});
