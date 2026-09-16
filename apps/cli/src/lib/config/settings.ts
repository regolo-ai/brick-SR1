import { refreshOfficialHarness } from '../harness.js';
import { readFile, chmod, rm } from 'node:fs/promises';
import yaml from 'js-yaml';
import { atomicWrite } from './atomic-file.js';
import { nativeConfig } from './native-migration.js';
import * as p from '../ui/prompts.js';
import { paths } from './paths.js';
import { readEnvValue, upsertEnvValues } from './env-file.js';
import { isRegoloEndpoint, validateProfileCredentials } from './credentials.js';
import { profileRunning } from '../runtime/identity.js';
import { startRuntime } from '../runtime/process.js';

export type CredentialChoice = 'canonical' | 'legacy' | 'cancel';
export async function chooseRegoloCredential(conflict: boolean): Promise<CredentialChoice> {
  const choice = await p.select({
    message: conflict ? 'Regolo credentials differ. Which key should this profile use?' : 'Migrate the classifier credential to REGOLO_API_KEY?',
    options: [
      ...(conflict ? [{ value: 'canonical', label: 'Keep the existing REGOLO_API_KEY' }] : []),
      { value: 'legacy', label: 'Use the legacy classifier key' },
      { value: 'cancel', label: 'Cancel saving' },
    ],
  });
  return p.isCancel(choice) ? 'cancel' : choice as CredentialChoice;
}

/** Resolve old classifier credentials only at Save; never display their values. */
export async function normalizeRegoloCredentials(
  cfg: any, values: Record<string, string>,
  choose: (conflict: boolean) => Promise<CredentialChoice> = chooseRegoloCredential,
): Promise<void> {
  const blocks = [cfg.complexity_service, cfg.skill_router?.complexity_model];
  const regoloBlocks = blocks.filter(b => b && isRegoloEndpoint(b.base_url ?? ''));
  const legacyUsed = regoloBlocks.some(b => b.bearer_token === '${COMPLEXITY_API_KEY}');
  if (legacyUsed && values.COMPLEXITY_API_KEY && values.COMPLEXITY_API_KEY !== values.REGOLO_API_KEY) {
    const choice = await choose(!!values.REGOLO_API_KEY);
    if (choice === 'cancel') throw new Error('Save cancelled; files were not changed.');
    if (choice === 'legacy') values.REGOLO_API_KEY = values.COMPLEXITY_API_KEY;
  }
  for (const block of regoloBlocks) {
    if (!block.bearer_token || block.bearer_token === '${COMPLEXITY_API_KEY}') block.bearer_token = '${REGOLO_API_KEY}';
  }
}

/** Shared commit boundary for the UI and settings subcommands. */
export async function saveProfileSettings(
  profile: string, config: any, pending: Record<string, string> = {},
) {
  const pp = paths(profile);
  const obj = nativeConfig(config);
  const original = await readFile(pp.config, 'utf8');
  const previous = yaml.load(original) as any;
  const values = { ...pending };
  for (const key of ['REGOLO_API_KEY', 'COMPLEXITY_API_KEY']) {
    if (!(key in values)) values[key] = await readEnvValue(pp.env, key) ?? '';
  }
  // A compute edit may already have replaced the legacy reference in memory.
  // Keep its provenance until the explicit migration decision at Save.
  for (const [next, old] of [[obj.complexity_service, previous.complexity_service],
    [obj.skill_router?.complexity_model, previous.skill_router?.complexity_model]]) {
    if (isRegoloEndpoint(next?.base_url ?? '') && isRegoloEndpoint(old?.base_url ?? '') &&
      old.bearer_token === '${COMPLEXITY_API_KEY}') next.bearer_token = old.bearer_token;
  }
  await normalizeRegoloCredentials(obj, values);
  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value && value !== await readEnvValue(pp.env, key)) updates[key] = value;
  }
  const dump = (o: any) => yaml.dump(o, { lineWidth: 120, noRefs: true, sortKeys: false });
  const yamlChanged = dump(obj) !== dump(previous);
  const changed = yamlChanged || Object.keys(updates).length > 0;
  const port = obj.server_port ?? 8000;
  if (!changed) return { configPath: pp.config, changed, routerWasRunning: false, restartedRouter: false };
  // Validate the candidate environment before any file is written.
  if (Object.keys(updates).length || yamlChanged) await validateProfileCredentials(profile, obj, values);
  const oldPort = previous?.server_port ?? 8000;
  const routerWasRunning = await profileRunning(profile, oldPort, false);
  if (routerWasRunning && port !== oldPort) await profileRunning(profile, port);
  const snapshots = await Promise.all([pp.config, pp.env].map(async path => {
    try { return { path, text: await readFile(path, 'utf8') }; }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; return { path, text: null }; }
  }));
  try {
    if (Object.keys(updates).length) { await upsertEnvValues(pp.env, updates); await chmod(pp.env, 0o600); }
    if (yamlChanged) await atomicWrite(pp.config, dump(obj));

  } catch (error) {
    for (const snapshot of snapshots) {
      if (snapshot.text === null) await rm(snapshot.path, { force: true });
      else await atomicWrite(snapshot.path, snapshot.text);
    }
    throw error;
  }
  let restartedRouter = false;
  if (routerWasRunning) {
    try {
      await startRuntime(profile, port, true);
      restartedRouter = true;
    } catch (error) {
      for (const snapshot of snapshots) {
        if (snapshot.text === null) await rm(snapshot.path, { force: true });
        else await atomicWrite(snapshot.path, snapshot.text);
      }
      throw error;
    }
  }
  if (restartedRouter) await refreshOfficialHarness(profile, port);
  return { configPath: pp.config, changed, routerWasRunning, restartedRouter };
}
