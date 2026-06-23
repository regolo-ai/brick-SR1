// Claude routing modes — quantized presets of the continuous `r` knob
// (math.routing_preference, range [-1, 1]). Each mode rewrites
// anthropic_passthrough.model_map and model_map_1m in the target profile,
// because the Go router today reads ONLY the model_map (it does not yet
// honor routing_preference at the /v1/messages call site). The
// routing_preference field is also written for forward-compat: when the Go
// runtime starts consulting it, no second migration is needed.

import yaml from 'js-yaml';
import { paths } from '../config/paths.js';
import { loadConfigText } from '../config/load.js';
import { saveConfigText } from '../config/save.js';
import { dockerCmd } from '../docker/run.js';
import { isHealthy, waitHealth } from '../docker/serve.js';

export type ClaudeMode = 'eco' | 'lite' | 'mid' | 'pro' | 'max';

export const MODES: readonly ClaudeMode[] = ['eco', 'lite', 'mid', 'pro', 'max'] as const;

/** Continuous routing preference each mode represents. */
export const R_BY_MODE: Record<ClaudeMode, number> = {
  eco: -1,
  lite: -0.5,
  mid: 0,
  pro: 0.5,
  max: 1,
};

// Canonical Claude model IDs the router maps to. Centralized so a future
// model upgrade (e.g. opus-4-7 → opus-4-8) only touches this file.
export const CLAUDE_HAIKU = 'claude-haiku-4-5';
export const CLAUDE_SONNET = 'claude-sonnet-4-6';
export const CLAUDE_OPUS = 'claude-opus-4-8';

interface ModelMap {
  easy: string;
  medium: string;
  hard: string;
}

/**
 * Per-mode 200K context model_map. Monotone: eco floors everything to haiku,
 * max ceilings everything to opus, mid is the default (= passthrough template).
 */
export const MODEL_MAP_BY_MODE: Record<ClaudeMode, ModelMap> = {
  eco:  { easy: CLAUDE_HAIKU,  medium: CLAUDE_HAIKU,  hard: CLAUDE_HAIKU  },
  lite: { easy: CLAUDE_HAIKU,  medium: CLAUDE_HAIKU,  hard: CLAUDE_SONNET },
  mid:  { easy: CLAUDE_HAIKU,  medium: CLAUDE_SONNET, hard: CLAUDE_OPUS   },
  pro:  { easy: CLAUDE_SONNET, medium: CLAUDE_SONNET, hard: CLAUDE_OPUS   },
  max:  { easy: CLAUDE_OPUS,   medium: CLAUDE_OPUS,   hard: CLAUDE_OPUS   },
};

/**
 * Per-mode 1M context model_map. Anthropic gates 1M to sonnet+ only, so
 * easy/medium never go to haiku here regardless of mode.
 */
export const MODEL_MAP_1M_BY_MODE: Record<ClaudeMode, ModelMap> = {
  eco:  { easy: CLAUDE_SONNET, medium: CLAUDE_SONNET, hard: CLAUDE_SONNET },
  lite: { easy: CLAUDE_SONNET, medium: CLAUDE_SONNET, hard: CLAUDE_SONNET },
  mid:  { easy: CLAUDE_SONNET, medium: CLAUDE_SONNET, hard: CLAUDE_OPUS   },
  pro:  { easy: CLAUDE_SONNET, medium: CLAUDE_SONNET, hard: CLAUDE_OPUS   },
  max:  { easy: CLAUDE_OPUS,   medium: CLAUDE_OPUS,   hard: CLAUDE_OPUS   },
};

export interface ModeApplyResult {
  /** Path of the profile config.yaml that was rewritten. */
  configPath: string;
  /** Whether the model_map changed at all (idempotency signal). */
  changed: boolean;
  /** Previous model_map (200K) — for delta display. */
  previousMap: ModelMap;
  /** New model_map (200K). */
  newMap: ModelMap;
  /** Whether the router container was restarted to pick up the change. */
  restartedRouter: boolean;
  /** Whether the router was healthy at all (false → not running). */
  routerWasRunning: boolean;
}

class ModeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ModeError';
  }
}

/**
 * Switch a profile to the given mode. Edits anthropic_passthrough.model_map and
 * model_map_1m, sets skill_router.math.routing_preference, then restarts the
 * router container if it is running so the new config is picked up.
 *
 * Throws ModeError if the profile has no anthropic_passthrough block.
 */
