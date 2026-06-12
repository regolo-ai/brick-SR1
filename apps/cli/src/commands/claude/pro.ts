import { Command } from '@oclif/core';
import { runClaudeMode } from '../../lib/claude/runMode.js';

export default class ClaudePro extends Command {
  static description = 'Switch the Claude profile to pro mode (mostly capable, r=0.5, easy→sonnet · medium→sonnet · hard→opus).';

  static examples = ['<%= config.bin %> claude pro'];

  async run(): Promise<void> {
    await runClaudeMode('pro', (code) => this.exit(code));
  }
}
