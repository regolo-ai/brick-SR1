// Anthropic API list prices for the Brick Claude pool, used only to weight the
// relative-savings estimate shown in `brick claude status`. NOT a billing source.
//
// USD per 1M tokens (input, output), verified June 2026.
// Source: https://platform.claude.com/docs/en/about-claude/pricing
//
// IMPORTANT: the Prometheus metric brick_cc_requests_total only exposes request
// COUNTS per model, not real token usage (the proxy streams responses through
// without parsing `usage`). So the savings figure is a RELATIVE estimate: it
// assumes a comparable average token volume per request across models and weighs
// each request by a blended per-request price. It is deliberately labelled as an
// estimate in the UI and must not be presented as an exact dollar amount.

export type Price = { in: number; out: number };

// Matched by prefix so version bumps (sonnet-4-6 -> 4-7) don't need a new entry.
export const MODEL_PRICE: Array<[string, Price]> = [
  ['claude-haiku', { in: 1, out: 5 }],
  ['claude-sonnet', { in: 3, out: 15 }],
  ['claude-opus', { in: 5, out: 25 }],
];

// Coding traffic skews toward output; blend input/output 1:3 to get a single
// per-request weight. Same ratio for every model so the comparison is apples to
// apples (only the price tier differs).
const IN_WEIGHT = 0.25;
const OUT_WEIGHT = 0.75;

function blend(p: Price): number {
  return p.in * IN_WEIGHT + p.out * OUT_WEIGHT;
}

export function priceForModel(model: string): Price {
  for (const [prefix, price] of MODEL_PRICE) {
    if (model.startsWith(prefix)) return price;
  }
  // Unknown model: treat as opus (most expensive) so savings are never overstated.
  return { in: 5, out: 25 };
}

// Relative per-request cost weight for a model (blended USD/1M, unitless here
// since it cancels in the ratio against the opus baseline).
export function blendedPricePerReq(model: string): number {
  return blend(priceForModel(model));
}

// Baseline: the blended per-request weight if every request had gone to opus.
export const OPUS_BLENDED = blend({ in: 5, out: 25 });
