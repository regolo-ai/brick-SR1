import { nativeCodexTransport, ensureCodexLocalKey, addOfficialCodexModels } from './native-transport.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { nativeConfig } from '../config/native-migration.js';
import { atomicWrite } from '../config/atomic-file.js';
import { access, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { paths } from '../config/paths.js';
import { readAuthenticatedCodexCatalog } from './catalog.js';
import { applyModelTransport, resolveModelTransport } from '../catalog/transport.js';

export const CODEX_DEFAULT_MODELS = ['qwen3.5-122b', 'gpt-5.6-terra'] as const;

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
  cfg.model_config[id] = current;
  return changed;
}


function addDefaultPool(cfg: any): boolean {
  const sr = isObject(cfg.skill_router) ? cfg.skill_router : (cfg.skill_router = {});
  sr.active_models = [...CODEX_DEFAULT_MODELS];
  sr.models = [
    { model: 'qwen3.5-122b', skill_vector: [0.50, 0.38, 0.57, 0.48, 0.52, 0.68], use_reasoning: true },
    { model: 'gpt-5.6-terra', skill_vector: [0.85, 0.85, 0.80, 0.88, 0.86, 0.88], use_reasoning: true },
  ];
  sr.enabled = sr.enabled !== false;
  sr.dynamic_effort = sr.dynamic_effort !== false;
  sr.capabilities ??= ['coding', 'creative_synthesis', 'instruction_following', 'math_reasoning', 'planning_agentic', 'world_knowledge'];
  sr.capability_model ??= {
    model_id: 'models/modernbert-capability-classifier',
    labels: sr.capabilities,
  };
  sr.complexity_model ??= {
    model_id: 'regolo/brick-complexity-pro',
    base_url: 'https://api.regolo.ai',
    protocol: 'openai',
    model_name: 'brick-complexity-pro',
    bearer_token: '${REGOLO_API_KEY}',
    timeout_seconds: 8,
  };
  sr.math ??= { routing_preference: 0, tau: { easy: 0.55, medium: 0.72, hard: 0.88 } };
  sr.keyword_rules ??= [];
  return true;
}

/**
 * Upgrade an existing Codex profile without replacing user choices. Empty or
 * missing pools receive the GPT-5.6 starter pool; a non-empty pool is treated
 * as user-owned and is never rewritten.
 */
