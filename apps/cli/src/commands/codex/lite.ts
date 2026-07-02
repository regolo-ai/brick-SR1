import { Command } from '@oclif/core';
import { runCodexMode } from '../../lib/codex/runMode.js';

export default class CodexLite extends Command {
  static description = 'Switch the Codex profile to lite mode (lower-cost routing, r=-0.5).';

  static examples = ['<%= config.bin %> codex lite'];

  async run(): Promise<void> {
    await runCodexMode('lite', (code) => this.exit(code));
  }
}
