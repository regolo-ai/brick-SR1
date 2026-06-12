import { Args, Command, Flags } from '@oclif/core';
import { resolveProfile, readState } from '../lib/config/paths.js';
import { banner, err } from '../lib/ui/banners.js';
import { ensureServing } from '../lib/docker/serve.js';

export default class Serve extends Command {
  static description = 'Start a profile’s router container via docker compose';
  static args = {
    profile: Args.string({ required: false, description: 'profile name (defaults to active profile)' }),
  };
  static flags = {
    pull: Flags.boolean({ description: 'force docker pull before start' }),
    detach: Flags.boolean({ char: 'd', default: true, description: 'detached mode (default)' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Serve);
    banner();
    let profile: string;
    try { profile = resolveProfile(args.profile); }
    catch (e: any) { err(e?.message ?? String(e)); this.exit(1); }

    const state = readState();
    if (state.runningProfile && state.runningProfile !== profile) {
      err(`profile '${state.runningProfile}' is currently running. run \`brick stop ${state.runningProfile}\` first.`);
      this.exit(1);
    }

    try {
      await ensureServing(profile, { pull: flags.pull });
    } catch (e: any) {
      err(e?.message ?? String(e));
      this.exit(1);
    }
  }
}
