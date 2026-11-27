import { Command, Flags } from '@oclif/core';
import { resolveProfile } from '../../lib/config/paths.js';
import { runPricingWatch } from '../../lib/economy/watch.js';

/**
 * Internal command spawned detached by `brick start`; not meant to be run by
 * hand (use `brick profile pricing --sync` for a one-shot refresh).
 */
export default class PricingWatch extends Command {
  static description = 'Refresh profile model prices hourly (internal, detached)';
  static hidden = true;
  static flags = {
    profile: Flags.string({ required: true, description: 'profile name' }),
    once: Flags.boolean({ default: false, description: 'run a single sync and exit' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(PricingWatch);
    await runPricingWatch(resolveProfile(flags.profile), { once: flags.once });
  }
}
