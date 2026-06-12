import { Command } from '@oclif/core';
import { runClaudeMode } from '../../lib/claude/runMode.js';

export default class ClaudeMid extends Command {
  static description = 'Switch the Claude profile to mid mode (balanced, r=0, easy→haiku · medium→sonnet · hard→opus). This is the default.';

  static examples = ['<%= config.bin %> claude mid'];

  async run(): Promise<void> {
    await runClaudeMode('mid', (code) => this.exit(code));
  }
}
