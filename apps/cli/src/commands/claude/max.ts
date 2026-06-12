import { Command } from '@oclif/core';
import { runClaudeMode } from '../../lib/claude/runMode.js';

export default class ClaudeMax extends Command {
  static description = 'Switch the Claude profile to max mode (max quality, r=1, all complexity labels → opus).';

  static examples = ['<%= config.bin %> claude max'];

  async run(): Promise<void> {
    await runClaudeMode('max', (code) => this.exit(code));
  }
}
