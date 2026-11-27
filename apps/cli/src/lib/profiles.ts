import { listProfiles,validateProfileName } from './config/paths.js';
import { runtimeStatus } from './runtime/process.js';

export interface RunningProfile { profile: string; version?: string; role?: string; configDigest?: string; }

export async function discoverRunningProfiles(): Promise<RunningProfile[]> {
  const found: RunningProfile[] = [];
  for (const profile of listProfiles()) {
    const status = await runtimeStatus(profile);
    if (status) found.push({ profile, version: status.version, configDigest: status.digest });
  }
  return found;
}

export async function requireExactlyOneRunning(): Promise<string> {
  const profiles = await discoverRunningProfiles();
  if (profiles.length !== 1) throw new Error(profiles.length === 0
    ? 'exactly one running profile is required; run `brick start <profile>` first'
    : `exactly one running profile is required; running: ${profiles.map((p) => p.profile).join(', ')}`);
  return profiles[0].profile;
}

export async function requireStoppedAndClean(profile: string): Promise<void> {
  const running = (await discoverRunningProfiles()).some((p) => p.profile === profile);
  if (running) throw new Error(`profile '${profile}' must be stopped and cleaned before this operation`);
}

export function assertCustomProfileName(name: string): string {
  return validateProfileName(name);
}
