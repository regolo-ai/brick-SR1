import * as p from '@clack/prompts';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths.js';
import { saveConfig } from '../config/save.js';
import { ConfigSchema, type BrickConfig } from '../config/schema.js';
import { catalog, reasoningFamiliesDefault } from '../catalog/index.js';
import { writeCompose } from '../docker/compose.js';
import { lookupSkillRecord } from '../skills/table.js';
import { MODES, R_BY_MODE, type ClaudeMode } from '../claude/modes.js';

export async function runWizard(profile: string): Promise<BrickConfig> {
  const pp = paths(profile);
  p.intro(`brick — guided init (profile: ${profile})`);

  const enabledProvidersRaw = await p.multiselect({
    message: 'Which providers do you want to enable?',
    options: [
      { value: 'regolo', label: 'Regolo AI (default)', hint: 'api.regolo.ai' },
      { value: 'openai', label: 'OpenAI', hint: 'api.openai.com' },
      { value: 'local', label: 'Local OpenAI-compatible', hint: 'custom endpoint' },
    ],
    initialValues: ['regolo'],
    required: true,
  });
  if (p.isCancel(enabledProvidersRaw)) { p.cancel('aborted'); process.exit(0); }
  const enabledProviders = enabledProvidersRaw as string[];

  const apiKeys: Record<string, string> = {};
  const providers: Record<string, any> = {};
  const providerProfiles: Record<string, any> = {};
  const providerEndpoints: any[] = [];
  const modelConfig: Record<string, any> = {};
  let selectedModelIds: string[] = [];

  // initial pass over the providers picked in the multiselect above
  for (const pid of enabledProviders) {
    await ensureProviderAuth(pid, pp, apiKeys, providers, providerProfiles, providerEndpoints);
    await selectProviderModels(pid, modelConfig, selectedModelIds);
  }

  // loop-back: let the user keep adding models, returning to the provider list.
  // The list shows ALL providers (even already-configured ones) so more models
  // can be added to a provider that was already set up.
  for (;;) {
    const more = await p.confirm({ message: 'Add other models?', initialValue: false });
    if (p.isCancel(more)) { p.cancel('aborted'); process.exit(0); }
    if (!more) break;
    const pick = await p.select({
      message: 'Provider to configure:',
      options: Object.keys(catalog).map((id) => ({ value: id, label: catalog[id].label })),
    });
    if (p.isCancel(pick)) { p.cancel('aborted'); process.exit(0); }
    const pid = String(pick);
    await ensureProviderAuth(pid, pp, apiKeys, providers, providerProfiles, providerEndpoints);
    await selectProviderModels(pid, modelConfig, selectedModelIds);
  }

  const defaultModelChoice = await p.select({
    message: 'Default model (used when no decision matches):',
    options: selectedModelIds.map((id) => ({ value: id, label: id })),
  });
  if (p.isCancel(defaultModelChoice)) { p.cancel('aborted'); process.exit(0); }
  const defaultModel = String(defaultModelChoice);

  // complexity service — always enabled (it is essential to Brick routing); the
  // wizard asks where the difficulty classifier lives: bundled local Docker
  // sidecar, or a remote OpenAI-compatible endpoint (vLLM / hosted API).
  const complexityMode = await p.select({
    message: 'complexity classifier:',
    options: [
      { value: 'local', label: 'Local (Docker sidecar)', hint: 'bundled classifier container, runs on this host' },
      { value: 'remote', label: 'Remote (OpenAI-compatible API)', hint: 'custom /v1/chat/completions endpoint' },
    ],
    initialValue: 'local',
  });
  if (p.isCancel(complexityMode)) { p.cancel('aborted'); process.exit(0); }

  let complexityService: any;
  if (complexityMode === 'remote') {
    const url = await p.text({ message: 'remote base_url:', placeholder: 'https://api.example.com', defaultValue: '' });
    if (p.isCancel(url)) { p.cancel('aborted'); process.exit(0); }
    const modelName = await p.text({ message: 'model name (sent to the API):', placeholder: 'brick-complexity', defaultValue: 'brick-complexity' });
    if (p.isCancel(modelName)) { p.cancel('aborted'); process.exit(0); }
    const token = await p.password({ message: 'bearer token (optional, blank to skip):' });
    if (p.isCancel(token)) { p.cancel('aborted'); process.exit(0); }
    complexityService = {
      enabled: true,
      protocol: 'openai',
      base_url: String(url).trim(),
      model_name: String(modelName || 'brick-complexity').trim(),
      ...(token ? { bearer_token: String(token) } : {}),
      timeout_seconds: 8,
      auto_spawn: false,
    };
  } else {
    // Local Docker sidecar reached via the compose service DNS name.
    complexityService = {
      enabled: true,
      base_url: 'http://classifier:8094',
      bearer_token: '${BRICK_CLASSIFIER_TOKEN}',
      timeout_seconds: 8,
      auto_spawn: false,
    };
  }

  // routing mode — quantized preset of the continuous r knob
  // (skill_router.math.routing_preference, honored by the Go router).
  const MODE_HINTS: Record<ClaudeMode, string> = {
    eco: 'max savings: cheapest models whenever possible',
    lite: 'mostly cheap, escalate only when clearly needed',
    mid: 'balanced (production default)',
    pro: 'mostly capable, save only on trivial queries',
    max: 'max quality: strongest models regardless of cost',
  };
  const modeChoice = await p.select({
    message: 'Brick routing mode (cost/quality knob):',
    options: MODES.map((m) => ({ value: m, label: `${m} (r=${R_BY_MODE[m]})`, hint: MODE_HINTS[m] })),
    initialValue: 'mid' as ClaudeMode,
  });
  if (p.isCancel(modeChoice)) { p.cancel('aborted'); process.exit(0); }
  const mode = modeChoice as ClaudeMode;
  const routingPreference = R_BY_MODE[mode];

  // keyword overrides — let the user force a model when keywords match,
  // on top of the default coder rules.
  const customKeywordRules: any[] = [];
  const wantKeyword = await p.confirm({
    message: 'Add a custom keyword override (force a model when keywords match)?',
    initialValue: false,
  });
  if (p.isCancel(wantKeyword)) { p.cancel('aborted'); process.exit(0); }
  if (wantKeyword) {
    for (;;) {
      const kws = await p.text({ message: 'Comma-separated keywords:', placeholder: 'prove, theorem, integral' });
      if (p.isCancel(kws)) { p.cancel('aborted'); process.exit(0); }
      const keywords = String(kws).split(',').map((s) => s.trim()).filter(Boolean);
      const targets = await p.multiselect({
        message: 'Model(s) to force for these keywords (space to toggle, enter to confirm):',
        options: selectedModelIds.map((id) => ({ value: id, label: id })),
        required: true,
      });
      if (p.isCancel(targets)) { p.cancel('aborted'); process.exit(0); }
      const targetModels = (targets as string[]).map(String);
      if (keywords.length > 0 && targetModels.length > 0) {
        // One override rule per chosen model. The Go router keeps a single
        // override per keyword match, ranked by importance (keywords.go:
        // betterKeyword), so selection order = priority: the first model wins,
        // the rest are fallbacks if it leaves the pool.
        targetModels.forEach((model, i) => {
          customKeywordRules.push({
            name: `user_override_${customKeywordRules.length + 1}`,
            mode: 'override',
            importance: Math.max(1, 10 - i),
            model,
            operator: 'OR',
            keywords,
            case_sensitive: false,
          });
        });
      }
      const more = await p.confirm({ message: 'Add another keyword override?', initialValue: false });
      if (p.isCancel(more)) { p.cancel('aborted'); process.exit(0); }
      if (!more) break;
    }
  }

  // Multimodal — always on. Per-model native capability flags decide which
  // models receive raw image/audio directly; the brick block below stays as the
  // OCR/STT/vision FALLBACK for models that handle neither.
  const imageCapable = await p.multiselect({
    message: 'Which models handle IMAGES natively? (raw image passed through, no OCR) — space to toggle, enter to confirm',
    options: selectedModelIds.map((id) => ({ value: id, label: id })),
    required: false,
  });
  if (p.isCancel(imageCapable)) { p.cancel('aborted'); process.exit(0); }
  const audioCapable = await p.multiselect({
    message: 'Which models handle AUDIO natively? (raw audio passed through, no STT) — space to toggle, enter to confirm',
    options: selectedModelIds.map((id) => ({ value: id, label: id })),
    required: false,
  });
  if (p.isCancel(audioCapable)) { p.cancel('aborted'); process.exit(0); }
  const caps: Record<string, { images?: boolean; audio?: boolean }> = {};
  for (const id of imageCapable as string[]) caps[id] = { ...caps[id], images: true };
  for (const id of audioCapable as string[]) caps[id] = { ...caps[id], audio: true };

  const primaryProvider = enabledProviders.includes('regolo') ? 'regolo' : enabledProviders[0];
  const mm = catalog[primaryProvider].multimodal;
  const brick = {
    enabled: true,
    stt_model: mm.stt?.model ?? 'faster-whisper-large-v3',
    stt_endpoint: mm.stt?.endpoint ?? 'https://api.regolo.ai/v1/audio/transcriptions',
    ocr_model: mm.ocr?.model ?? 'deepseek-ocr-2',
    ocr_endpoint: mm.ocr?.endpoint ?? 'https://api.regolo.ai/v1/chat/completions',
    vision_model: mm.vision?.model ?? 'qwen3.5-122b',
    vision_endpoint: mm.vision?.endpoint ?? 'https://api.regolo.ai/v1/chat/completions',
    ocr_min_text_length: 10,
  };

  const skillRouter = buildSkillRouter(selectedModelIds, complexityService?.base_url, routingPreference, customKeywordRules, caps);

  // assemble
  const reasoningFamilies: Record<string, any> = {};
  for (const id of selectedModelIds) {
    const fam = modelConfig[id]?.reasoning_family;
    if (fam && (reasoningFamiliesDefault as any)[fam]) {
      reasoningFamilies[fam] = (reasoningFamiliesDefault as any)[fam];
    }
  }

  const cfg: BrickConfig = ConfigSchema.parse({
    model: { name: 'brick', description: 'Virtual multimodal routing model' },
    providers,
    brick,
    server_port: 8000,
    auto_model_name: 'brick',
    provider_profiles: providerProfiles,
    provider_endpoints: providerEndpoints,
    default_model: defaultModel,
    model_config: modelConfig,
    reasoning_families: reasoningFamilies,
    default_reasoning_effort: 'medium',
    complexity_service: complexityService,
    skill_router: skillRouter,
    keyword_rules: [],
    decisions: [],
  });

  // summary
  const skillLines = skillRouter.models.map(
    (m: any) => `  ${m.model}: ${m.skill_source}${m.skill_source === 'heuristic' ? ' (run: brick skills extract)' : ''}`
  );
  p.note(
    [
      `providers: ${Object.keys(providers).join(', ')}`,
      `models: ${selectedModelIds.join(', ')}`,
      `default_model: ${defaultModel}`,
      `mode: ${mode} (r=${routingPreference})`,
      `keyword overrides: ${customKeywordRules.length} custom + ${skillRouter.keyword_rules.length - customKeywordRules.length} default`,
      `skill sources:`,
      ...skillLines,
      `complexity_service: on (${complexityService.base_url})`,
      `multimodal: on (passthrough per-model; OCR/STT/vision fallback)`,
      `  native image: ${(imageCapable as string[]).join(', ') || 'none'}`,
      `  native audio: ${(audioCapable as string[]).join(', ') || 'none'}`,
    ].join('\n'),
    'summary'
  );

  const ok = await p.confirm({ message: `Write config to ${pp.config}?`, initialValue: true });
  if (p.isCancel(ok) || !ok) { p.cancel('aborted'); process.exit(0); }

  await saveConfig(cfg, profile);
  await writeEnvFile(apiKeys, pp.env);
  await writeCompose({ profile, port: cfg.server_port });
  p.outro(`done. config=${pp.config} compose=${pp.compose} env=${pp.env}`);
  return cfg;
}

