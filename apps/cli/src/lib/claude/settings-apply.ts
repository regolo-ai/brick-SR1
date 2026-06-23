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
import { dockerCmd } from '../docker/run.js';
import { isHealthy, waitHealth } from '../docker/serve.js';

/** Default trailing-turns window fed to the classifier when context-awareness is on. */
export const DEFAULT_CONTEXT_K = 8;
/** Local classifier endpoint (auto-spawned server.py). */
export const LOCAL_CLASSIFIER_URL = 'http://127.0.0.1:8094';

/** Shown before switching to local compute. No em dashes (house style). */
export const LOCAL_DISCLAIMER =
  'Local classifier inference runs Qwen3.5-0.8B (about 1.6GB VRAM on GPU).\n' +
  'Recommended only on a reasonably performant machine. On CPU it works but\n' +
  'adds roughly 1 to 5 seconds to every routing decision.';

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
 * Switch the classifier compute location. 'local' points at the auto-spawned
 * server.py; 'api' points at a user-supplied remote endpoint with a bearer token.
 * Mirrors the change onto skill_router.complexity_model when present, because the
 * Go router consults that base_url first (newComplexityClient).
 */
export async function applyCompute(
  profile: string,
  mode: ComputeMode,
  api?: { baseUrl: string; token: string; protocol?: 'brick' | 'openai' }
): Promise<SettingsApplyResult> {
  if (mode === 'api' && (!api || !api.baseUrl)) {
    throw new SettingsError('api compute requires a base_url (and usually a bearer token)');
  }
  const obj = loadObj(await loadConfigText(profile), profile);

  const cs = (obj.complexity_service && typeof obj.complexity_service === 'object')
    ? obj.complexity_service
    : {};
  cs.enabled = true;
  if (mode === 'local') {
    cs.base_url = LOCAL_CLASSIFIER_URL;
    cs.auto_spawn = true;
    delete cs.bearer_token;
  } else {
    cs.base_url = api!.baseUrl;
    cs.bearer_token = api!.token;
    cs.protocol = api!.protocol ?? 'openai';
    cs.auto_spawn = false;
  }
  obj.complexity_service = cs;

  // The skill router's complexity_model.base_url takes precedence in Go, so
  // keep it in sync when the block exists.
  const cm = obj.skill_router?.complexity_model;
  if (cm && typeof cm === 'object') {
    cm.base_url = cs.base_url;
    if (mode === 'api') cm.bearer_token = api!.token;
    else delete cm.bearer_token;
  }

  return saveAndRestart(obj, profile, true);
}
