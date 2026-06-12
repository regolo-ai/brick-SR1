import { Command } from '@oclif/core';
import { runClaudeMode } from '../../lib/claude/runMode.js';

export default class ClaudeLite extends Command {
  static description = 'Switch the Claude profile to lite mode (mostly cheap, r=-0.5, hard → sonnet, others → haiku).';

  static examples = ['<%= config.bin %> claude lite'];

  async run(): Promise<void> {
    await runClaudeMode('lite', (code) => this.exit(code));
  }
}
