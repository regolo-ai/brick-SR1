import { Args, Command } from '@oclif/core';
import { clearRuntime } from '../lib/runtime/process.js';
import { readState, resolveProfile, updateState } from '../lib/config/paths.js';
import { disconnectOfficialHarness } from '../lib/harness.js';
import { stopCodexFlatBridge } from '../lib/codex/flat-bridge.js';
import { err, ok, print } from '../lib/ui/banners.js';

export default class Clear extends Command {
  static description = 'Stop and remove a profile runtime';
  static args = { profile: Args.string({ required: true, description: 'profile name' }) };

  async run(): Promise<void> {
    const { args } = await this.parse(Clear);
    let profile: string;
    try {
      profile = resolveProfile(args.profile);
    } catch (e: any) {
      err(e?.message ?? String(e));
      this.exit(1);
    }

    // This is the destructive counterpart to `brick stop codex`: restore the
    // normal config before removing the bridge an existing thread uses.
    if (profile === 'codex' || profile === 'claude') {
      try {
        await disconnectOfficialHarness(profile);
      } catch (e: any) {
        err(e?.message ?? String(e));
        this.exit(1);
      }
    }

    await clearRuntime(profile);

    if (profile === 'codex' && await stopCodexFlatBridge(profile)) {
      ok('removed a legacy managed Codex bridge');
    }
    if (readState().runningProfile === profile) updateState({ runningProfile: null });

    if (profile === 'codex') {
      ok('cleared Codex bridge and runtime; subsequent Codex launches use OpenAI directly');
      print('Any open Codex thread has lost its local bridge.');
      return;
    }
    this.log(`cleared '${profile}'`);
  }
}
