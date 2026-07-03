// Apply "brick claude settings" toggles to a profile's config.yaml.
//
// Like modes.ts, these helpers edit the RAW YAML (loadConfigText / saveConfigText)
// rather than the zod-validated config: anthropic_passthrough lives outside
// ConfigSchema and would be stripped by a parse round-trip. After writing, the
// router container is restarted (if running) so the Go binary re-reads the file.

import yaml from 'js-yaml';
import { paths } from '../config/paths.js';
import { loadConfigText } from '../config/load.js';
import { saveConfigText } from '../config/save.js';
import { dockerCmd, dockerCompose } from '../docker/run.js';
import { isHealthy, waitHealth } from '../docker/serve.js';
import { renderClaudeCompose, DEFAULT_CLAUDE_PORT } from './bootstrap.js';

/** Default trailing-turns window fed to the classifier when context-awareness is on. */
export const DEFAULT_CONTEXT_K = 8;
/** Local classifier endpoint (auto-spawned server.py). */
export const LOCAL_CLASSIFIER_URL = 'http://127.0.0.1:8094';

/**
 * Hosted classifier defaults: the "api" compute mode points at Regolo's
 * OpenAI-compatible endpoint running brick-complexity-pro, so a user who does
 * not want to self-host only needs to supply their Regolo API key. The base
 * URL and model are fixed (not prompted) — a custom third-party endpoint is a
 * separate, advanced path.
 */
export const REGOLO_CLASSIFIER_URL = 'https://api.regolo.ai';
export const REGOLO_CLASSIFIER_MODEL = 'brick-complexity-pro';
/** Env var the router expands for the Regolo classifier bearer token. */
export const REGOLO_API_KEY_ENV = 'REGOLO_API_KEY';
/** Where a user creates a Regolo account and gets an API key. */
export const REGOLO_SIGNUP_URL = 'https://regolo.ai/signup';

/** Shown before switching to local compute. No em dashes (house style). */
export const LOCAL_DISCLAIMER =
  'Local classifier inference runs Qwen3.5-0.8B (about 1.6GB VRAM on GPU).\n' +
  'Recommended only on a reasonably performant machine. On CPU it works but\n' +
  'adds roughly 1 to 5 seconds to every routing decision.';

/** Shown before asking for the Regolo API key in api compute mode. */
export const REGOLO_API_KEY_HELP =
  'The hosted classifier uses Regolo (brick-complexity-pro).\n' +
  'No API key yet? Create one in a minute at ' + REGOLO_SIGNUP_URL + '\n' +
  'then paste it here. It is saved to the profile .env, never in the YAML.';

export type ComputeMode = 'local' | 'api';

export interface SettingsApplyResult {
  configPath: string;
  changed: boolean;
  restartedRouter: boolean;
  routerWasRunning: boolean;
}

class SettingsError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SettingsError';
  }
}

function loadObj(text: string, profile: string): any {
  const obj = yaml.load(text) as any;
  if (!obj || typeof obj !== 'object') {
    throw new SettingsError(`profile '${profile}' has an empty or malformed config.yaml`);
  }
  return obj;
}

async function saveAndRestart(obj: any, profile: string, changed: boolean): Promise<SettingsApplyResult> {
  if (changed) {
    const dump = yaml.dump(obj, { lineWidth: 120, noRefs: true, sortKeys: false });
    await saveConfigText(dump, profile);
  }
  const port = typeof obj.server_port === 'number' ? obj.server_port : 8000;
  const routerWasRunning = await isHealthy(port);
  let restartedRouter = false;
  if (changed && routerWasRunning) {
    const res = await dockerCmd(['restart', `brick-${profile}-router`]);
    if (res.exitCode === 0) {
      await waitHealth(port, 30_000);
      restartedRouter = true;
    }
  }
  return { configPath: paths(profile).config, changed, restartedRouter, routerWasRunning };
}

/**
 * Toggle context-awareness: writes anthropic_passthrough.context_window.
 * Requires an anthropic_passthrough block (created by `brick claude on`).
 */
