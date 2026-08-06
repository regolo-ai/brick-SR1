import { Args, Command } from '@oclif/core';
import { dockerCompose, dockerComposeDefaultProject } from '../lib/docker/run.js';
import { resolveProfile, readState, updateState } from '../lib/config/paths.js';
import { err, ok } from '../lib/ui/banners.js';

export default class Down extends Command {
  static description = 'Tear down a profile’s router container (removes container, mounts persist)';
  static args = {
    profile: Args.string({ required: false, description: 'profile name (defaults to running or active profile)' }),
  };
  async run(): Promise<void> {
    const { args } = await this.parse(Down);
    let profile: string;
    try {
      profile = resolveProfile(args.profile ?? readState().runningProfile ?? undefined);
    } catch (e: any) { err(e?.message ?? String(e)); this.exit(1); }

    const managed = await dockerCompose(profile, ['down']);
    // A profile may have been started directly with `docker compose -f ...`
    // (or by an older/manual workflow), which uses the profile directory as
    // the project name instead of `brick-<profile>`. `down` is destructive-only,
    // so it is safe to tear down both identities while preserving mounts.
    const legacy = await dockerComposeDefaultProject(profile, ['down']);
    if (managed.exitCode !== 0 && legacy.exitCode !== 0) {
      err((managed.stderr || legacy.stderr).slice(0, 500));
      this.exit(1);
    }

    const state = readState();
    if (state.runningProfile === profile) updateState({ runningProfile: null });
    ok(`down (profile: ${profile})`);
  }
}
