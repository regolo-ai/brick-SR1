import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, rename, rm, copyFile, access } from 'node:fs/promises';
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

// These fields belonged to components never called by the Brick HTTP runtime.
const retired = ['model', 'config_source', 'mom_registry', 'external_models', 'semantic_cache', 'memory', 'vector_store', 'response_api', 'router_replay', 'looper', 'api', 'clear_route_cache', 'authz', 'ratelimit', 'embedding_models', 'bert_model', 'classifier', 'prompt_guard', 'hallucination_mitigation', 'feedback_detector', 'modality_detector', 'decisions', 'strategy', 'model_selection', 'keyword_rules', 'embedding_rules', 'categories', 'fact_check_rules', 'user_feedback_rules', 'preference_rules', 'language_rules', 'context_rules', 'modality_rules', 'role_bindings', 'tools', 'plugins', 'image_gen_backends', 'modality_routes', 'text_routes'];
const spawnFields = ['auto_spawn', 'script_path', 'device', 'base_model_id'];

/** Pure, deterministic migration. Inspect every incompatible value before writing. */
export function nativeConfig(input: any): any {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Profile must contain a YAML object.');
  if (input.config_version !== undefined && input.config_version !== 1) throw new Error(`Unsupported profile config_version: ${input.config_version}`);
  const obj = structuredClone(input);
  if (input.config_version === 1) {
    validateFields(obj, fieldSchema);
    return obj;
  }
  for (const cs of [obj.complexity_service, obj.skill_router?.complexity_model]) {
    if (!cs) continue;
    if (!cs.base_url && cs.address) cs.base_url = `http://${cs.address}:${cs.port || 8094}`;
    let local = false;
    try { const url = new URL(cs.base_url); local = ['classifier', 'host.docker.internal'].includes(url.hostname) || ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '8094'; } catch {}
    if (cs.auto_spawn === true || local || (!cs.base_url && cs.address === 'classifier')) {
      throw new Error('This profile requires the retired local complexity server. Configure the classifier API base_url, protocol, model_name and credential before migration; files were not changed.');
    }
    if (cs.enabled === true && !cs.base_url) throw new Error('Configure the classifier API base_url before migration; files were not changed.');
    for (const key of [...spawnFields, 'address', 'port']) delete cs[key];
  }
  // Encode the old implicit caller-key policy once, during migration. Runtime
  // authentication never infers its source from a provider name or domain.
  if (input.config_version === undefined && !obj.codex_router?.enabled) {
    const regoloURL = (value: string) => { try { const host = new URL(value).hostname; return host === 'regolo.ai' || host.endsWith('.regolo.ai'); } catch { return false; } };
    for (const [name, model] of Object.entries(obj.model_config ?? {}) as [string, any][]) {
      const skill = obj.skill_router?.models?.find((entry: any) => entry.model === name);
      const legacy = regoloURL(skill?.base_url) || (model.preferred_endpoints ?? []).some((id: string) => {
        const endpoint = obj.provider_endpoints?.find((entry: any) => entry.name === id);
        return ['regolo', 'regoloai'].includes(id) || ['regolo', 'regoloai'].includes(endpoint?.provider_profile) || regoloURL(obj.provider_profiles?.[endpoint?.provider_profile]?.base_url);
      });
      const implicitCaller = !model.access_key && !model.access_key_env && !model.api_key_env && !model.api_key_file && !skill?.api_key && !skill?.api_key_env && !skill?.api_key_file;
      if ((legacy || implicitCaller) && model.use_client_key === undefined) model.use_client_key = true;
    }
    for (const cs of [obj.complexity_service, obj.skill_router?.complexity_model]) {
      if (cs && cs.use_client_key === undefined && regoloURL(cs.base_url)) cs.use_client_key = true;
    }
  }
  if (obj.observability) {
    delete obj.observability.tracing;
    if (obj.observability.metrics) delete obj.observability.metrics.windowed_metrics;
  }
  for (const key of retired) delete obj[key];
  for (const endpoint of obj.provider_endpoints ?? []) delete endpoint.api_key;
  for (const provider of Object.values(obj.providers ?? {}) as any[]) delete provider.type;
  for (const family of Object.values(obj.reasoning_families ?? {}) as any[]) delete family.type;
  if (obj.skill_router?.capability_model) {
    delete obj.skill_router.capability_model.repo_id;
    delete obj.skill_router.capability_model.use_cpu;
  }
  if (obj.skill_router?.math) delete obj.skill_router.math.prior_strength;
  for (const model of Object.values(obj.model_config ?? {}) as any[]) {
    for (const key of ['loras', 'description', 'capabilities', 'quality_score', 'modality', 'image_gen_backend', 'param_size', 'api_format', 'pricing', 'reasoning_description']) delete model[key];
  }
  for (const model of obj.skill_router?.models ?? []) delete model.reasoning_description;
  obj.config_version = 1;
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
  if (original.config_version !== 1) {
    for (const name of ['docker-compose.yml', 'docker-compose.yaml']) {
      try { await access(join(pp.profileDir, name)); console.warn('Legacy container configuration found. Old containers may still occupy the profile port; stop them explicitly before starting the native runtime. Migration does not stop or remove containers.'); break; }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  if (JSON.stringify(original) === JSON.stringify(migrated)) return;
  const id = randomUUID();
  const backup = join(pp.profileDir, 'backups', `native-v1-${id}`);
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