const CAPABILITIES = [
  'coding',
  'creative_synthesis',
  'instruction_following',
  'math_reasoning',
  'planning_agentic',
  'world_knowledge',
];

const KNOWN_SKILL_VECTORS: Record<string, number[]> = {
  'qwen3.5-9b': [0.714788, 0.511538, 0.810109, 0.912146, 0.577072, 0.179876],
  'deepseek-v4-flash': [0.820939, 0.657845, 0.863112, 0.934963, 0.62055, 0.488518],
  'kimi2.6': [0.904272, 0.751595, 0.87018, 0.943892, 0.641863, 0.344074],
};

// Normalized model costs a_m from the paper (Table 7). cost_weight enters the
// routing objective J_m = D_m + beta * a_m, so for the calibrated pool it must
// match the values the math was locked against. Unknown models fall back to a
// rank-based proxy.
const KNOWN_COST_WEIGHTS: Record<string, number> = {
  'qwen3.5-9b': 0.1,
  'deepseek-v4-flash': 0.4,
  'kimi2.6': 0.6,
  // Anthropic Claude pool (relative cost, opus highest).
  'claude-haiku-4-5': 0.1,
  'claude-sonnet-4-6': 0.4,
  'claude-opus-4-8': 1.0,
  // OpenAI / Codex pool.
  'gpt-5.4-mini': 0.1,
  'o3-mini': 0.2,
  'gpt-5.4': 0.5,
  o3: 0.7,
  'gpt-5.5': 1.0,
};

