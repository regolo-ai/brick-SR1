import { Command } from '@oclif/core';
import { runCodexMode } from '../../lib/codex/runMode.js';

export default class CodexPro extends Command {
  static description = 'Switch the Codex profile to pro mode (quality-biased routing, r=0.5).';

  static examples = ['<%= config.bin %> codex pro'];

  async run(): Promise<void> {
    await runCodexMode('pro', (code) => this.exit(code));
  }
}
