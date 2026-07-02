import yaml from 'js-yaml';
import { paths } from '../config/paths.js';
import { loadConfigText } from '../config/load.js';
import { saveConfigText } from '../config/save.js';
import { dockerCmd } from '../docker/run.js';
import { isHealthy, waitHealth } from '../docker/serve.js';
import { R_BY_MODE, type ClaudeMode } from '../claude/modes.js';

export type CodexMode = ClaudeMode;
export { MODES, R_BY_MODE } from '../claude/modes.js';

export interface CodexModeApplyResult {
  configPath: string;
  changed: boolean;
  previousR: number | null;
  newR: number;
  pool: string[];
  restartedRouter: boolean;
  routerWasRunning: boolean;
}

class CodexModeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'CodexModeError';
  }
}

function loadObj(text: string, profile: string): any {
  const obj = yaml.load(text) as any;
  if (!obj || typeof obj !== 'object') {
    throw new CodexModeError(`profile '${profile}' has an empty or malformed config.yaml`);
  }
  return obj;
}

export function codexPool(obj: any): string[] {
  const models = obj?.skill_router?.models;
  if (!Array.isArray(models)) return [];
  return models.map((m) => m?.model).filter((m): m is string => typeof m === 'string' && m.length > 0);
}

export function formatCodexPool(models: string[]): string {
  return models.length > 0 ? models.join(', ') : '(empty pool)';
}

export async function applyCodexModeToProfile(profile: string, mode: CodexMode): Promise<CodexModeApplyResult> {
  const text = await loadConfigText(profile);
  const obj = loadObj(text, profile);
  if (!obj.skill_router || typeof obj.skill_router !== 'object') {
    throw new CodexModeError(
      `profile '${profile}' has no skill_router block; run \`brick codex on\` first`
    );
  }
  if (!Array.isArray(obj.skill_router.models) || obj.skill_router.models.length === 0) {
    throw new CodexModeError(`profile '${profile}' has no Codex model pool configured`);
  }

  obj.skill_router.math = obj.skill_router.math && typeof obj.skill_router.math === 'object'
    ? obj.skill_router.math
    : {};
  const previousR = typeof obj.skill_router.math.routing_preference === 'number'
    ? obj.skill_router.math.routing_preference
    : null;
  const newR = R_BY_MODE[mode];
  const changed = previousR !== newR;

  if (changed) {
    obj.skill_router.math.routing_preference = newR;
    const dump = yaml.dump(obj, { lineWidth: 120, noRefs: true, sortKeys: false });
    await saveConfigText(dump, profile);
  }

  const port = typeof obj.server_port === 'number' ? obj.server_port : 8000;
  const routerWasRunning = await isHealthy(port);
  let restartedRouter = false;
  if (changed && routerWasRunning) {
    const container = `brick-${profile}-router`;
    const res = await dockerCmd(['restart', container]);
    if (res.exitCode === 0) {
      await waitHealth(port, 30_000);
      restartedRouter = true;
    }
  }

  return {
    configPath: paths(profile).config,
    changed,
    previousR,
    newR,
    pool: codexPool(obj),
    restartedRouter,
    routerWasRunning,
  };
}