function buildSkillRouter(
  modelIds: string[],
  complexityBaseUrl?: string,
  routingPreference = 0,
  extraKeywordRules: any[] = [],
  caps: Record<string, { images?: boolean; audio?: boolean }> = {}
): any {
  const models = modelIds.map((id, idx) => {
    // Prefer a published skill vector (measured > benchmark) from the public
    // table; fall back to the legacy hardcoded set, then to a heuristic. The
    // chosen provenance is recorded so the user knows how trustworthy it is.
    const published = lookupSkillRecord(id);
    let skill_vector: number[];
    let skill_source: 'benchmark' | 'measured' | 'heuristic';
    let skill_confidence: string[] | undefined;
    if (published) {
      skill_vector = published.skill_vector;
      skill_source = published.source;
      skill_confidence = published.confidence;
    } else if (KNOWN_SKILL_VECTORS[id]) {
      skill_vector = KNOWN_SKILL_VECTORS[id];
      skill_source = 'measured';
    } else {
      skill_vector = heuristicSkillVector(idx, modelIds.length);
      skill_source = 'heuristic';
    }
    return {
      model: id,
      skill_vector,
      skill_source,
      ...(skill_confidence ? { skill_confidence } : {}),
      use_reasoning: id === 'kimi2.6' ? true : false,
      ...(id === 'kimi2.6' ? { reasoning_effort: 'medium' } : {}),
      cost_weight: KNOWN_COST_WEIGHTS[id] ?? Number(((idx + 1) / Math.max(1, modelIds.length)).toFixed(2)),
      // Native multimodal flags: when set, the brick gateway forwards the raw
      // image/audio to this model instead of OCR/STT-flattening it to text.
      ...(caps[id]?.images ? { handles_images: true } : {}),
      ...(caps[id]?.audio ? { handles_audio: true } : {}),
    };
  });

  return {
    enabled: true,
    capabilities: CAPABILITIES,
    capability_model: {
      model_id: 'models/modernbert-capability-classifier',
      repo_id: 'massaindustries/modernbert-capability-classifier',
      labels: CAPABILITIES,
      use_cpu: true,
    },
    complexity_model: {
      model_id: 'regolo/brick-complexity-2-eco',
      base_model_id: 'Qwen/Qwen3.5-0.8B',
      ...(complexityBaseUrl ? { base_url: complexityBaseUrl } : {}),
      timeout_seconds: 8,
      auto_spawn: false,
    },
    math: {
      prior_strength: 8,
      tau: { easy: 0.55, medium: 0.72, hard: 0.88 },
      routing_preference: routingPreference,
      complexity_mu: 0.345170,
      complexity_bias: 0.822235,
      cost_penalty_beta: 0.230778,
      over_penalty_lambda: 0.045207,
      preference_power: 2.920351,
      max_mu_multiplier: 13.034935,
      max_bias_shift: 5.294173,
      max_cost_relief: 6559.073066,
      max_over_relief: 49.547940,
      min_mu_multiplier: 0.081493,
      min_bias_shift: -1.349259,
      min_cost_boost: 8.834043,
      min_over_boost: 1002.068256,
      tie_epsilon: 0.03,
      clip_min: 0.02,
      clip_max: 0.98,
    },
    models,
    keyword_rules: [
      {
        name: 'force_coder',
        mode: 'override',
        importance: 10,
        model: models.at(-1)?.model ?? modelIds[0],
        operator: 'OR',
        keywords: ['debug', 'refactor', 'compile', 'runtime', 'write a function', 'function that', 'class called'],
        case_sensitive: false,
      },
      {
        name: 'coding_bias',
        mode: 'bias',
        importance: 8,
        capability: 'coding',
        operator: 'OR',
        keywords: ['python', 'javascript', 'typescript', 'golang', 'rust', 'java', 'sql', 'bash', 'async', 'thread'],
        case_sensitive: false,
      },
      ...extraKeywordRules,
    ],
  };
}

