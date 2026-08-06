import { randomBytes } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { paths } from '../config/paths.js';
import { defaultImage } from '../docker/image.js';
import { writeCompose } from '../docker/compose.js';
import { writeCodexModelCatalog } from './catalog.js';

export const CODEX_DEFAULT_MODELS = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'] as const;

const LEGACY_DEFAULT_POOL = new Set(['gpt-5.6-luna', 'gpt-5.4-mini', 'o3-mini', 'gpt-5.6-terra', 'gpt-5.4', 'o3', 'gpt-5.5', 'gpt-5.6-sol']);

const MODEL_DEFAULTS: Record<string, any> = {
  'gpt-5.6-luna': { skill_vector: [0.80, 0.80, 0.75, 0.82, 0.83, 0.82], cost_weight: 0.1 },
  'gpt-5.6-terra': { skill_vector: [0.85, 0.85, 0.80, 0.88, 0.86, 0.88], cost_weight: 0.4 },
  'gpt-5.6-sol': { skill_vector: [0.90, 0.91, 0.86, 0.94, 0.92, 0.94], cost_weight: 1.0 },
};

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function ensureModelConfig(cfg: any, id: string): boolean {
  cfg.model_config = isObject(cfg.model_config) ? cfg.model_config : {};
  const current = isObject(cfg.model_config[id]) ? cfg.model_config[id] : {};
  let changed = !cfg.model_config[id];
  if (!Array.isArray(current.preferred_endpoints)) { current.preferred_endpoints = ['openai']; changed = true; }
  if (!current.preferred_endpoints.includes('openai')) { current.preferred_endpoints.unshift('openai'); changed = true; }
  if (current.param_size == null) { current.param_size = 'unknown'; changed = true; }
  if (current.reasoning_family == null) { current.reasoning_family = 'openai_reasoning'; changed = true; }
  cfg.model_config[id] = current;
  return changed;
}


function isLegacyDefaultPool(pool: any[]): boolean {
  const ids = pool.map((item) => item?.model).filter((id): id is string => typeof id === 'string');
  return ids.length === LEGACY_DEFAULT_POOL.size && new Set(ids).size === ids.length && ids.every((id) => LEGACY_DEFAULT_POOL.has(id));
}

function addDefaultPool(cfg: any): boolean {
  const sr = isObject(cfg.skill_router) ? cfg.skill_router : (cfg.skill_router = {});
  const models = CODEX_DEFAULT_MODELS.map((model) => ({
    model,
    ...MODEL_DEFAULTS[model],
    use_reasoning: true,
    base_url: 'https://api.openai.com/v1',
  }));
  sr.models = models;
  sr.enabled = sr.enabled !== false;
  sr.dynamic_effort = sr.dynamic_effort !== false;
  sr.capabilities ??= ['coding', 'creative_synthesis', 'instruction_following', 'math_reasoning', 'planning_agentic', 'world_knowledge'];
  sr.capability_model ??= {
    model_id: 'models/modernbert-capability-classifier',
    repo_id: 'regolo/modernbert-capability-classifier',
    labels: sr.capabilities,
    use_cpu: true,
  };
  sr.complexity_model ??= {
    model_id: 'regolo/brick-complexity-pro',
    base_model_id: 'Qwen/Qwen3.5-0.8B',
    base_url: 'https://api.regolo.ai',
    protocol: 'openai',
    model_name: 'brick-complexity-pro',
    bearer_token: '${REGOLO_API_KEY}',
    timeout_seconds: 8,
    auto_spawn: false,
  };
  sr.math ??= { routing_preference: 0, tau: { easy: 0.55, medium: 0.72, hard: 0.88 } };
  sr.keyword_rules ??= [];
  cfg.default_model = typeof cfg.default_model === 'string' ? cfg.default_model : 'gpt-5.6-terra';
  return true;
}

/**
 * Upgrade an existing Codex profile without replacing user choices. Empty or
 * missing pools receive the GPT-5.6 starter pool; a non-empty pool is treated
 * as user-owned and is never rewritten.
 */