export async function applyContextAwareness(
  profile: string,
  enabled: boolean,
  k: number = DEFAULT_CONTEXT_K
): Promise<SettingsApplyResult> {
  const obj = loadObj(await loadConfigText(profile), profile);
  if (!obj.anthropic_passthrough || typeof obj.anthropic_passthrough !== 'object') {
    throw new SettingsError(
      `profile '${profile}' has no anthropic_passthrough block; run \`brick claude on\` first`
    );
  }
  const cur = obj.anthropic_passthrough.context_window;
  const changed = !cur || cur.enabled !== enabled || (enabled && cur.k !== k);
  if (changed) {
    obj.anthropic_passthrough.context_window = enabled ? { enabled: true, k } : { enabled: false };
  }
  return saveAndRestart(obj, profile, changed);
}

/**
 * Toggle subagent routing: writes anthropic_passthrough.route_subagents. When on,
 * requests that arrive with an explicit native Claude model (Claude Code
 * subagents) are pulled through the skill router instead of bypassing it.
 * Requires an anthropic_passthrough block (created by `brick claude on`).
 */
export async function applySubagentRouting(
  profile: string,
  enabled: boolean
): Promise<SettingsApplyResult> {
  const obj = loadObj(await loadConfigText(profile), profile);
  if (!obj.anthropic_passthrough || typeof obj.anthropic_passthrough !== 'object') {
    throw new SettingsError(
      `profile '${profile}' has no anthropic_passthrough block; run \`brick claude on\` first`
    );
  }
  const changed = obj.anthropic_passthrough.route_subagents !== enabled;
  if (changed) {
    obj.anthropic_passthrough.route_subagents = enabled;
  }
  return saveAndRestart(obj, profile, changed);
}

/**
 * Toggle model routing: writes anthropic_passthrough.use_model_routing. When off,
 * every brick-routed request is pinned to fixed_model instead of being chosen by
 * complexity. When a fixedModel is supplied it is written to
 * anthropic_passthrough.fixed_model; pass undefined to leave the existing value.
 * Requires an anthropic_passthrough block (created by `brick claude on`).
 */
export async function applyModelRouting(
  profile: string,
  enabled: boolean,
  fixedModel?: string
): Promise<SettingsApplyResult> {
  const obj = loadObj(await loadConfigText(profile), profile);
  if (!obj.anthropic_passthrough || typeof obj.anthropic_passthrough !== 'object') {
    throw new SettingsError(
      `profile '${profile}' has no anthropic_passthrough block; run \`brick claude on\` first`
    );
  }
  const ap = obj.anthropic_passthrough;
  let changed = ap.use_model_routing !== enabled;
  if (ap.use_model_routing !== enabled) {
    ap.use_model_routing = enabled;
  }
  if (!enabled && fixedModel !== undefined && ap.fixed_model !== fixedModel) {
    ap.fixed_model = fixedModel;
    changed = true;
  }
  return saveAndRestart(obj, profile, changed);
}

/**
 * Toggle thinking routing: writes anthropic_passthrough.use_thinking_routing.
 * When off, Brick forwards the client's own output_config.effort unchanged
 * instead of injecting an autonomously-computed reasoning effort.
 * Requires an anthropic_passthrough block (created by `brick claude on`).
 */
export async function applyThinkingRouting(
  profile: string,
  enabled: boolean
): Promise<SettingsApplyResult> {
  const obj = loadObj(await loadConfigText(profile), profile);
  if (!obj.anthropic_passthrough || typeof obj.anthropic_passthrough !== 'object') {
    throw new SettingsError(
      `profile '${profile}' has no anthropic_passthrough block; run \`brick claude on\` first`
    );
  }
  const changed = obj.anthropic_passthrough.use_thinking_routing !== enabled;
  if (changed) {
    obj.anthropic_passthrough.use_thinking_routing = enabled;
  }
  return saveAndRestart(obj, profile, changed);
}

/**
 * Pure transform: mutate a parsed config object's complexity_service (and
 * skill_router.complexity_model, when present) for the given compute mode.
 * Extracted from applyCompute so it can be unit-tested without filesystem or
 * docker I/O. 'local' points at the auto-spawned server.py; 'api' points at
 * the hosted Regolo classifier (base_url/model overridable for an advanced
 * custom endpoint), storing the bearer token as an env reference
 * (${REGOLO_API_KEY}) so the literal key never lands in the YAML.
 */
