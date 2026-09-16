import { Args, Command } from '@oclif/core';
import { stopRuntime } from '../lib/runtime/process.js';
import { resolveProfile, readState, updateState } from '../lib/config/paths.js';
import { err, ok } from '../lib/ui/banners.js';
import { print, warn } from '../lib/ui/banners.js';
import { disconnectOfficialHarness } from '../lib/harness.js';

export default class Stop extends Command {
  static description = 'Stop a profile router; for Codex, detach future launches while keeping the current bridge alive';
  static args = {
    profile: Args.string({ required: true, description: 'profile name' }),
  };
  async run(): Promise<void> {
    const { args } = await this.parse(Stop);
    let profile: string;
    try {
      profile = resolveProfile(args.profile);
    } catch (e: any) { err(e?.message ?? String(e)); this.exit(1); }

    // Codex threads cannot change their provider after they are created. Restore
    // future-launch configuration while retaining the current Responses bridge.
    if (profile === 'codex') {
      try {
        await disconnectOfficialHarness(profile);
      } catch (e: any) {
        err(e?.message ?? String(e));
        this.exit(1);
      }
      ok('detached future Codex launches from Brick; the local Responses bridge remains running');
      print('This open Codex thread can still use the bridge. Select an official model such as gpt-5.6-terra to forward directly to the official Codex upstream without classifier routing.');
      print('Run `brick clear codex` to terminate the bridge and return fully to vanilla Codex.');
      return;
    }

    try { await disconnectOfficialHarness(profile); } catch (e: any) { warn(`harness disconnect failed; continuing teardown: ${e?.message ?? e}`); }
    await stopRuntime(profile);

    const state = readState();
    if (state.runningProfile === profile) updateState({ runningProfile: null });
    ok(`stopped (profile: ${profile})`);
  }
}
