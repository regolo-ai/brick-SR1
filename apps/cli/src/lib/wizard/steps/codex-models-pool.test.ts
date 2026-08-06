import { describe, expect, it } from 'vitest';
import { codexModelCatalog } from './codex-models-pool.js';

describe('Codex model catalog', () => {
  it('starts with only the GPT-5.6 starter pool', () => {
    expect(codexModelCatalog().map((model) => model.value)).toEqual([
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'gpt-5.6-sol',
    ]);
  });
});
