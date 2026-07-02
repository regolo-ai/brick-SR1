import { Args, Command } from '@oclif/core';
import { runCodexThinkingRouting } from '../../../lib/codex/runSettings.js';

export default class CodexSettingsThinking extends Command {
  static description = 'Enable or disable Codex autonomous reasoning_effort routing.';

  static args = {
    state: Args.string({ description: 'on or off', options: ['on', 'off'], required: true }),
  };

  static examples = [
    '<%= config.bin %> codex settings thinking on',
    '<%= config.bin %> codex settings thinking off',
  ];

  async run(): Promise<void> {
    const { args } = await this.parse(CodexSettingsThinking);
    await runCodexThinkingRouting(args.state === 'on', (code) => this.exit(code));
  }
}