export async function applyModeToProfile(profile: string, mode: ClaudeMode): Promise<ModeApplyResult> {
  const text = await loadConfigText(profile);
  const obj = yaml.load(text) as any;

  if (!obj || typeof obj !== 'object') {
    throw new ModeError(`profile '${profile}' has an empty or malformed config.yaml`);
  }
  if (!obj.anthropic_passthrough || typeof obj.anthropic_passthrough !== 'object') {
    throw new ModeError(
      `profile '${profile}' has no anthropic_passthrough block; mode commands require a passthrough-enabled profile (try \`brick claude on\` to create one)`
    );
  }

  const previousMap: ModelMap = {
    easy:   obj.anthropic_passthrough.model_map?.easy   ?? CLAUDE_HAIKU,
    medium: obj.anthropic_passthrough.model_map?.medium ?? CLAUDE_SONNET,
    hard:   obj.anthropic_passthrough.model_map?.hard   ?? CLAUDE_OPUS,
  };

  const newMap = MODEL_MAP_BY_MODE[mode];
  const newMap1M = MODEL_MAP_1M_BY_MODE[mode];
  const newR = R_BY_MODE[mode];

  // Detect no-op: same maps + same routing_preference already in place.
  const currentR = obj.skill_router?.math?.routing_preference;
  const sameMap =
    previousMap.easy === newMap.easy &&
    previousMap.medium === newMap.medium &&
    previousMap.hard === newMap.hard;
  const same1M =
    obj.anthropic_passthrough.model_map_1m?.easy   === newMap1M.easy &&
    obj.anthropic_passthrough.model_map_1m?.medium === newMap1M.medium &&
    obj.anthropic_passthrough.model_map_1m?.hard   === newMap1M.hard;
  const sameR = currentR === newR;
  // Detect a partial skill_router block left by earlier buggy writes (math
  // without models) — force a rewrite so the repair branch below cleans it up.
  const sr = obj.skill_router;
  const needsRepair =
    sr && typeof sr === 'object' && (!Array.isArray(sr.models) || sr.models.length === 0);
  const changed = !(sameMap && same1M && sameR) || !!needsRepair;

  if (changed) {
    obj.anthropic_passthrough.model_map = { ...newMap };
    obj.anthropic_passthrough.model_map_1m = { ...newMap1M };
    // Set routing_preference for forward-compat WITHOUT creating a partial
    // skill_router block. ConfigSchema's SkillRouterSchema requires `models`
    // (min 1); materializing skill_router from scratch would break
    // `brick claude on` (loadConfig zod validation). On the slim claude
    // profile (no skill_router), record the knob under
    // anthropic_passthrough.routing_preference — innocuous today (Go ignores
    // unknown fields) and trivial to migrate later. Also REPAIR any partial
    // skill_router block left by an earlier buggy version: drop it and
    // migrate the knob to anthropic_passthrough.
    const srIsComplete = sr && typeof sr === 'object' && Array.isArray(sr.models) && sr.models.length > 0;
    if (srIsComplete) {
      sr.math = sr.math && typeof sr.math === 'object' ? sr.math : {};
      sr.math.routing_preference = newR;
    } else {
      if (sr) delete obj.skill_router;
      obj.anthropic_passthrough.routing_preference = newR;
    }

    const dump = yaml.dump(obj, { lineWidth: 120, noRefs: true, sortKeys: false });
    await saveConfigText(dump, profile);
  }

  // Restart the router so the Go binary re-reads config.yaml. We address the
  // router by its container name (matches the bootstrap template
  // `brick-${profile}-router`) instead of the compose project, because the
  // running stack may have a project name that doesn't match what our compose
  // helper would synthesize.
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
    previousMap,
    newMap: { ...newMap },
    restartedRouter,
    routerWasRunning,
  };
}

/** Short label like "haiku / sonnet / opus" for delta display. */
export function formatMap(m: ModelMap): string {
  const short = (id: string): string => {
    if (id.includes('haiku')) return 'haiku';
    if (id.includes('sonnet')) return 'sonnet';
    if (id.includes('opus')) return 'opus';
    return id;
  };
  return `${short(m.easy)} / ${short(m.medium)} / ${short(m.hard)}`;
}
