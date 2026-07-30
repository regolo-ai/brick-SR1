import { ensureDefaultCodexProfile } from './bootstrap.js';
import { readCodexWiring, writeCodexWiring } from './wiring-state.js';
import { paths } from '../config/paths.js';
import { upsertEnvValues } from '../config/env-file.js';
import {
  applyCodexContextAwareness,
  applyCodexModelRouting,
  applyCodexThinkingRouting,
  applyCodexRoutingMode,
  applyCompute,
  type SettingsApplyResult,
  type ComputeMode,
  type CodexRoutingMode,
} from './settings-apply.js';
import { REGOLO_API_KEY_ENV, REGOLO_CLASSIFIER_MODEL } from '../claude/settings-apply.js';
import { err, info, ok, warn } from '../ui/banners.js';

function reportRestart(res: SettingsApplyResult): void {
  if (res.routerWasRunning) {
    if (res.restartedRouter) info('router restarted to pick up the new config.');
    else if (res.changed) warn('router is running but restart failed; restart it manually.');
  } else if (res.changed) {
    warn('router is not running; change takes effect on the next `brick codex on`.');
  }
}

async function codexProfile(exit: (code: number) => never): Promise<string> {
  try {
    return await ensureDefaultCodexProfile();
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }
}

export async function runCodexContext(
  enabled: boolean,
  k: number,
  exit: (code: number) => never,
): Promise<void> {
  const profile = await codexProfile(exit);
  try {
    const res = await applyCodexContextAwareness(profile, enabled, k);
    ok(
      enabled
        ? `Codex context-awareness ON (last ${k} turns) for profile '${profile}'.`
        : `Codex context-awareness OFF for profile '${profile}'.`,
    );
    reportRestart(res);
    const w = readCodexWiring();
    if (w) writeCodexWiring({ ...w, contextAwareness: enabled });
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }
}

export async function runCodexModelRouting(
  enabled: boolean,
  fixedModel: string | undefined,
  exit: (code: number) => never,
): Promise<void> {
  const profile = await codexProfile(exit);
  try {
    const res = await applyCodexModelRouting(profile, enabled, fixedModel);
    ok(
      enabled
        ? `Codex model routing ON for profile '${profile}': Brick picks the model by complexity.`
        : `Codex model routing OFF for profile '${profile}': all traffic pinned to ${fixedModel ?? 'the configured fixed model'}.`,
    );
    reportRestart(res);
    const w = readCodexWiring();
    if (w) writeCodexWiring({ ...w, modelRouting: enabled, ...(fixedModel !== undefined ? { fixedModel } : {}) });
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }
}

export async function runCodexThinkingRouting(
  enabled: boolean,
  exit: (code: number) => never,
): Promise<void> {
  const profile = await codexProfile(exit);
  try {
    const res = await applyCodexThinkingRouting(profile, enabled);
    ok(
      enabled
        ? `Codex thinking routing ON for profile '${profile}': Brick computes reasoning_effort per query.`
        : `Codex thinking routing OFF for profile '${profile}': the client's own effort is forwarded unchanged.`,
    );
    reportRestart(res);
    const w = readCodexWiring();
    if (w) writeCodexWiring({ ...w, thinkingRouting: enabled });
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }
}

export async function runCodexRoutingMode(
  mode: CodexRoutingMode,
  exit: (code: number) => never,
): Promise<void> {
  const profile = await codexProfile(exit);
  try {
    const res = await applyCodexRoutingMode(profile, mode);
    const labels: Record<CodexRoutingMode, string> = {
      off: 'OFF (per-request)',
      sticky: 'STICKY (cache-aware)',
      smartsqueeze: 'SMARTSQUEEZE (cache-aware + compaction)',
      orchestrator: 'ORCHESTRATOR (shadow)',
    };
    ok(`Codex cache-aware routing ${labels[mode]} for profile '${profile}'.`);
    reportRestart(res);
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }
}

export async function runCodexCompute(
  mode: ComputeMode,
  api: { baseUrl?: string; token?: string; model?: string } | undefined,
  exit: (code: number) => never,
): Promise<void> {
  const profile = await codexProfile(exit);
  try {
    if (mode === 'api' && api?.token) {
      const pp = paths(profile);
      await upsertEnvValues(pp.env, { [REGOLO_API_KEY_ENV]: api.token });
    }
    const res = await applyCompute(profile, mode, api);
    ok(
      mode === 'local'
        ? `classifier compute set to LOCAL for Codex profile '${profile}'.`
        : `classifier compute set to API (Regolo ${REGOLO_CLASSIFIER_MODEL}) for Codex profile '${profile}'.`,
    );
    reportRestart(res);
    const w = readCodexWiring();
    if (w) writeCodexWiring({ ...w, computeMode: mode });
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }
}
