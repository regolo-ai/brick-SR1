// Shared command bodies for `brick claude settings context|compute`, mirroring
// runMode.ts. Keeps profile resolution, apply, restart reporting, and wiring
// persistence in one place so the leaf commands and the interactive menu agree.

import { paths, resolveProfile } from '../config/paths.js';
import { upsertEnvValues } from '../config/env-file.js';
import { readWiring, writeWiring } from './wiring-state.js';
import {
  applyContextAwareness,
  applyCompute,
  applySubagentRouting,
  applyModelRouting,
  applyThinkingRouting,
  REGOLO_API_KEY_ENV,
  REGOLO_CLASSIFIER_MODEL,
  type SettingsApplyResult,
  type ComputeMode,
} from './settings-apply.js';
import { err, info, ok, warn } from '../ui/banners.js';

function reportRestart(res: SettingsApplyResult): void {
  if (res.routerWasRunning) {
    if (res.restartedRouter) info('router restarted to pick up the new config.');
    else if (res.changed) warn('router is running but restart failed; restart it manually.');
  } else if (res.changed) {
    warn('router is not running; change takes effect on the next `brick claude on`.');
  }
}

export async function runContext(
  enabled: boolean,
  k: number,
  exit: (code: number) => never,
): Promise<void> {
  let profile: string;
  try {
    profile = resolveProfile();
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }
  try {
    const res = await applyContextAwareness(profile, enabled, k);
    ok(
      enabled
        ? `context-awareness ON (last ${k} turns) for profile '${profile}'.`
        : `context-awareness OFF for profile '${profile}'.`,
    );
    reportRestart(res);
    const w = readWiring();
    if (w) writeWiring({ ...w, contextAwareness: enabled });
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }
}

export async function runSubagents(
  enabled: boolean,
  exit: (code: number) => never,
): Promise<void> {
  let profile: string;
  try {
    profile = resolveProfile();
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }
  try {
    const res = await applySubagentRouting(profile, enabled);
    ok(
      enabled
        ? `subagent routing ON for profile '${profile}': native-model subagents now go through Brick.`
        : `subagent routing OFF for profile '${profile}': native-model subagents bypass Brick.`,
    );
    reportRestart(res);
    const w = readWiring();
    if (w) writeWiring({ ...w, routeSubagents: enabled });
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }
}

export async function runModelRouting(
  enabled: boolean,
  fixedModel: string | undefined,
  exit: (code: number) => never,
): Promise<void> {
  let profile: string;
  try {
    profile = resolveProfile();
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }
  try {
    const res = await applyModelRouting(profile, enabled, fixedModel);
    ok(
      enabled
        ? `model routing ON for profile '${profile}': Brick picks the model by complexity.`
        : `model routing OFF for profile '${profile}': all traffic pinned to ${fixedModel ?? 'the configured fixed model'}.`,
    );
    reportRestart(res);
    const w = readWiring();
    if (w) writeWiring({ ...w, modelRouting: enabled, ...(fixedModel !== undefined ? { fixedModel } : {}) });
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }
}

export async function runThinkingRouting(
  enabled: boolean,
  exit: (code: number) => never,
): Promise<void> {
  let profile: string;
  try {
    profile = resolveProfile();
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }
  try {
    const res = await applyThinkingRouting(profile, enabled);
    ok(
      enabled
        ? `thinking routing ON for profile '${profile}': Brick computes the reasoning effort per query.`
        : `thinking routing OFF for profile '${profile}': the client's own effort is forwarded unchanged.`,
    );
    reportRestart(res);
    const w = readWiring();
    if (w) writeWiring({ ...w, thinkingRouting: enabled });
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }
}

export async function runCompute(
  mode: ComputeMode,
  api: { baseUrl?: string; token?: string; model?: string } | undefined,
  exit: (code: number) => never,
  profileOverride?: string,
): Promise<void> {
  let profile: string;
  try {
    // An explicit profile (e.g. from `brick claude on` / `brick codex on`,
    // which resolve their own profile) must win over the active profile so
    // the compute switch never targets a different profile than the caller.
    profile = profileOverride && profileOverride.trim() !== '' ? profileOverride : resolveProfile();
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }
  try {
    // For api mode, persist the Regolo API key to the profile .env so the
    // router expands ${REGOLO_API_KEY} at startup; the YAML only ever holds
    // the env reference, never the literal key.
    if (mode === 'api' && api?.token) {
      const pp = paths(profile);
      await upsertEnvValues(pp.env, { [REGOLO_API_KEY_ENV]: api.token });
    }
    const res = await applyCompute(profile, mode, api);
    ok(
      mode === 'local'
        ? `classifier compute set to LOCAL for profile '${profile}'.`
        : `classifier compute set to API (Regolo ${REGOLO_CLASSIFIER_MODEL}) for profile '${profile}'.`,
    );
    reportRestart(res);
    // Only the interactive `settings compute` path (no explicit profile) owns
    // the Claude wiring-state record. When invoked with an explicit profile
    // (from `brick claude/codex on`), those commands manage wiring themselves,
    // and a codex-profile compute switch must not rewrite the Claude record.
    if (!profileOverride) {
      const w = readWiring();
      if (w) writeWiring({ ...w, computeMode: mode });
    }
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }
}
