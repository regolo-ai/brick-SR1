import { refreshOfficialHarness } from '../harness.js';
import { createRequire } from 'node:module';
import { atomicWrite } from '../config/atomic-file.js';
import yaml from 'js-yaml';
import { readFile,stat } from 'node:fs/promises';
import { discoverAndApplyContextWindows } from '../catalog/context-discovery.js';
import { catalog } from '../catalog/index.js';
import { applyModelTransport,resolveModelTransport } from '../catalog/transport.js';
import { readEnvValue,upsertEnvValues } from '../config/env-file.js';
import { loadConfig } from '../config/load.js';
import { paths,updateState } from '../config/paths.js';
import { loadSkillTable } from '../skills/resolver.js';
import { ok,warn } from '../ui/banners.js';
import * as p from '../ui/prompts.js';
import { runtimeStatus,startRuntime } from './process.js';

export interface EnsureServingResult {
  port: number;
  healthy: boolean;
}

/**
 * Start a profile's native runtime and wait for routing readiness.
 * Shared by the start and restart commands.
 * Throws (string message) on unrecoverable setup errors (missing configuration, assets, or process startup).
 */
export async function ensureServing(
  profile: string,
  opts: { forceRecreate?: boolean; skillSync?: boolean } = {}
): Promise<EnsureServingResult> {
  createRequire(import.meta.url)('../../../scripts/runtime-install.cjs').installedRuntime();
  const pp = paths(profile);
  try { await stat(pp.config); } catch { throw new Error(`no config at ${pp.config}. run \`brick profile create ${profile}\` first.`); }

  let cfg = await loadConfig(profile);
  if (cfg.skill_router?.enabled && (cfg.skill_router.active_models?.length ?? cfg.skill_router.models.length) === 0) {
    throw new Error(`profile '${profile}' has no active models. Run \`brick profile edit ${profile}\` to select models.`);
  }
  const port = cfg.server_port;

  for (const ep of (cfg as any).provider_endpoints ?? []) {
    const prov = (cfg as any).providers?.[ep.provider_profile];
    if (!prov) continue;
    const catId = ((catalog as any)[ep.provider_profile] ? ep.provider_profile : Object.keys(catalog).find((k) => catalog[k as any]?.base_url?.replace(/\/+$/, '') === prov.base_url?.replace(/\/+$/, '')) ?? ep.provider_profile);
    const cat: any = (catalog as any)[catId];
    const envKey: string | undefined = cat?.env_key;
    const isOptional = catId === 'openai-codex' || catId === 'claude-code';
    if (!envKey || isOptional) continue;
    const stored = await readEnvValue(pp.env, envKey) ?? (process.env as any)[envKey];
    if (!stored || !String(stored).trim()) {
      if (process.stdin.isTTY) {
        const v: any = await (p as any).password({ message: `${envKey} is missing for ${ep.name} — enter it (stored in ${pp.env}):` });
        if (p.isCancel(v)) { warn(`API key for ${ep.name} not set — provider will fail at runtime`); continue; }
        const val = String(v).trim();
        if (val) { await upsertEnvValues(pp.env, { [envKey]: val }); ok(`${envKey} saved to ${pp.env}`); }
        else warn(`API key for ${ep.name} not set — provider will fail at runtime`);
      } else {
        warn(`${envKey} missing for ${ep.name} — set it in ${pp.env} or env`);
      }
    }
  }

  await discoverAndApplyContextWindows(profile, cfg);
  if (opts.skillSync !== false) await syncSkillCards(profile);
  cfg = await loadConfig(profile);

  await startRuntime(profile, port, opts.forceRecreate === true);
  const status = await runtimeStatus(profile);
  const healthy = status?.routingReady === true;
  if (healthy) {
    updateState({ runningProfile: profile });
    if (opts.forceRecreate) await refreshOfficialHarness(profile, port);
  }
  else warn('Runtime is reachable but classification is unavailable; inspect brick logs.');
  return { port, healthy };
}

export async function syncSkillCards(profile: string): Promise<void> {
  const pp = paths(profile);
  let raw: any;
  try { raw = yaml.load(await readFile(pp.config, 'utf8')); } catch { return; }
  if (!raw?.skill_router || !raw?.model_config) return;
  const table = await loadSkillTable({ warn });
  const previous = new Map<string, any>((raw.skill_router.models ?? []).map((entry: any) => [entry.model, entry]));
  const models: any[] = [];
  for (const id of Object.keys(raw.model_config)) {
    const card = table.get(id);
    if (!card) continue;
    const old = previous.get(id) ?? {};
    const entry = { ...old, model: id, skill_vector: [...card.skill_vector] };
    for (const key of ['source', 'confidence', 'provider', 'support', 'subset_hash', 'notes', 'sources', 'alias_of', 'capabilities', 'skill_source', 'skill_confidence', 'skill_card_metadata']) delete entry[key];
    applyModelTransport(entry, resolveModelTransport(id, raw.model_config, raw.provider_profiles, raw.provider_endpoints));
    models.push(entry);
  }
  const valid = new Set(models.map((entry) => entry.model));
  const requested = Array.isArray(raw.skill_router.active_models) ? raw.skill_router.active_models : [...previous.keys()];
  raw.skill_router.models = models;
  raw.skill_router.active_models = requested.filter((id: string) => valid.has(id));
  if (!valid.has(raw.default_model)) raw.default_model = raw.skill_router.active_models[0] ?? '';
  await atomicWrite(pp.config, yaml.dump(raw, { lineWidth: 120, noRefs: true, sortKeys: false }), 0o600);
  ok(`skill table synchronized for profile '${profile}'`);
}
