import { Args, Command, Flags } from '@oclif/core';
import { runCodexModelRouting } from '../../../lib/codex/runSettings.js';

export default class CodexSettingsModelRouting extends Command {
  static description = 'Enable or disable Codex model routing by complexity.';

  static args = {
    state: Args.string({ description: 'on or off', options: ['on', 'off'], required: true }),
  };

  static flags = {
    fixed: Flags.string({ description: 'fixed model to use when model routing is off' }),
  };

  static examples = [
    '<%= config.bin %> codex settings model-routing on',
    '<%= config.bin %> codex settings model-routing off --fixed gpt-5.4',
  ];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(CodexSettingsModelRouting);
    await runCodexModelRouting(args.state === 'on', flags.fixed, (code) => this.exit(code));
  }
}