export async function migrateCodexProfile(profile: string): Promise<{ changed: boolean; poolAdded: boolean }> {
  const pp = paths(profile);
  const raw = await readFile(pp.config, 'utf8');
  let parsed: any;
  try { parsed = yaml.load(raw); } catch { throw new Error('Invalid YAML; profile files were not changed.'); }
  let cfg = nativeConfig(parsed);
  if (!isObject(cfg)) throw new Error(`profile '${profile}' has malformed config.yaml`);

  let changed = JSON.stringify(cfg) !== JSON.stringify(parsed);
  const pool = isObject(cfg.skill_router) && Array.isArray(cfg.skill_router.models) ? cfg.skill_router.models : [];
  const poolAdded = pool.length === 0;
  if (poolAdded) {
    changed = addDefaultPool(cfg) || changed;
  }

  if (cfg.default_model == null) { cfg.default_model = 'qwen3.5-122b'; changed = true; }
  if (cfg.auto_model_name == null) { cfg.auto_model_name = 'brick'; changed = true; }
  if (cfg.server_port == null) { cfg.server_port = 8000; changed = true; }
  if (cfg.default_reasoning_effort == null) { cfg.default_reasoning_effort = 'medium'; changed = true; }
  cfg.providers = isObject(cfg.providers) ? cfg.providers : {};
  const needsOpenAIStarter = poolAdded || Object.keys(cfg.providers).length === 0;
  if (poolAdded && !cfg.providers.regolo) { cfg.providers.regolo = { base_url: 'https://api.regolo.ai/v1' }; changed = true; }
  if (needsOpenAIStarter && !cfg.providers['openai-codex']) { cfg.providers['openai-codex'] = { base_url: CODEX_BRIDGE_URL }; changed = true; }
  if (cfg.providers['openai-codex']?.base_url === HISTORICAL_CODEX_URL) { cfg.providers['openai-codex'].base_url = CODEX_BRIDGE_URL; changed = true; }
  cfg.provider_profiles = isObject(cfg.provider_profiles) ? cfg.provider_profiles : {};
  if (poolAdded && !cfg.provider_profiles.regolo) { cfg.provider_profiles.regolo = { type: 'openai_compatible', base_url: 'https://api.regolo.ai/v1' }; changed = true; }
  if (needsOpenAIStarter && !cfg.provider_profiles['openai-codex']) { cfg.provider_profiles['openai-codex'] = { type: 'openai_compatible', base_url: CODEX_BRIDGE_URL }; changed = true; }
  if (cfg.provider_profiles['openai-codex']?.base_url === HISTORICAL_CODEX_URL) { cfg.provider_profiles['openai-codex'].base_url = CODEX_BRIDGE_URL; changed = true; }
  if (!Array.isArray(cfg.provider_endpoints)) {
    const fallbackProvider = needsOpenAIStarter ? 'openai-codex' : Object.keys(cfg.providers)[0];
    cfg.provider_endpoints = fallbackProvider ? [{ name: fallbackProvider, provider_profile: fallbackProvider, weight: 1 }] : [];
    changed = true;
  }
  if (poolAdded && !cfg.provider_endpoints.some((ep: any) => ep?.name === 'regolo')) {
    cfg.provider_endpoints.unshift({ name: 'regolo', provider_profile: 'regolo', weight: 1 });
    changed = true;
  }
  if (poolAdded && !cfg.provider_endpoints.some((ep: any) => ep?.name === 'openai-codex')) {
    cfg.provider_endpoints.push({ name: 'openai-codex', provider_profile: 'openai-codex', weight: 1 });
    changed = true;
  }
  if (!isObject(cfg.reasoning_families)) { cfg.reasoning_families = {}; changed = true; }
  if (needsOpenAIStarter && !cfg.reasoning_families.openai_reasoning) { cfg.reasoning_families.openai_reasoning = { parameter: 'reasoning_effort' }; changed = true; }
  if (!isObject(cfg.complexity_service)) {
    cfg.complexity_service = { enabled: true, protocol: 'openai', base_url: 'https://api.regolo.ai', model_name: 'brick-complexity-pro', bearer_token: '${REGOLO_API_KEY}', timeout_seconds: 8 };
    changed = true;
  }

  const effectivePool = isObject(cfg.skill_router) && Array.isArray(cfg.skill_router.models) ? cfg.skill_router.models : [];
  for (const item of effectivePool) {
    if (!isObject(item) || typeof item.model !== 'string') continue;
    const fallback = poolAdded ? (item.model === 'qwen3.5-122b' ? 'regolo' : 'openai-codex') : undefined;
    if (ensureModelConfig(cfg, item.model, fallback)) changed = true;
    if (!cfg.codex_router?.enabled && applyModelTransport(item, resolveModelTransport(item.model, cfg.model_config, cfg.provider_profiles, cfg.provider_endpoints))) changed = true;
  }
  for (const id of CODEX_DEFAULT_MODELS) {
    if (poolAdded && ensureModelConfig(cfg, id, id === 'qwen3.5-122b' ? 'regolo' : 'openai-codex')) changed = true;
  }

  if (!isObject(cfg.brick)) { cfg.brick = {}; changed = true; }
  if (cfg.brick.enabled == null) { cfg.brick.enabled = true; changed = true; }
  if (cfg.brick.use_model_routing == null) { cfg.brick.use_model_routing = true; changed = true; }
  if (cfg.brick.routing_mode == null) { cfg.brick.routing_mode = 'smartsqueeze'; changed = true; }

  const native = nativeCodexTransport(cfg);
  if (JSON.stringify(native) !== JSON.stringify(cfg)) { cfg = native; changed = true; }

  const authenticatedCatalog = await readAuthenticatedCodexCatalog();
  addOfficialCodexModels(cfg, authenticatedCatalog);
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

  return { changed, poolAdded };
}
