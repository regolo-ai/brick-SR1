#!/usr/bin/env node
// Onboarding validation harness: simulated personas exercise the four routing
// levers (model pool, skill table, mode/difficulty knob, keyword override) and
// assert the router actually obeys each one.
//
// Builds the Go router with CGO_ENABLED=0 (mock candle classifier) and drives
// it with --route-test, so no GPU, no model downloads, no live ports.
//
//   node scripts/validate-onboarding.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTER_DIR = join(__dirname, '..', '..', 'router', 'src', 'spatial-router');

const work = mkdtempSync(join(tmpdir(), 'brick-onboarding-'));
const BIN = join(work, 'router');

console.log('building Go router (CGO_ENABLED=0, mock classifiers)...');
execFileSync('go', ['build', '-o', BIN, './cmd/'], {
  cwd: ROUTER_DIR,
  env: { ...process.env, CGO_ENABLED: '0' },
  stdio: ['ignore', 'inherit', 'inherit'],
});

// Base config: 3-model pool with paper skill vectors (projected on the 2 dims
// the mock capability classifier emits: [0.95, 0.05]) and paper cost weights.
function makeConfig({ r = 0, keywordRules = [] } = {}) {
  const rules = keywordRules
    .map(
      (k) => `
    - name: ${k.name}
      mode: override
      importance: 10
      model: ${k.model}
      operator: OR
      keywords: [${k.keywords.map((w) => JSON.stringify(w)).join(', ')}]
      case_sensitive: false`
    )
    .join('');
  return `
model:
  name: brick-onboarding
  description: onboarding validation harness
server_port: 8123
default_model: qwen
providers:
  local:
    type: openai_compatible
    base_url: http://127.0.0.1:9999/v1
provider_profiles:
  local:
    type: openai_compatible
    base_url: http://127.0.0.1:9999/v1
provider_endpoints:
  - name: local
    provider_profile: local
    weight: 1
model_config:
  qwen: { preferred_endpoints: [local], param_size: 9b }
  ds4: { preferred_endpoints: [local], param_size: 30b }
  kimi: { preferred_endpoints: [local], param_size: 1t }
skill_router:
  enabled: true
  capabilities: [coding, other]
  capability_model:
    model_id: mock
    labels: [coding, other]
    use_cpu: true
  complexity_model:
    base_url: http://127.0.0.1:1
    timeout_seconds: 1
  math:
    routing_preference: ${r}
  models:
    - model: qwen
      skill_vector: [0.714788, 0.179876]
      cost_weight: 0.10
    - model: ds4
      skill_vector: [0.820939, 0.488518]
      cost_weight: 0.40
    - model: kimi
      skill_vector: [0.904272, 0.344074]
      cost_weight: 0.60${
        rules
          ? `
  keyword_rules:${rules}`
          : ''
      }
decisions: []
`;
}

function routeTest(configYaml, message, candidates) {
  const cfgPath = join(work, 'config.yaml');
  writeFileSync(cfgPath, configYaml);
  const args = ['--config', cfgPath, '--route-test', message];
  if (candidates && candidates.length) args.push('--route-candidates', candidates.join(','));
  const out = execFileSync(BIN, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const jsonStart = out.indexOf('\n{');
  return JSON.parse(out.slice(jsonStart + 1));
}

// Personas: each one is (description, config, query, assertion).
const PERSONAS = [
  {
    name: 'eco (mode lever, r=-1)',
    config: makeConfig({ r: -1 }),
    query: 'Implement a lock-free concurrent hash map in Rust with hazard pointers',
    check: (res) => res.Model === 'qwen' && res.Reason === 'skill_vector',
    expects: 'cheapest model even on a hard query',
  },
  {
    name: 'quality (mode lever, r=+1)',
    config: makeConfig({ r: 1 }),
    query: 'What is 2+2?',
    check: (res) => res.Model === 'kimi' && res.Reason === 'skill_vector',
    expects: 'strongest model even on a trivial query',
  },
  {
    name: 'balanced (mode lever, r=0)',
    config: makeConfig({ r: 0 }),
    query: 'Write a binary search in Python',
    check: (res) => res.Model === 'ds4' && res.Reason === 'skill_vector',
    expects: 'mid model at the locked default operating point',
  },
  {
    name: 'keyword-heavy (override lever)',
    config: makeConfig({ r: -1, keywordRules: [{ name: 'force_top', model: 'kimi', keywords: ['theorem'] }] }),
    query: 'Prove the theorem that every finite group of prime order is cyclic',
    check: (res) => res.Model === 'kimi' && res.Reason === 'keyword_override',
    expects: 'keyword forces the top model even in eco mode',
  },
  {
    name: 'skill-driven (skill table lever)',
    // same pool as 'balanced' (which selects ds4), but the user downgrades
    // ds4's coding skill after observing bad results on their domain: routing
    // must move away from ds4. (Boosting a model instead would correctly be
    // resisted by the asymmetric over-capacity penalty.)
    config: makeConfig({ r: 0 }).replace('skill_vector: [0.820939, 0.488518]', 'skill_vector: [0.30, 0.30]'),
    query: 'Write a binary search in Python',
    check: (res) => res.Model !== 'ds4' && res.Reason === 'skill_vector',
    expects: 'downgrading a model in the skill table moves routing off it',
  },
  {
    name: 'image input (multimodal passthrough lever)',
    // balanced pool (which selects ds4 on this hard query), but the request
    // carries a raw image and only qwen is flagged handles_images. The brick
    // gateway restricts routing to the image-capable set, so selection must
    // collapse onto qwen even though ds4 would otherwise win.
    config: makeConfig({ r: 0 }),
    query: 'Implement a lock-free concurrent hash map in Rust with hazard pointers',
    candidates: ['qwen'],
    check: (res) => res.Model === 'qwen' && res.Reason === 'skill_vector',
    expects: 'raw image restricts routing to image-capable models',
  },
];

let failed = 0;
for (const p of PERSONAS) {
  let res;
  try {
    res = routeTest(p.config, p.query, p.candidates);
  } catch (e) {
    console.log(`✗ ${p.name}: route-test crashed: ${e.message}`);
    failed++;
    continue;
  }
  const ok = p.check(res);
  console.log(`${ok ? '✓' : '✗'} ${p.name}: selected=${res.Model} reason=${res.Reason} (${p.expects})`);
  if (!ok) failed++;
}

rmSync(work, { recursive: true, force: true });
if (failed > 0) {
  console.error(`\n${failed} persona check(s) FAILED`);
  process.exit(1);
}
console.log('\nall onboarding levers verified.');
