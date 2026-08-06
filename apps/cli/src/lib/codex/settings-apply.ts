import yaml from 'js-yaml';
import { paths } from '../config/paths.js';
import { loadConfigText } from '../config/load.js';
import { saveConfigText } from '../config/save.js';
import { dockerCmd } from '../docker/run.js';
import { isHealthy, waitHealth } from '../docker/serve.js';
import { DEFAULT_CONTEXT_K } from '../claude/settings-apply.js';
export {
  DEFAULT_CONTEXT_K,
  LOCAL_CLASSIFIER_URL,
  LOCAL_DISCLAIMER,
  REGOLO_API_KEY_HELP,
  applyCompute,
  type ComputeMode,
  type SettingsApplyResult,
} from '../claude/settings-apply.js';
export type CodexRoutingMode = 'off' | 'sticky' | 'smartsqueeze' | 'orchestrator';
import type { SettingsApplyResult } from '../claude/settings-apply.js';

class CodexSettingsError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'CodexSettingsError';
  }
}

function loadObj(text: string, profile: string): any {
  const obj = yaml.load(text) as any;
  if (!obj || typeof obj !== 'object') {
    throw new CodexSettingsError(`profile '${profile}' has an empty or malformed config.yaml`);
  }
  return obj;
}

function ensureBrick(obj: any): any {
  if (!obj.brick || typeof obj.brick !== 'object') {
    obj.brick = {};
  }
  if (typeof obj.brick.enabled !== 'boolean') {
    obj.brick.enabled = true;
  }
  return obj.brick;
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

export async function saveCodexConfigAndRestart(
  profile: string,
  obj: any,
  changed: boolean,
): Promise<SettingsApplyResult> {
  return saveAndRestart(obj, profile, changed);
}

export async function applyCodexContextAwareness(
  profile: string,
  enabled: boolean,
  k: number = DEFAULT_CONTEXT_K,
): Promise<SettingsApplyResult> {
  const obj = loadObj(await loadConfigText(profile), profile);
  const brick = ensureBrick(obj);
  const cur = brick.context_window;
  const next = enabled ? { enabled: true, k } : { enabled: false };
  const changed = !cur || cur.enabled !== next.enabled || cur.k !== next.k;
  if (changed) {
    brick.context_window = next;
  }
  return saveAndRestart(obj, profile, changed);
}

export async function applyCodexRoutingMode(
  profile: string,
  mode: CodexRoutingMode,
): Promise<SettingsApplyResult> {
  const obj = loadObj(await loadConfigText(profile), profile);
  const changed = applyCodexRoutingModeToConfig(obj, mode);
  return saveAndRestart(obj, profile, changed);
}

export function applyCodexRoutingModeToConfig(obj: any, mode: CodexRoutingMode): boolean {
  const brick = ensureBrick(obj);
  const current: CodexRoutingMode =
    brick.routing_mode === 'off' ||
    brick.routing_mode === 'sticky' ||
    brick.routing_mode === 'smartsqueeze' ||
    brick.routing_mode === 'orchestrator'
      ? brick.routing_mode
      : 'smartsqueeze';
  const changed = current !== mode;
  if (changed) {
    // Keep an explicit "off": an absent key means the Codex default
    // (smartsqueeze), so deleting it would make it impossible to opt out.
    brick.routing_mode = mode;
  }
  return changed;
}

export async function applyCodexModelRouting(
  profile: string,
  enabled: boolean,
  fixedModel?: string,
): Promise<SettingsApplyResult> {
  const obj = loadObj(await loadConfigText(profile), profile);
  const brick = ensureBrick(obj);
  let changed = brick.use_model_routing !== enabled;
  if (brick.use_model_routing !== enabled) {
    brick.use_model_routing = enabled;
  }
  if (!enabled && fixedModel !== undefined && brick.fixed_model !== fixedModel) {
    brick.fixed_model = fixedModel;
    changed = true;
  }
  return saveAndRestart(obj, profile, changed);
}

export async function applyCodexThinkingRouting(
  profile: string,
  enabled: boolean,
): Promise<SettingsApplyResult> {
  const obj = loadObj(await loadConfigText(profile), profile);
  if (!obj.skill_router || typeof obj.skill_router !== 'object') {
    throw new CodexSettingsError(
      `profile '${profile}' has no skill_router block; run \`brick codex on\` first`
    );
  }
  const changed = obj.skill_router.dynamic_effort !== enabled;
  if (changed) {
    obj.skill_router.dynamic_effort = enabled;
  }
  return saveAndRestart(obj, profile, changed);
}
