import { Args, Command } from '@oclif/core';
import { runSubagents } from '../../../lib/claude/runSettings.js';

export default class ClaudeSettingsSubagents extends Command {
  static description =
    'Route Claude Code subagents (requests with an explicit native model) through Brick instead of letting them bypass the router.';

  static args = {
    state: Args.string({ description: 'on or off', options: ['on', 'off'], required: true }),
  };

  static examples = [
    '<%= config.bin %> claude settings subagents on',
    '<%= config.bin %> claude settings subagents off',
  ];

  async run(): Promise<void> {
    const { args } = await this.parse(ClaudeSettingsSubagents);
    await runSubagents(args.state === 'on', (code) => this.exit(code));
  }
}
