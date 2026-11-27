import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

const CONFIG = `model_config:
  glm5.2:
    preferred_endpoints: [regolo]
  gpt-6.1-terra:
    preferred_endpoints: [openai-codex]
  gpt-mystery:
    preferred_endpoints: [openai-codex]
`;

function regoloHtml(input = '2.00', output = '5.20'): string {
  // The real table always lists the whole catalogue; the parser refuses a
  // truncated scrape, so the stub mirrors that shape.
  const rows: Array<[string, string, string]> = [
    ['apertus-70b', '0.40', '2.10'],
    ['brick-complexity-pro', '0.10', '0.40'],
    ['brick-v1-beta', '0.00', '0.00'],
    ['gemma4-31b', '0.40', '2.10'],
    ['glm5.2', input, output],
    ['gpt-oss-120b', '1.00', '4.20'],
    ['gpt-oss-20b', '0.10', '0.42'],
    ['mistral-small-4-119b', '0.50', '2.10'],
    ['qwen3.5-122b', '1.00', '4.20'],
    ['qwen3.5-9b', '0.07', '0.35'],
    ['qwen3.8-27b', '0.50', '2.10'],
  ];
  return rows.map(([model, inPrice, outPrice]) => `<div class="grid" style="grid-template-columns: repeat(4, minmax(0,1fr));">
  <div>${model}</div><div>€${inPrice}</div><div>€${outPrice}</div><div>Included</div>
</div>`).join('\n');
}

function fetchStub(regolo = regoloHtml('2.00', '5.20')): typeof fetch {
  return (async (url: string | URL) => {
    const target = String(url);
    if (target.includes('regolo.ai')) return new Response(regolo, { status: 200 });
    if (target.includes('openrouter.ai')) {
      return new Response(JSON.stringify({
        data: [{ id: 'openai/gpt-6.1-terra', pricing: { prompt: '0.000001', completion: '0.000005', input_cache_read: '0.00000005' } }],
      }), { status: 200 });
    }
    if (target.includes('frankfurter')) {
      return new Response(JSON.stringify({ date: '2026-11-02', rates: { USD: 1.2 } }), { status: 200 });
    }
    throw new Error(`unexpected url ${target}`);
  }) as unknown as typeof fetch;
}

async function loadModules() {
  vi.resetModules();
  const [{ syncProfilePricing }, table] = await Promise.all([
    import('./sync.js'),
    import('./table.js'),
  ]);
  return { syncProfilePricing, ...table };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'brick-economy-'));
  process.env.BRICK_HOME = home;
  await mkdir(join(home, 'profiles', 'test'), { recursive: true, mode: 0o700 });
  await writeFile(join(home, 'profiles', 'test', 'config.yaml'), CONFIG);
  await writeFile(join(home, 'profiles', 'test', 'pricing.yaml'), '[]\n');
});

afterEach(() => {
  delete process.env.BRICK_HOME;
  vi.resetModules();
});

const options = (cacheDir: string, fetchImpl: typeof fetch = fetchStub()) => ({
  cacheDir,
  fetchImpl,
  now: () => Date.parse('2026-11-03T00:00:00Z'),
  warn: () => undefined,
});

describe('syncProfilePricing', () => {
  it('writes USD-normalised Regolo prices and OpenRouter prices for the pool only', async () => {
    const { syncProfilePricing, parsePricingYaml } = await loadModules();
    const cache = join(home, 'cache');
    const result = await syncProfilePricing('test', options(cache));
    expect(result.added).toContain('glm5.2');
    expect(result.added).toContain('gpt-6.1-terra');
    expect(result.unpriced).toEqual(['gpt-mystery']);
    expect(result.fx?.rate).toBe(1.2);

    const rows = parsePricingYaml(await readFile(join(home, 'profiles', 'test', 'pricing.yaml'), 'utf8'));
    const glm = rows.find((row) => row.model === 'glm5.2')!;
    expect(glm).toMatchObject({
      input_price: 2.4, output_price: 6.24, currency: 'USD',
      source: 'regolo_scrape', source_currency: 'EUR', source_input_price: 2,
    });
    const terra = rows.find((row) => row.model === 'gpt-6.1-terra')!;
    expect(terra).toMatchObject({ input_price: 1, output_price: 5, cached_input_price: 0.05, currency: 'USD', source: 'openrouter' });
    expect(rows.some((row) => row.model === 'gpt-mystery')).toBe(false);
  });

  it('refreshes the price on the next run', async () => {
    const { syncProfilePricing, parsePricingYaml } = await loadModules();
    const cache = join(home, 'cache');
    await syncProfilePricing('test', options(cache));
    const second = await syncProfilePricing('test', options(cache, fetchStub(regoloHtml('3.00', '6.00'))));
    expect(second.updated).toContain('glm5.2');

    const rows = parsePricingYaml(await readFile(join(home, 'profiles', 'test', 'pricing.yaml'), 'utf8'));
    const glm = rows.find((row) => row.model === 'glm5.2')!;
    expect(glm.input_price).toBe(3.6);
    expect(glm.output_price).toBe(7.2);
  });

  it('leaves a hand-edited price alone', async () => {
    const { syncProfilePricing, parsePricingYaml } = await loadModules();
    const cache = join(home, 'cache');
    await syncProfilePricing('test', options(cache));
    const path = join(home, 'profiles', 'test', 'pricing.yaml');
    const edited = parsePricingYaml(await readFile(path, 'utf8')).map((row) =>
      row.model === 'glm5.2' ? { ...row, input_price: 99 } : row);
    const { dumpPricingYaml } = await loadModules();
    await writeFile(path, dumpPricingYaml(edited));

    const third = await syncProfilePricing('test', options(cache, fetchStub(regoloHtml('3.00', '6.00'))));
    expect(third.kept).toContain('glm5.2');
    const rows = parsePricingYaml(await readFile(path, 'utf8'));
    expect(rows.find((row) => row.model === 'glm5.2')!.input_price).toBe(99);
  });

  it('does not rewrite an unchanged table', async () => {
    const { syncProfilePricing } = await loadModules();
    const cache = join(home, 'cache');
    await syncProfilePricing('test', options(cache));
    const again = await syncProfilePricing('test', options(cache));
    expect(again.written).toBe(false);
    expect(again.added).toEqual([]);
    expect(again.updated).toEqual([]);
  });
});
