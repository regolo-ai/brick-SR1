import { Command } from '@oclif/core';
import { runCodexMode } from '../../lib/codex/runMode.js';

export default class CodexMid extends Command {
  static description = 'Switch the Codex profile to mid mode (balanced default, r=0).';

  static examples = ['<%= config.bin %> codex mid'];

  async run(): Promise<void> {
    await runCodexMode('mid', (code) => this.exit(code));
  }
}
