import { Args, Command, Flags } from '@oclif/core';
import { runContext } from '../../../lib/claude/runSettings.js';
import { DEFAULT_CONTEXT_K } from '../../../lib/claude/settings-apply.js';

export default class ClaudeSettingsContext extends Command {
  static description =
    'Enable or disable context-awareness: classify on the last K conversation turns instead of only the latest message.';

  static args = {
    state: Args.string({ description: 'on or off', options: ['on', 'off'], required: true }),
  };

  static flags = {
    k: Flags.integer({
      description: 'number of trailing conversation turns fed to the classifier',
      default: DEFAULT_CONTEXT_K,
    }),
  };

  static examples = [
    '<%= config.bin %> claude settings context on',
    '<%= config.bin %> claude settings context on --k 12',
    '<%= config.bin %> claude settings context off',
  ];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ClaudeSettingsContext);
    await runContext(args.state === 'on', flags.k, (code) => this.exit(code));
  }
}