function heuristicSkillVector(index: number, total: number): number[] {
  const base = 0.62 + 0.18 * (index / Math.max(1, total - 1));
  return [base, base, Math.min(0.9, base + 0.05), Math.min(0.92, base + 0.08), base, Math.max(0.35, base - 0.1)];
}

// Configure a provider's auth/endpoint and register it. Idempotent: if the
// provider is already in `providers`, it returns early without re-asking the key
// so the loop-back can re-select an already-configured provider just to add more
// models.
async function ensureProviderAuth(
  pid: string,
  pp: ReturnType<typeof paths>,
  apiKeys: Record<string, string>,
  providers: Record<string, any>,
  providerProfiles: Record<string, any>,
  providerEndpoints: any[]
): Promise<void> {
  if (providers[pid]) return;
  const cat = catalog[pid];
  let baseUrl = cat.base_url;
  if (pid === 'local') {
    const u = await p.text({ message: 'Local endpoint base_url:', placeholder: cat.base_url, defaultValue: cat.base_url });
    if (p.isCancel(u)) { p.cancel('aborted'); process.exit(0); }
    baseUrl = String(u || cat.base_url);
  }
  const existing = await readEnvKey(cat.env_key, pp.env);
  let key: string;
  if (existing) {
    key = existing;
  } else {
    const k = await p.password({ message: `${cat.label} API key (will be saved to ~/.brick/.env, not in YAML):` });
    if (p.isCancel(k)) { p.cancel('aborted'); process.exit(0); }
    key = String(k);
  }
  apiKeys[cat.env_key] = key;
  providers[pid] = { type: 'openai_compatible', base_url: baseUrl };
  providerProfiles[pid] = { type: 'openai_compatible', base_url: baseUrl };
  providerEndpoints.push({ name: pid, provider_profile: pid, weight: 1 });
}

