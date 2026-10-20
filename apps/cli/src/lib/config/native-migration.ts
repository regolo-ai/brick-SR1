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

function validateKeywords(sr: any): void {
  const rules = sr.keywords;
  if (rules === undefined) return;
  if (!Array.isArray(rules)) throw new Error('Expected an array at config.skill_router.keywords; files were not changed.');
  const names = new Set<string>();
  rules.forEach((rule: any, i: number) => {
    const owner = `skill_router.keywords[${i}]`;
    const name = typeof rule?.name === 'string' ? rule.name.trim() : '';
    if (!name) throw new Error(`${owner}.name cannot be empty; files were not changed.`);
    if (names.has(name)) throw new Error(`duplicate ${owner}.name ${JSON.stringify(name)}; files were not changed.`);
    names.add(name);
    if (!Array.isArray(rule.keywords) || rule.keywords.length === 0) throw new Error(`${owner} (${JSON.stringify(name)}).keywords cannot be empty; files were not changed.`);
    if (rule.keywords.some((keyword: unknown) => typeof keyword !== 'string' || !keyword.trim())) throw new Error(`${owner} (${JSON.stringify(name)}).keywords cannot contain empty entries; files were not changed.`);
    const operator = String(rule.operator ?? '').trim().toUpperCase();
    if (!['', 'OR', 'AND'].includes(operator)) throw new Error(`${owner} (${JSON.stringify(name)}).operator must be OR or AND; files were not changed.`);
    if (!rule.model) throw new Error(`${owner} (${JSON.stringify(name)}).model is required; files were not changed.`);
    const listed = (sr.models ?? []).some((model: any) => model?.model === rule.model);
    if (!listed) throw new Error(`${owner} (${JSON.stringify(name)}).model ${JSON.stringify(rule.model)} is not listed in skill_router.models; files were not changed.`);
    if (Array.isArray(sr.active_models) && sr.active_models.length > 0 && !sr.active_models.includes(rule.model))
      throw new Error(`${owner} (${JSON.stringify(name)}).model ${JSON.stringify(rule.model)} is not an active routing candidate; files were not changed.`);
  });
}

function validateVectors(obj: any): void {
  const sr = obj.skill_router;
  if (!sr) return;
  validateKeywords(sr);
  const names = sr.capabilities;
  if (!Array.isArray(names) || names.length !== 6 || new Set(names).size !== 6 || names.some((name: string) => !dimensions.includes(name)))
    throw new Error('SystemOne requires the six named capabilities; files were not changed.');
  if (!Number.isFinite(sr.knob ?? 0) || (sr.knob ?? 0) < -1 || (sr.knob ?? 0) > 1)
    throw new Error('Routing knob must be a number in [-1, 1]; files were not changed.');
  if (sr.over_capacity_weight !== undefined && (!Number.isFinite(sr.over_capacity_weight) || sr.over_capacity_weight < 0 || sr.over_capacity_weight > 1))
    throw new Error('Over-capacity weight must be a number in [0, 1]; files were not changed.');
  for (const model of sr.models ?? []) {
    if (!Array.isArray(model.skill_vector) || model.skill_vector.length !== 6 || model.skill_vector.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1))
      throw new Error(`Incompatible skill vector for ${model.model}; files were not changed.`);
  }
}

/**
 * Rewrites 3.x fields in place and records what changed. A rule with an implicit
 * mode was a soft bias in 3.x, so it cannot become a strict override silently:
 * the migration fails instead of altering routing.
 */
