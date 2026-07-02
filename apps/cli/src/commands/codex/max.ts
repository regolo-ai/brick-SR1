import { Command } from '@oclif/core';
import { runCodexMode } from '../../lib/codex/runMode.js';

export default class CodexMax extends Command {
  static description = 'Switch the Codex profile to max mode (maximum quality bias, r=1).';

  static examples = ['<%= config.bin %> codex max'];

  async run(): Promise<void> {
    await runCodexMode('max', (code) => this.exit(code));
  }
}
