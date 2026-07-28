import { Args, Command } from '@oclif/core';

/**
 * Profile settings entry point. It intentionally delegates to the Claude
 * settings menu so `brick settings PROFILE_NAME` and
 * `brick claude settings PROFILE_NAME` expose the same controls, including
 * provider management.
 */
export default class Settings extends Command {
  static description = 'Configure a Brick profile (routing settings and providers)';
  static args = {
    profile: Args.string({ required: false, description: 'profile name (defaults to active profile)' }),
  };
  static examples = ['<%= config.bin %> settings', '<%= config.bin %> settings PROFILE_NAME'];

  async run(): Promise<void> {
    const { args } = await this.parse(Settings);
    await this.config.runCommand('claude:settings', args.profile ? [args.profile] : []);
  }
}