function applyDeprecated(obj: any, warnings: string[]): void {
  if (obj.complexity_service !== undefined) {
    warnings.push('complexity_service is removed; routing uses the local SystemOne classifier');
    delete obj.complexity_service;
  }
  if (obj.default_reasoning_effort !== undefined) {
    warnings.push('default_reasoning_effort is removed; effort comes from the client request or skill_router.knob');
    delete obj.default_reasoning_effort;
  }
  const sr = obj.skill_router;
  if (!sr) return;
  if (sr.dynamic_effort !== undefined) {
    warnings.push('skill_router.dynamic_effort is removed; effort follows the request knob');
    delete sr.dynamic_effort;
  }
  for (const [key, message] of [
    ['capability_model', 'skill_router.capability_model is removed; the local SystemOne classifier supplies every capability'],
    ['complexity_model', 'skill_router.complexity_model is removed; the local SystemOne classifier supplies every capability'],
  ] as [string, string][]) {
    if (sr[key] !== undefined) { warnings.push(message); delete sr[key]; }
  }
  if (sr.math !== undefined) {
    if (sr.math?.routing_preference !== undefined) {
      if (sr.knob === undefined) {
        sr.knob = sr.math.routing_preference;
        warnings.push(`skill_router.math.routing_preference mapped to skill_router.knob=${Number(sr.knob).toFixed(2)}`);
      } else {
        warnings.push('skill_router.math.routing_preference ignored because skill_router.knob is set');
      }
    }
    warnings.push('skill_router.math is removed; only skill_router.knob remains');
    delete sr.math;
  }
  if (sr.keyword_rules !== undefined) {
    if (Array.isArray(sr.keywords) && sr.keywords.length > 0)
      throw new Error('skill_router.keywords and the deprecated skill_router.keyword_rules cannot be used together; files were not changed.');
    const rules = Array.isArray(sr.keyword_rules) ? sr.keyword_rules : [];
    const converted = rules.map((rule: any, i: number) => {
      const name = rule?.name ?? '';
      const mode = String(rule?.mode ?? '').trim().toLowerCase() || 'bias';
      if (mode !== 'override')
        throw new Error(`skill_router.keyword_rules[${i}] (${JSON.stringify(name)}) uses removed mode "${mode}": only strict overrides are supported; move it to skill_router.keywords without mode, or remove it`);
      if (rule?.capability || (Array.isArray(rule?.bias) && rule.bias.length > 0))
        throw new Error(`skill_router.keyword_rules[${i}] (${JSON.stringify(name)}) uses capability/bias scores, which strict overrides do not support`);
      if (rule?.importance) warnings.push(`skill_router.keyword_rules[${i}] (${JSON.stringify(name)}).importance is ignored; rules evaluate in file order`);
      return {
        name, keywords: rule?.keywords, model: rule?.model,
        ...(rule?.operator ? { operator: rule.operator } : {}),
        ...(rule?.case_sensitive ? { case_sensitive: true } : {}),
      };
    });
    sr.keywords = converted;
    delete sr.keyword_rules;
    warnings.push('skill_router.keyword_rules was renamed to skill_router.keywords');
  }
  for (const [i, model] of (sr.models ?? []).entries()) {
    const name = JSON.stringify(model?.model ?? '');
    if (model?.cost_weight) { warnings.push(`skill_router.models[${i}] (${name}).cost_weight is removed; distance scoring ignores cost`); delete model.cost_weight; }
    if (model?.reasoning_effort) { warnings.push(`skill_router.models[${i}] (${name}).reasoning_effort is removed; effort comes from the request`); delete model.reasoning_effort; }
  }
}

/** Migrate legacy profiles without changing provider credentials, model priority or vector order. */
export function nativeConfigWithWarnings(input: any): { config: any; warnings: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Profile must contain a YAML object.');
  if (input.config_version !== undefined && ![0, 1, 2].includes(input.config_version)) throw new Error(`Unsupported profile config_version: ${input.config_version}`);
  const obj = structuredClone(input);
  const warnings: string[] = [];
  if (obj.config_version === 2) {
    applyDeprecated(obj, warnings);
    validateVectors(obj);
    validateFields(obj, fieldSchema);
    return { config: obj, warnings };
  }
  const sr = obj.skill_router;
  if (sr) {
    const labels = sr.capability_model?.labels;
    if (labels?.length && JSON.stringify(labels) !== JSON.stringify(dimensions) && JSON.stringify(labels) !== JSON.stringify([...dimensions].sort()))
      throw new Error('Incompatible legacy checkpoint labels; files were not changed.');
  }
  applyDeprecated(obj, warnings);
  if (sr) {
    sr.capabilities ??= [...dimensions].sort();
    sr.knob ??= 0;
    sr.systemone ??= { local_path: 'models/systemone' };
    for (const model of sr.models ?? []) {
      for (const key of ['latency_weight', 'reasoning_description']) delete model[key];
    }
  }
  delete obj.complexity_service;
  delete obj.default_reasoning_effort;
  for (const block of [obj.brick, obj.anthropic_passthrough]) {
    if (block) for (const key of obsoleteRouting) delete block[key];
  }
  // Adopt legacy endpoint credentials before deciding the caller-key policy, so
  // an endpoint-supplied key counts as an explicit server-side credential.
  for (const endpoint of obj.provider_endpoints ?? []) {
    if (!endpoint.api_key) continue;
    for (const model of Object.values(obj.model_config ?? {}) as any[]) {
      if (model.preferred_endpoints?.includes(endpoint.name) && !model.access_key && !model.access_key_env) model.access_key = endpoint.api_key;
    }
    delete endpoint.api_key;
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
  return { config: obj, warnings };
}

export function nativeConfig(input: any): any {
  return nativeConfigWithWarnings(input).config;
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
