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
import { loadSkillTable, InvalidRemoteSkillTableError, type SkillResolveOptions } from '../skills/resolver.js';
import { resolveSkillRecord } from '../skills/aliases.js';
import { skillVectorInOrder } from '../skills/table.js';
import { missingCatalogModels, readCodexCatalogForSetup } from '../codex/catalog.js';
import { startPricingWatcher } from '../economy/watch.js';
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

  await warnUnavailableCodexModels(cfg);
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
  // Prices live in the profile's pricing.yaml and are refreshed by a detached
  // hourly watcher, so the router keeps them current after this CLI exits.
  try {
    const watch = await startPricingWatcher(profile);
    if (watch.started) ok(`pricing sync scheduled hourly (pid ${watch.pid})`);
  } catch (error: any) {
    warn(`pricing watcher failed to start: ${error?.message ?? error}`);
  }
  return { port, healthy };
}

/**
 * Metadata-only preflight: compare the active pool with the account's
 * authenticated Codex catalog and warn before the first routed turn. A cache
 * that lags behind the backend is possible, so this never blocks a start.
 */
export async function warnUnavailableCodexModels(cfg: any): Promise<void> {
  if (!cfg?.codex_router?.enabled) return;
  let catalog;
  // Merge in `codex debug models` when the cached subset omits pool models,
  // otherwise a stale cache triggers a spurious "model not listed" warning.
  try { catalog = await readCodexCatalogForSetup(); } catch { return; }
  const missing = missingCatalogModels(cfg, catalog);
  if (missing.length === 0) return;
  warn(`the authenticated Codex catalog does not list ${missing.join(', ')}; if a turn fails, edit the pool (\`brick profile edit\`) or reset it (\`brick start codex --reset-pool\`)`);
}

export async function syncSkillCards(profile: string, options: SkillResolveOptions = {}): Promise<void> {
  const pp = paths(profile);
  let raw: any;
  try { raw = yaml.load(await readFile(pp.config, 'utf8')); } catch { return; }
  if (!raw?.skill_router || !raw?.model_config) return;
  let table: Map<string, any>;
  try {
    table = await loadSkillTable({ warn, ...options });
  } catch (error: any) {
    // A published-table regression or an offline first run must not block the
    // profile: keep the vectors already in the config and say so.
    const reason = error instanceof InvalidRemoteSkillTableError ? `published skill table is invalid (${error.message})` : `skill table unavailable (${error?.message ?? error})`;
    warn(`${reason}; keeping the vectors already configured for profile '${profile}'`);
    return;
  }
  const previous = new Map<string, any>((raw.skill_router.models ?? []).map((entry: any) => [entry.model, entry]));
  const models: any[] = [];
  const missing: string[] = [];
  for (const id of Object.keys(raw.model_config)) {
    const card = resolveSkillRecord(table, id);
    if (!card) {
      // Never drop a pool model because the published table omits it: keep the
      // last known vector (the router can still route) and report it.
      const old = previous.get(id);
      if (old) { models.push({ ...old, model: id }); missing.push(id); }
      continue;
    }
    const old = previous.get(id) ?? {};
    const nextVector = skillVectorInOrder(card, raw.skill_router.capabilities);
    if (Array.isArray(old.skill_vector) && old.skill_vector.length === nextVector.length) {
      const shifts = nextVector.map((value: number, index: number) => [raw.skill_router.capabilities[index], value - old.skill_vector[index]] as const)
        .filter(([, delta]) => Math.abs(delta) >= 0.25);
      if (shifts.length) warn(`large skill-vector change for ${id}: ${shifts.map(([name, delta]) => `${name} ${delta > 0 ? '+' : ''}${delta.toFixed(2)}`).join(', ')}; verify the published table if routing changes unexpectedly`);
    }
    const entry = { ...old, model: id, skill_vector: nextVector };
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
  if (missing.length) warn(`published skill table does not list ${missing.join(', ')}; their previous vectors were kept`);
  ok(`skill table synchronized for profile '${profile}'`);
}
