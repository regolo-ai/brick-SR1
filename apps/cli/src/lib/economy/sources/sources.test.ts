import { describe, expect, it } from 'vitest';
import { parseOpenRouterModels, resolveOpenRouterId } from './openrouter.js';
import { parseRegoloPricing } from './regolo.js';

const REGOLO_HTML = `
<div class="grid" style="grid-template-columns: repeat(4, minmax(0,1fr));">
  <div class="h">Model</div><div class="h">Input cost per 1M tokens</div><div class="h">Output cost per 1M tokens</div><div class="h">Plans</div>
</div>
<div class="grid hover:bg-white/5 transition-colors" style="grid-template-columns: repeat(4, minmax(0,1fr));">
  <div class="px-3">glm5.2</div><div class="px-3">€2.00</div><div class="px-3">€5.20</div><div class="px-3">Included</div>
</div>
<div class="grid hover:bg-white/5 transition-colors" style="grid-template-columns: repeat(4, minmax(0,1fr));">
  <div class="px-3">qwen3.5-9b</div><div class="px-3">€0.07</div><div class="px-3">€0.35</div><div class="px-3">Included</div>
</div>
<div class="grid hover:bg-white/5 transition-colors" style="grid-template-columns: repeat(4, minmax(0,1fr));">
  <div class="px-3">broken</div><div class="px-3">call us</div><div class="px-3">call us</div><div class="px-3">Included</div>
</div>`;

describe('parseRegoloPricing', () => {
  it('reads the model rows and ignores headers and unparseable prices', () => {
    const prices = parseRegoloPricing(REGOLO_HTML);
    expect([...prices.keys()]).toEqual(['glm5.2', 'qwen3.5-9b']);
    expect(prices.get('glm5.2')).toEqual({ input: 2, output: 5.2 });
    expect(prices.get('qwen3.5-9b')).toEqual({ input: 0.07, output: 0.35 });
  });

  it('returns an empty map when the markup changes beyond recognition', () => {
    expect(parseRegoloPricing('<html><body>redesign</body></html>').size).toBe(0);
  });
});

describe('parseOpenRouterModels', () => {
  it('normalises per-token USD into per-million USD', () => {
    const prices = parseOpenRouterModels({
      data: [
        { id: 'openai/gpt-6.1-terra', pricing: { prompt: '0.000001', completion: '0.000005', input_cache_read: '0.00000005' } },
        { id: 'unpriced/model', pricing: { prompt: '-1', completion: '-1' } },
      ],
    });
    expect(prices.get('openai/gpt-6.1-terra')).toEqual({ input: 1, output: 5, cached_input: 0.05 });
    expect(prices.has('unpriced/model')).toBe(false);
  });

  it('tolerates a malformed catalogue', () => {
    expect(parseOpenRouterModels({}).size).toBe(0);
    expect(parseOpenRouterModels(null).size).toBe(0);
  });
});

describe('resolveOpenRouterId', () => {
  const ids = ['openai/gpt-6.1-terra', 'openai/gpt-6-luna', 'z-ai/glm-5.2', 'openai/gpt-5.6-sol'];

  it('prefers an explicit alias', () => {
    expect(resolveOpenRouterId('gpt-6.1-terra', ids)).toBe('openai/gpt-6.1-terra');
  });

  it('falls back to a unique suffix match', () => {
    expect(resolveOpenRouterId('gpt-6-luna', ids)).toBe('openai/gpt-6-luna');
    expect(resolveOpenRouterId('gpt-5.6-sol', ids)).toBe('openai/gpt-5.6-sol');
  });

  it('refuses ambiguous or unknown models', () => {
    expect(resolveOpenRouterId('glm5.2', ids)).toBeUndefined();
    expect(resolveOpenRouterId('nope', ids)).toBeUndefined();
    expect(resolveOpenRouterId('gpt-6', ['openai/gpt-6', 'azure/gpt-6'])).toBeUndefined();
  });
});
