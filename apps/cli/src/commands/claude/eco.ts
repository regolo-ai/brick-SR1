import { Command } from '@oclif/core';
import { runClaudeMode } from '../../lib/claude/runMode.js';

export default class ClaudeEco extends Command {
  static description = 'Switch the Claude profile to eco mode (max savings, r=-1, all complexity labels → haiku).';

  static examples = ['<%= config.bin %> claude eco'];

  async run(): Promise<void> {
    await runClaudeMode('eco', (code) => this.exit(code));
  }
}
