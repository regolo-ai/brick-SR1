// Shared command body for the five `brick claude <mode>` subcommands.
// Each oclif command class delegates here so we keep the routing-preference
// translation in one place.

import { resolveProfile } from '../config/paths.js';
import { readWiring, writeWiring } from './wiring-state.js';
import {
  applyModeToProfile,
  formatMap,
  R_BY_MODE,
  type ClaudeMode,
} from './modes.js';
import { banner, err, info, ok, print, warn } from '../ui/banners.js';

export async function runClaudeMode(
  mode: ClaudeMode,
  exit: (code: number) => never,
): Promise<void> {
  banner();
  let profile: string;
  try {
    profile = resolveProfile();
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }

  let result: Awaited<ReturnType<typeof applyModeToProfile>>;
  try {
    result = await applyModeToProfile(profile, mode);
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }

  if (!result.changed) {
    ok(`profile '${profile}' already in ${mode} mode (r=${R_BY_MODE[mode]}).`);
  } else {
    ok(`profile '${profile}' switched to ${mode} mode (r=${R_BY_MODE[mode]}).`);
    print(`  was: ${formatMap(result.previousMap)}`);
    print(`  now: ${formatMap(result.newMap)}`);
  }

  if (result.routerWasRunning) {
    if (result.restartedRouter) {
      info('router restarted to pick up the new config.');
    } else if (result.changed) {
      warn('router is running but restart failed; run `docker compose -f ' +
           result.configPath.replace(/config\.yaml$/, 'docker-compose.yml') +
           ' restart router` manually.');
    }
  } else if (result.changed) {
    warn('router is not running; mode will take effect on the next `brick claude on`.');
  }

  // Update wiring file's `mode` field if we are wired. Non-blocking.
  const wiring = readWiring();
  if (wiring) {
    writeWiring({ ...wiring, mode });
  }
}