// Select models for a provider and merge them into modelConfig/selectedModelIds.
// Additive with dedup: ids already chosen are pre-selected and never duplicated.
async function selectProviderModels(
  pid: string,
  modelConfig: Record<string, any>,
  selectedModelIds: string[]
): Promise<void> {
  const cat = catalog[pid];
  const add = (id: string, conf: any) => {
    modelConfig[id] = conf;
    if (!selectedModelIds.includes(id)) selectedModelIds.push(id);
  };
  if (cat.models.length === 0) {
    const ids = await p.text({ message: `Comma-separated model IDs for ${cat.label}:`, placeholder: 'mistral,llama3' });
    if (p.isCancel(ids)) { p.cancel('aborted'); process.exit(0); }
    const list = String(ids).split(',').map((s) => s.trim()).filter(Boolean);
    for (const id of list) add(id, { preferred_endpoints: [pid], param_size: 'unknown' });
  } else {
    const sel = await p.multiselect({
      message: `Select models for ${cat.label}:`,
      options: cat.models.map((m) => ({ value: m.id, label: `${m.label} (${m.param_size})`, hint: m.reasoning_family })),
      initialValues: cat.models.map((m) => m.id).filter((id) => selectedModelIds.includes(id)),
      required: true,
    });
    if (p.isCancel(sel)) { p.cancel('aborted'); process.exit(0); }
    for (const id of sel as string[]) {
      const m = cat.models.find((x) => x.id === id)!;
      add(id, {
        preferred_endpoints: [pid],
        param_size: m.param_size,
        ...(m.reasoning_family ? { reasoning_family: m.reasoning_family } : {}),
      });
    }
  }
}

async function readEnvKey(envKey: string, envPath?: string): Promise<string | null> {
  const target = envPath;
  try {
    if (target) {
      const txt = await readFile(target, 'utf8');
      const m = txt.match(new RegExp(`^${envKey}=(.+)$`, 'm'));
      if (m) return m[1].trim();
    }
  } catch {}
  return process.env[envKey] ?? null;
}

async function writeEnvFile(keys: Record<string, string>, envPath: string): Promise<void> {
  await mkdir(dirname(envPath), { recursive: true, mode: 0o700 });
  let existing = '';
  try {
    existing = await readFile(envPath, 'utf8');
  } catch {}
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(keys)) {
    lines.push(`${k}=${v}`);
    seen.add(k);
  }
  for (const line of existing.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (m && !seen.has(m[1])) lines.push(line);
  }
  await writeFile(envPath, lines.filter(Boolean).join('\n') + '\n', { mode: 0o600 });
}
