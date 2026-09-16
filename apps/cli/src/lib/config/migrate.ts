import { stat, mkdir, cp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LEGACY, paths, profilesDir, listProfiles, root } from './paths.js';
async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; } catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
}
/** Copy the legacy layout atomically; original files remain the backup. */
export async function migrateLegacyLayout(): Promise<{ migrated: boolean; reason?: string }> {
  if (listProfiles().length || !await exists(LEGACY.config)) return { migrated: false };
  await mkdir(profilesDir(), { recursive: true, mode: 0o700 });
  const temporary = join(profilesDir(), `.migration-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    await cp(LEGACY.config, join(temporary, 'config.yaml'));
    if (await exists(LEGACY.env)) await cp(LEGACY.env, join(temporary, '.env'));
    for (const name of ['pricing.yaml', 'call_history.jsonl', 'routing_events.jsonl', 'economics_snapshot.json', 'codex-model-catalog.json']) {
      if (await exists(join(root(), name))) await cp(join(root(), name), join(temporary, name));
    }
    await rename(temporary, paths('default').profileDir);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return { migrated: true };
}
export async function ensureMigrated(): Promise<void> { await migrateLegacyLayout(); }
