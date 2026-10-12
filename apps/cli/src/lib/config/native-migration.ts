import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, rename, rm, copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { paths } from './paths.js';

const fieldSchema = createRequire(import.meta.url)('../../../assets/config-schema.json');
function validateFields(value: any, schema: any, path = 'config'): void {
  if (value == null || schema.any) return;
  if (schema.scalar) {
    if (typeof value === 'object') throw new Error(`Expected a scalar at ${path}; files were not changed.`);
    return;
  }
  if (schema.items) {
    if (!Array.isArray(value)) throw new Error(`Expected an array at ${path}; files were not changed.`);
    value.forEach((item: any, i: number) => validateFields(item, schema.items, `${path}[${i}]`));
    return;
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected an object at ${path}; files were not changed.`);
  for (const [key, item] of Object.entries(value)) {
    const child = schema.values ?? schema.fields?.[key];
    if (!child) throw new Error(`Unknown configuration field ${path}.${key}; files were not changed.`);
    validateFields(item, child, `${path}.${key}`);
  }
}

const retired = ['model', 'config_source', 'mom_registry', 'external_models', 'semantic_cache', 'memory', 'vector_store', 'response_api', 'router_replay', 'looper', 'api', 'clear_route_cache', 'authz', 'ratelimit', 'embedding_models', 'bert_model', 'classifier', 'prompt_guard', 'hallucination_mitigation', 'feedback_detector', 'modality_detector', 'decisions', 'strategy', 'model_selection', 'keyword_rules', 'embedding_rules', 'categories', 'fact_check_rules', 'user_feedback_rules', 'preference_rules', 'language_rules', 'context_rules', 'modality_rules', 'role_bindings', 'tools', 'plugins', 'image_gen_backends', 'modality_routes', 'text_routes'];

const dimensions = ['instruction_following', 'coding', 'math_reasoning', 'world_knowledge', 'planning_agentic', 'creative_synthesis'];
const obsoleteRouting = ['routing_mode', 'sticky_ttl_seconds', 'sticky_score_margin', 'compact_keep_recent_turns', 'compact_shadow_only', 'use_thinking_routing', 'use_skill_router', 'model_map', 'model_map_1m'];

function validateVectors(obj: any): void {
  const sr = obj.skill_router;
  if (!sr) return;
  const names = sr.capabilities;
  if (!Array.isArray(names) || names.length !== 6 || new Set(names).size !== 6 || names.some((name: string) => !dimensions.includes(name)))
    throw new Error('SystemOne requires the six named capabilities; files were not changed.');
  if (!Number.isFinite(sr.knob ?? 0) || (sr.knob ?? 0) < -1 || (sr.knob ?? 0) > 1)
    throw new Error('Routing knob must be a number in [-1, 1]; files were not changed.');
  for (const model of sr.models ?? []) {
    if (!Array.isArray(model.skill_vector) || model.skill_vector.length !== 6 || model.skill_vector.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1))
      throw new Error(`Incompatible skill vector for ${model.model}; files were not changed.`);
  }
}

/** Migrate legacy profiles without changing provider credentials, model priority or vector order. */
export function nativeConfig(input: any): any {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Profile must contain a YAML object.');
  if (input.config_version !== undefined && ![0, 1, 2].includes(input.config_version)) throw new Error(`Unsupported profile config_version: ${input.config_version}`);
  const obj = structuredClone(input);
  if (obj.config_version === 2) {
    validateVectors(obj);
    validateFields(obj, fieldSchema);
    return obj;
  }
  const sr = obj.skill_router;
  if (sr) {
    const labels = sr.capability_model?.labels;
    if (labels?.length && JSON.stringify(labels) !== JSON.stringify(dimensions) && JSON.stringify(labels) !== JSON.stringify([...dimensions].sort()))
      throw new Error('Incompatible legacy checkpoint labels; files were not changed.');
    sr.capabilities ??= [...dimensions].sort();
    sr.knob ??= sr.math?.routing_preference ?? 0;
    sr.systemone ??= { local_path: 'models/systemone' };
    for (const key of ['capability_model', 'complexity_model', 'math', 'dynamic_effort', 'keyword_rules']) delete sr[key];
    for (const model of sr.models ?? []) {
      for (const key of ['cost_weight', 'latency_weight', 'reasoning_effort', 'reasoning_description']) delete model[key];
    }
  }
  delete obj.complexity_service;
  delete obj.default_reasoning_effort;
  for (const block of [obj.brick, obj.anthropic_passthrough]) {
    if (block) for (const key of obsoleteRouting) delete block[key];
  }
  if (input.config_version === undefined && !obj.codex_router?.enabled) {
    // Preserve the legacy implicit caller-key policy once; runtime uses explicit sources.
    const regoloURL = (value: string) => { try { const host = new URL(value).hostname; return host === 'regolo.ai' || host.endsWith('.regolo.ai'); } catch { return false; } };
    for (const [name, model] of Object.entries(obj.model_config ?? {}) as [string, any][]) {
      const skill = sr?.models?.find((entry: any) => entry.model === name);
      const legacy = regoloURL(skill?.base_url) || (model.preferred_endpoints ?? []).some((id: string) => {
        const endpoint = obj.provider_endpoints?.find((entry: any) => entry.name === id);
        return ['regolo', 'regoloai'].includes(id) || ['regolo', 'regoloai'].includes(endpoint?.provider_profile) || regoloURL(obj.provider_profiles?.[endpoint?.provider_profile]?.base_url);
      });
      const implicitCaller = !model.access_key && !model.access_key_env && !model.api_key_env && !model.api_key_file && !skill?.api_key && !skill?.api_key_env && !skill?.api_key_file;
      if ((legacy || implicitCaller) && model.use_client_key === undefined) model.use_client_key = true;
    }
  }
  for (const endpoint of obj.provider_endpoints ?? []) {
    if (!endpoint.api_key) continue;
    for (const model of Object.values(obj.model_config ?? {}) as any[]) {
      if (model.preferred_endpoints?.includes(endpoint.name) && !model.access_key && !model.access_key_env) model.access_key = endpoint.api_key;
    }
    delete endpoint.api_key;
  }
  if (obj.observability) {
    delete obj.observability.tracing;
    if (obj.observability.metrics) delete obj.observability.metrics.windowed_metrics;
  }
  for (const key of retired) delete obj[key];
  for (const provider of Object.values(obj.providers ?? {}) as any[]) delete provider.type;
  for (const family of Object.values(obj.reasoning_families ?? {}) as any[]) delete family.type;
  for (const model of Object.values(obj.model_config ?? {}) as any[]) {
    for (const key of ['loras', 'description', 'capabilities', 'quality_score', 'modality', 'image_gen_backend', 'param_size', 'api_format', 'pricing', 'reasoning_description', 'reasoning_effort']) delete model[key];
  }
  obj.config_version = 2;
  validateVectors(obj);
  validateFields(obj, fieldSchema);
  return obj;
}

/** Backups survive clear/restart and contain the exact pre-migration bytes. */
export async function migrateNativeProfile(profile: string): Promise<void> {
  const pp = paths(profile);
  const text = await readFile(pp.config, 'utf8');
  let original: any;
  try { original = yaml.load(text); }
  catch { throw new Error('Invalid YAML in profile configuration; files were not changed.'); }
  const migrated = nativeConfig(original);
  if (JSON.stringify(original) === JSON.stringify(migrated)) return;
  const id = randomUUID();
  const backup = join(pp.profileDir, 'backups', `systemone-v2-${id}`);
  await mkdir(backup, { recursive: true, mode: 0o700 });
  await writeFile(join(backup, 'config.yaml'), text, { flag: 'wx', mode: 0o600 });
  try { await copyFile(pp.env, join(backup, '.env')); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${pp.config}.${id}.tmp`;
  try {
    await writeFile(temp, yaml.dump(migrated, { noRefs: true, lineWidth: 120 }), { mode: 0o600, flag: 'wx' });
    // An editor changing the file during backup must not lose its changes.
    if (await readFile(pp.config, 'utf8') !== text) throw new Error('Profile changed during migration; retry. Backup retained.');
    await rename(temp, pp.config);
  } finally { await rm(temp, { force: true }); }
}
