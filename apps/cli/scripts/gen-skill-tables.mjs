// Generator for the seed public skill tables (templates/skill-tables/*.json).
// Single source of truth for the frontier benchmark-derived vectors. Re-run with
//   node scripts/gen-skill-tables.mjs
// after editing the SEED table below. Output files are committed and ship with
// the CLI (templates/ is in package.json "files"), and mirror HF
// regolo/brick-skill-tables.
//
// Capability order is canonical and must never be reordered:
//   [coding, creative_synthesis, instruction_following, math_reasoning,
//    planning_agentic, world_knowledge]
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CAPABILITIES = [
  'coding',
  'creative_synthesis',
  'instruction_following',
  'math_reasoning',
  'planning_agentic',
  'world_knowledge',
];

const DATE = '2026-06-11';
const C = (...a) => a; // confidence array helper

// vector: 6 numbers in CAPABILITIES order. confidence: 6 of high|medium|low.
// imputed: indices whose value was filled from the model mean (NA in public
// benchmarks) — always low confidence, documented in README.
const SEED = [
  // ---- Anthropic ----
  { model: 'claude-opus-4-8',  provider: 'anthropic', vector: [0.89, 0.91, 0.84, 0.94, 0.84, 0.94], confidence: C('high','medium','medium','high','high','high'), imputed: [] },
  { model: 'claude-sonnet-4-6', provider: 'anthropic', vector: [0.80, 0.85, 0.82, 0.89, 0.72, 0.88], confidence: C('high','medium','medium','high','medium','high'), imputed: [] },
  { model: 'claude-haiku-4-5', provider: 'anthropic', vector: [0.73, 0.65, 0.70, 0.81, 0.50, 0.77], confidence: C('medium','low','medium','high','medium','medium'), imputed: [] },

  // ---- OpenAI ---- (creative_synthesis frequently NA in public OpenAI
  // benchmarks -> imputed from model mean, confidence low. GPT-5.6's launch
  // suite is deliberately agentic: no public AIME/GPQA/IFEval, so math/world/
  // instruction are anchored to the composite intelligence index, confidence
  // medium; coding + planning_agentic have direct agentic benchmarks.)
  { model: 'gpt-5.6-sol',   provider: 'openai', vector: [0.90, 0.91, 0.86, 0.94, 0.92, 0.94], confidence: C('high','low','medium','medium','high','medium'), imputed: [1] },
  { model: 'gpt-5.6-terra', provider: 'openai', vector: [0.85, 0.85, 0.80, 0.88, 0.86, 0.88], confidence: C('high','low','medium','medium','high','medium'), imputed: [1] },
  { model: 'gpt-5.6-luna',  provider: 'openai', vector: [0.80, 0.80, 0.75, 0.82, 0.83, 0.82], confidence: C('high','low','medium','medium','high','medium'), imputed: [1] },
  { model: 'gpt-5.5',      provider: 'openai', vector: [0.89, 0.65, 0.71, 0.92, 0.83, 0.94], confidence: C('high','low','medium','high','medium','high'), imputed: [] },
  { model: 'gpt-5.4',      provider: 'openai', vector: [0.77, 0.50, 0.68, 0.88, 0.75, 0.90], confidence: C('medium','low','medium','high','medium','high'), imputed: [] },
  { model: 'gpt-5.4-mini', provider: 'openai', vector: [0.34, 0.40, 0.65, 0.65, 0.55, 0.75], confidence: C('medium','low','medium','medium','low','medium'), imputed: [] },
  { model: 'o3',           provider: 'openai', vector: [0.72, 0.50, 0.60, 0.97, 0.72, 0.88], confidence: C('high','low','low','high','medium','medium'), imputed: [] },
  { model: 'o3-mini',      provider: 'openai', vector: [0.49, 0.45, 0.58, 0.87, 0.68, 0.80], confidence: C('medium','low','low','high','medium','medium'), imputed: [] },

  // ---- Google ---- (instruction_following / planning_agentic frequently NA in
  // public Gemini benchmarks -> imputed from model mean, confidence low)
  { model: 'gemini-3.1-pro',        provider: 'google', vector: [0.81, 0.75, 0.86, 0.94, 0.82, 0.96], confidence: C('high','low','low','high','medium','high'), imputed: [2] },
  { model: 'gemini-3.5-flash',      provider: 'google', vector: [0.79, 0.70, 0.83, 0.93, 0.83, 0.89], confidence: C('medium','low','low','high','low','high'), imputed: [2, 4] },
  { model: 'gemini-3.1-flash-lite', provider: 'google', vector: [0.72, 0.65, 0.78, 0.87, 0.78, 0.87], confidence: C('high','low','low','high','low','high'), imputed: [2, 4] },
  { model: 'gemini-2.5-pro',        provider: 'google', vector: [0.64, 0.72, 0.78, 0.89, 0.78, 0.88], confidence: C('high','low','low','high','low','high'), imputed: [2, 4] },
];

function recordFor(s) {
  return {
    model: s.model,
    provider: s.provider,
    capabilities: CAPABILITIES,
    skill_vector: s.vector,
    source: 'benchmark',
    confidence: s.confidence,
    imputed_capabilities: s.imputed.map((i) => CAPABILITIES[i]),
    support: null, // benchmark-derived: no per-question correct/total counts
    subset_hash: null, // set only by `brick skills extract` (measured source)
    date: DATE,
    notes:
      'Derived from published AI-lab benchmarks (SWE-bench, AIME, GPQA, MMLU-Pro, tau-bench, etc.), ' +
      'normalized to [0,1] and mapped onto the 6 capabilities. Cold-start prior: a `measured` ' +
      'extraction on the frozen probe set overrides this. See README.md.',
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'templates', 'skill-tables');

await mkdir(outDir, { recursive: true });
const index = [];
for (const s of SEED) {
  const rec = recordFor(s);
  const fname = `${s.model.replace(/[/\\]/g, '_')}.json`;
  await writeFile(join(outDir, fname), JSON.stringify(rec, null, 2) + '\n');
  index.push({ model: rec.model, provider: rec.provider, file: fname, source: rec.source });
}
await writeFile(
  join(outDir, 'index.json'),
  JSON.stringify({ capabilities: CAPABILITIES, date: DATE, models: index }, null, 2) + '\n'
);
console.log(`wrote ${SEED.length} skill tables + index.json to ${outDir}`);
