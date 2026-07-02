import { ensureDefaultCodexProfile } from './bootstrap.js';
import { readCodexWiring, writeCodexWiring } from './wiring-state.js';
import {
  applyCodexModeToProfile,
  formatCodexPool,
  R_BY_MODE,
  type CodexMode,
} from './modes.js';
import { banner, err, info, ok, print, warn } from '../ui/banners.js';

export async function runCodexMode(
  mode: CodexMode,
  exit: (code: number) => never,
): Promise<void> {
  banner();
  let profile: string;
  try {
    profile = await ensureDefaultCodexProfile();
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }

  let result: Awaited<ReturnType<typeof applyCodexModeToProfile>>;
  try {
    result = await applyCodexModeToProfile(profile, mode);
  } catch (e: any) {
    err(e?.message ?? String(e));
    exit(1);
  }

  if (!result.changed) {
    ok(`Codex profile '${profile}' already in ${mode} mode (r=${R_BY_MODE[mode]}).`);
  } else {
    ok(`Codex profile '${profile}' switched to ${mode} mode (r=${R_BY_MODE[mode]}).`);
    print(`  was: r=${result.previousR ?? 0}`);
    print(`  now: r=${result.newR}`);
  }
  print(`  pool: ${formatCodexPool(result.pool)}`);

  if (result.routerWasRunning) {
    if (result.restartedRouter) {
      info('router restarted to pick up the new config.');
    } else if (result.changed) {
      warn('router is running but restart failed; restart it manually.');
    }
  } else if (result.changed) {
    warn('router is not running; mode will take effect on the next `brick codex on`.');
  }

  const wiring = readCodexWiring();
  if (wiring) {
    writeCodexWiring({ ...wiring, mode });
  }
}
