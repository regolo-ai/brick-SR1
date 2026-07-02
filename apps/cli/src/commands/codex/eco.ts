import { Command } from '@oclif/core';
import { runCodexMode } from '../../lib/codex/runMode.js';

export default class CodexEco extends Command {
  static description = 'Switch the Codex profile to eco mode (max savings, r=-1).';

  static examples = ['<%= config.bin %> codex eco'];

  async run(): Promise<void> {
    await runCodexMode('eco', (code) => this.exit(code));
  }
}