export async function migrateCodexProfile(profile: string): Promise<{ changed: boolean; poolAdded: boolean; composeRepaired: boolean }> {
  const pp = paths(profile);
  const raw = await readFile(pp.config, 'utf8');
  const cfg = yaml.load(raw) as any;
  if (!isObject(cfg)) throw new Error(`profile '${profile}' has malformed config.yaml`);

  let changed = false;
  const pool = isObject(cfg.skill_router) && Array.isArray(cfg.skill_router.models) ? cfg.skill_router.models : [];
  const legacyDefaultPool = isLegacyDefaultPool(pool);
  const poolAdded = pool.length === 0 || legacyDefaultPool;
  if (poolAdded) {
    changed = addDefaultPool(cfg) || changed;
    if (legacyDefaultPool && cfg.brick?.fixed_model === 'gpt-5.4') {
      delete cfg.brick.fixed_model;
      changed = true;
    }
  }

  if (cfg.default_model == null) { cfg.default_model = 'gpt-5.6-terra'; changed = true; }
  if (cfg.auto_model_name == null) { cfg.auto_model_name = 'brick'; changed = true; }
  if (!isObject(cfg.model)) { cfg.model = { name: 'brick-codex', description: 'Default Brick router for OpenAI Codex (Responses API)' }; changed = true; }
  if (cfg.server_port == null) { cfg.server_port = 8000; changed = true; }
  if (cfg.default_reasoning_effort == null) { cfg.default_reasoning_effort = 'medium'; changed = true; }
  cfg.providers = isObject(cfg.providers) ? cfg.providers : {};
  if (!cfg.providers.openai) { cfg.providers.openai = { type: 'openai_compatible', base_url: 'https://api.openai.com/v1' }; changed = true; }
  cfg.provider_profiles = isObject(cfg.provider_profiles) ? cfg.provider_profiles : {};
  if (!cfg.provider_profiles.openai) { cfg.provider_profiles.openai = { type: 'openai_compatible', base_url: 'https://api.openai.com/v1' }; changed = true; }
  if (!Array.isArray(cfg.provider_endpoints)) { cfg.provider_endpoints = [{ name: 'openai', provider_profile: 'openai', weight: 1 }]; changed = true; }
  if (!isObject(cfg.reasoning_families)) { cfg.reasoning_families = {}; changed = true; }
  if (!cfg.reasoning_families.openai_reasoning) { cfg.reasoning_families.openai_reasoning = { type: 'reasoning_effort', parameter: 'reasoning_effort' }; changed = true; }
  if (!isObject(cfg.complexity_service)) {
    cfg.complexity_service = { enabled: true, protocol: 'openai', base_url: 'https://api.regolo.ai', model_name: 'brick-complexity-pro', bearer_token: '${REGOLO_API_KEY}', timeout_seconds: 8, auto_spawn: false };
    changed = true;
  }

  const effectivePool = isObject(cfg.skill_router) && Array.isArray(cfg.skill_router.models) ? cfg.skill_router.models : [];
  for (const item of effectivePool) {
    if (!isObject(item) || typeof item.model !== 'string') continue;
    if (ensureModelConfig(cfg, item.model)) changed = true;
  }
  for (const id of CODEX_DEFAULT_MODELS) {
    if (poolAdded && ensureModelConfig(cfg, id)) changed = true;
  }

  if (!isObject(cfg.brick)) { cfg.brick = {}; changed = true; }
  if (cfg.brick.enabled == null) { cfg.brick.enabled = true; changed = true; }
  if (cfg.brick.use_model_routing == null) { cfg.brick.use_model_routing = true; changed = true; }
  if (cfg.brick.routing_mode == null) { cfg.brick.routing_mode = 'smartsqueeze'; changed = true; }

  if (changed) {
    await writeFile(pp.config, yaml.dump(cfg, { lineWidth: 120, noRefs: true, sortKeys: false }), { mode: 0o600 });
  }

  let composeRepaired = false;
  try {
    const compose = await readFile(pp.compose, 'utf8');
    // Older Codex profiles were accidentally rendered with the Claude router
    // image. Repair only the image reference; do not overwrite custom compose.
    if (compose.includes('brick-cc-router') || compose.includes('brick-codex-local') || compose.includes('ghcr.io/')) {
      const repaired = compose.replace(/(^\s*image:\s*)([^\n#]+)/m, `$1${defaultImage()}`);
      if (repaired !== compose) {
        await writeFile(pp.compose, repaired, { mode: 0o644 });
        composeRepaired = true;
      }
    }
  } catch {
    await writeCompose({ profile, port: Number(cfg.server_port) || 8000, image: defaultImage(), useLocalClassifier: false });
    composeRepaired = true;
  }

  const catalogModels = effectivePool.map((item: any) => item?.model).filter((id: any): id is string => typeof id === 'string');
  await writeCodexModelCatalog(profile, catalogModels);

  try { await access(pp.env); } catch {
    await writeFile(pp.env, `REGOLO_API_KEY=\nBRICK_CLASSIFIER_TOKEN=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  }
  return { changed, poolAdded, composeRepaired };
}
