import { nativeCodexTransport, ensureCodexLocalKey, addOfficialCodexModels, pruneOfficialCodexModels } from './native-transport.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { nativeConfig } from '../config/native-migration.js';
import { atomicWrite } from '../config/atomic-file.js';
import { access, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { paths } from '../config/paths.js';
import { readCodexCatalogForSetup } from './catalog.js';
import { applyModelTransport, resolveModelTransport } from '../catalog/transport.js';
import { applyRemoteSkillVectors } from '../skills/resolver.js';

export const CODEX_DEFAULT_MODELS = ['gpt-6-luna', 'gpt-6.1-terra'] as const;

/**
 * Agentic tool work is the one intent the cheap tier must not win: an explicit
 * rule keeps the stronger Codex model on patch/refactor turns regardless of
 * the request effort mapped onto the routing knob.
 */
export const CODEX_DEFAULT_KEYWORDS = [
  { name: 'strong-agentic', model: 'gpt-6.1-terra', keywords: ['apply_patch', 'refactor', 'debug', 'bug', 'bugs', 'failing test', 'failing tests', 'unit test', 'unit tests'] },
] as const;

// Verified limits from `codex debug models` (context_window × effective %).
// Context discovery refreshes them on every start; these keep an offline first
// start valid until the catalog is reachable.
const CODEX_CONTEXT_DEFAULTS: Record<string, number> = {
  'gpt-6-luna': 258400,
  'gpt-6.1-terra': 475000,
};
const CODEX_THINKING_MODES = ['low', 'medium', 'high', 'xhigh', 'max'];

const CODEX_BRIDGE_URL = 'http://host.docker.internal:18080/v1';
const HISTORICAL_CODEX_URL = 'https://api.openai.com/v1';

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function ensureModelConfig(cfg: any, id: string, fallbackEndpoint?: string): boolean {
  cfg.model_config = isObject(cfg.model_config) ? cfg.model_config : {};
  const current = isObject(cfg.model_config[id]) ? cfg.model_config[id] : {};
  let changed = !cfg.model_config[id];
  if (!Array.isArray(current.preferred_endpoints) || current.preferred_endpoints.length === 0) {
    current.preferred_endpoints = fallbackEndpoint ? [fallbackEndpoint] : [];
    changed = true;
  }
  if ((fallbackEndpoint === 'openai' || fallbackEndpoint === 'openai-codex') && current.reasoning_family == null) { current.reasoning_family = 'openai_reasoning'; changed = true; }
  if (fallbackEndpoint === 'openai-codex' && !current.context_window_size && CODEX_CONTEXT_DEFAULTS[id]) {
    current.context_window_size = CODEX_CONTEXT_DEFAULTS[id];
    changed = true;
  }
  if (fallbackEndpoint === 'openai-codex' && CODEX_CONTEXT_DEFAULTS[id] && !Array.isArray(current.allowed_thinking_modes)) {
    current.allowed_thinking_modes = [...CODEX_THINKING_MODES];
    changed = true;
  }
  cfg.model_config[id] = current;
  return changed;
}


/** Fallback vectors keyed by capability (published table order). */
const CODEX_FALLBACK_VECTORS: Record<string, Record<string, number>> = {
  'gpt-6-luna': { coding: 0.51, creative_synthesis: 0.59, instruction_following: 0.50, math_reasoning: 0.84, planning_agentic: 0.54, world_knowledge: 0.63 },
  'gpt-6.1-terra': { coding: 0.50, creative_synthesis: 0.41, instruction_following: 0.50, math_reasoning: 0.49, planning_agentic: 0.38, world_knowledge: 0.39 },
};
const CANONICAL_CAPABILITIES = ['coding', 'creative_synthesis', 'instruction_following', 'math_reasoning', 'planning_agentic', 'world_knowledge'];

function addDefaultPool(cfg: any): boolean {
  const sr = isObject(cfg.skill_router) ? cfg.skill_router : (cfg.skill_router = {});
  sr.active_models = [...CODEX_DEFAULT_MODELS];
  sr.enabled = sr.enabled !== false;
  sr.capabilities ??= [...CANONICAL_CAPABILITIES];
  // Write each fallback vector in THIS profile's declared capability order so
  // the offline first start routes correctly even before HF sync reorders it.
  sr.models = CODEX_DEFAULT_MODELS.map((id) => ({
    model: id,
    skill_vector: sr.capabilities.map((cap: string) => CODEX_FALLBACK_VECTORS[id]?.[cap] ?? 0.5),
    use_reasoning: true,
  }));
  sr.keywords ??= structuredClone(CODEX_DEFAULT_KEYWORDS);
  sr.systemone ??= { local_path: 'models/systemone' };
  sr.knob ??= 0;
  return true;
}

/**
 * Give a profile that has no routing rules the agentic guard. An empty rule
 * list cannot be a deliberate user choice (it routes exactly like a missing
 * one), so filling it upgrades the profile without discarding anything. Any
 * non-empty list is user-owned and is left untouched.
 */
function ensureDefaultKeywords(cfg: any): boolean {
  if (!isObject(cfg.skill_router)) return false;
  const keywords = cfg.skill_router.keywords;
  if (Array.isArray(keywords) && keywords.length > 0) return false;
  if (keywords != null && !Array.isArray(keywords)) return false;
  // A rule may only name a model that is in the pool; profiles that do not
  // route to the strong Codex model keep an empty rule list.
  const pool = Array.isArray(cfg.skill_router.models) ? cfg.skill_router.models.map((entry: any) => entry?.model) : [];
  if (!pool.includes('gpt-6.1-terra')) return false;
  cfg.skill_router.keywords = structuredClone(CODEX_DEFAULT_KEYWORDS);
  return true;
}

/**
 * Upgrade an existing Codex profile without replacing user choices. Empty or
 * missing pools receive the GPT-6 starter pool; a non-empty pool is treated
 * as user-owned and is never rewritten.
 */
export async function migrateCodexProfile(
  profile: string,
  options: { resetPool?: boolean } = {},
): Promise<{ changed: boolean; poolAdded: boolean; pruned: string[] }> {
  const pp = paths(profile);
  const raw = await readFile(pp.config, 'utf8');
  let parsed: any;
  try { parsed = yaml.load(raw); } catch { throw new Error('Invalid YAML; profile files were not changed.'); }
  let cfg = nativeConfig(parsed);
  if (!isObject(cfg)) throw new Error(`profile '${profile}' has malformed config.yaml`);

  let changed = JSON.stringify(cfg) !== JSON.stringify(parsed);
  const pool = isObject(cfg.skill_router) && Array.isArray(cfg.skill_router.models) ? cfg.skill_router.models : [];
  const poolAdded = pool.length === 0 || options.resetPool === true;
  if (poolAdded) {
    changed = addDefaultPool(cfg) || changed;
  }
  if (options.resetPool) {
    cfg.default_model = 'gpt-6.1-terra';
    changed = true;
  }
  if (ensureDefaultKeywords(cfg)) changed = true;

  if (cfg.default_model == null) { cfg.default_model = 'gpt-6.1-terra'; changed = true; }
  if (cfg.auto_model_name == null) { cfg.auto_model_name = 'brick'; changed = true; }
  if (cfg.server_port == null) { cfg.server_port = 8000; changed = true; }
  cfg.providers = isObject(cfg.providers) ? cfg.providers : {};
  const needsOpenAIStarter = poolAdded || Object.keys(cfg.providers).length === 0;
  if (needsOpenAIStarter && !cfg.providers['openai-codex']) { cfg.providers['openai-codex'] = { base_url: CODEX_BRIDGE_URL }; changed = true; }
  if (cfg.providers['openai-codex']?.base_url === HISTORICAL_CODEX_URL) { cfg.providers['openai-codex'].base_url = CODEX_BRIDGE_URL; changed = true; }
  cfg.provider_profiles = isObject(cfg.provider_profiles) ? cfg.provider_profiles : {};
  if (needsOpenAIStarter && !cfg.provider_profiles['openai-codex']) { cfg.provider_profiles['openai-codex'] = { type: 'openai_compatible', base_url: CODEX_BRIDGE_URL }; changed = true; }
  if (cfg.provider_profiles['openai-codex']?.base_url === HISTORICAL_CODEX_URL) { cfg.provider_profiles['openai-codex'].base_url = CODEX_BRIDGE_URL; changed = true; }
  if (!Array.isArray(cfg.provider_endpoints)) {
    const fallbackProvider = needsOpenAIStarter ? 'openai-codex' : Object.keys(cfg.providers)[0];
    cfg.provider_endpoints = fallbackProvider ? [{ name: fallbackProvider, provider_profile: fallbackProvider, weight: 1 }] : [];
    changed = true;
  }
  if (poolAdded && !cfg.provider_endpoints.some((ep: any) => ep?.name === 'openai-codex')) {
    cfg.provider_endpoints.push({ name: 'openai-codex', provider_profile: 'openai-codex', weight: 1 });
    changed = true;
  }
  if (!isObject(cfg.reasoning_families)) { cfg.reasoning_families = {}; changed = true; }
  if (needsOpenAIStarter && !cfg.reasoning_families.openai_reasoning) { cfg.reasoning_families.openai_reasoning = { parameter: 'reasoning_effort' }; changed = true; }
  const effectivePool = isObject(cfg.skill_router) && Array.isArray(cfg.skill_router.models) ? cfg.skill_router.models : [];
  for (const item of effectivePool) {
    if (!isObject(item) || typeof item.model !== 'string') continue;
    const fallback = poolAdded ? 'openai-codex' : undefined;
    if (ensureModelConfig(cfg, item.model, fallback)) changed = true;
    if (!cfg.codex_router?.enabled && applyModelTransport(item, resolveModelTransport(item.model, cfg.model_config, cfg.provider_profiles, cfg.provider_endpoints))) changed = true;
  }
  for (const id of CODEX_DEFAULT_MODELS) {
    if (poolAdded && ensureModelConfig(cfg, id, 'openai-codex')) changed = true;
  }

  if (!isObject(cfg.brick)) { cfg.brick = {}; changed = true; }
  if (cfg.brick.enabled == null) { cfg.brick.enabled = true; changed = true; }
  if (cfg.brick.use_model_routing == null) { cfg.brick.use_model_routing = true; changed = true; }

  const native = nativeCodexTransport(cfg);
  if (JSON.stringify(native) !== JSON.stringify(cfg)) { cfg = native; changed = true; }

  if (poolAdded) await applyRemoteSkillVectors(cfg);
  // Pass the pool so a stale-but-readable cache cannot prune available models
  // or fail to supply their context windows.
  const configuredPool = Array.isArray(cfg.skill_router?.active_models) && cfg.skill_router.active_models.length
    ? cfg.skill_router.active_models
    : (cfg.skill_router?.models ?? []).map((entry: any) => entry?.model).filter(Boolean);
  const authenticatedCatalog = await readCodexCatalogForSetup(configuredPool);
  addOfficialCodexModels(cfg, authenticatedCatalog);
  const pruned = pruneOfficialCodexModels(cfg, authenticatedCatalog);
  changed = changed || JSON.stringify(cfg) !== JSON.stringify(parsed);
  nativeConfig(cfg);
  if (changed) {
    const backup = join(pp.profileDir, 'backups', `codex-transport-${randomUUID()}`);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await writeFile(join(backup, 'config.yaml'), raw, { flag: 'wx', mode: 0o600 });
    try { await copyFile(pp.env, join(backup, '.env')); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    await atomicWrite(pp.config, yaml.dump(cfg, { lineWidth: 120, noRefs: true, sortKeys: false }));
  }


  try { await access(pp.env); } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    await atomicWrite(pp.env, 'REGOLO_API_KEY=\n');
  }
  await ensureCodexLocalKey(profile);

  return { changed, poolAdded, pruned };
}