export function applyComputeToConfig(
  obj: any,
  mode: ComputeMode,
  api?: { baseUrl?: string; model?: string; protocol?: 'brick' | 'openai' }
): void {
  const apiBaseUrl = api?.baseUrl || REGOLO_CLASSIFIER_URL;
  const apiModel = api?.model || REGOLO_CLASSIFIER_MODEL;
  const apiBearer = '${' + REGOLO_API_KEY_ENV + '}';

  const cs = (obj.complexity_service && typeof obj.complexity_service === 'object')
    ? obj.complexity_service
    : {};
  cs.enabled = true;
  if (mode === 'local') {
    cs.base_url = LOCAL_CLASSIFIER_URL;
    cs.auto_spawn = true;
    delete cs.protocol;
    delete cs.model_name;
    delete cs.bearer_token;
  } else {
    cs.base_url = apiBaseUrl;
    cs.protocol = api?.protocol ?? 'openai';
    cs.model_name = apiModel;
    cs.bearer_token = apiBearer;
    cs.auto_spawn = false;
  }
  obj.complexity_service = cs;

  // The skill router's complexity_model.base_url takes precedence in Go, so
  // keep it in sync when the block exists.
  const cm = obj.skill_router?.complexity_model;
  if (cm && typeof cm === 'object') {
    cm.base_url = cs.base_url;
    if (mode === 'api') {
      cm.protocol = cs.protocol;
      cm.model_name = apiModel;
      cm.bearer_token = apiBearer;
    } else {
      delete cm.protocol;
      delete cm.model_name;
      delete cm.bearer_token;
    }
  }
}

/**
 * Switch the classifier compute location. 'local' points at the auto-spawned
 * server.py; 'api' points at the hosted Regolo classifier (or a custom endpoint
 * when overridden). Mirrors the change onto skill_router.complexity_model when
 * present, because the Go router consults that base_url first.
 */
export async function applyCompute(
  profile: string,
  mode: ComputeMode,
  api?: { baseUrl?: string; token?: string; model?: string; protocol?: 'brick' | 'openai' }
): Promise<SettingsApplyResult> {
  const obj = loadObj(await loadConfigText(profile), profile);

  // Snapshot the blocks we touch so a re-selection of the already-active mode is
  // a no-op: no rewrite, no router restart ("if nothing changed, close it").
  const before = JSON.stringify([
    obj.complexity_service ?? null,
    obj.skill_router?.complexity_model ?? null,
  ]);

  applyComputeToConfig(obj, mode, api);

  const after = JSON.stringify([
    obj.complexity_service ?? null,
    obj.skill_router?.complexity_model ?? null,
  ]);
  const configChanged = after !== before;

  if (configChanged) {
    const dump = yaml.dump(obj, { lineWidth: 120, noRefs: true, sortKeys: false });
    await saveConfigText(dump, profile);
  }

  // Compute mode changes the container topology and env, not just the mounted
  // config: local mode adds the classifier sidecar and injects
  // BRICK_CLASSIFIER_TOKEN, api mode is router-only with REGOLO_API_KEY. A plain
  // `docker restart` keeps the OLD environment, so the router would expand
  // ${REGOLO_API_KEY} against a var the container never received (empty -> the
  // hosted classifier 403s -> every request falls back to "medium"). Regenerate
  // the compose to the correct shape and recreate the container via compose up.
  const port = typeof obj.server_port === 'number' ? obj.server_port : DEFAULT_CLAUDE_PORT;
  const composeChanged = renderClaudeCompose(profile, mode === 'local', port);

  const routerWasRunning = await isHealthy(port);
  let restartedRouter = false;
  if (routerWasRunning && (configChanged || composeChanged)) {
    // `up -d --remove-orphans` recreates the router when the compose env changed
    // and drops/starts the classifier sidecar to match the new topology.
    const res = await dockerCompose(profile, ['up', '-d', '--remove-orphans']);
    if (res.exitCode === 0) {
      await waitHealth(port, 60_000);
      restartedRouter = true;
    }
  }

  return { configPath: paths(profile).config, changed: configChanged || composeChanged, restartedRouter, routerWasRunning };
}
