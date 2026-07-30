import { Args, Command } from '@oclif/core';
import { runCodexRoutingMode } from '../../../lib/codex/runSettings.js';
import type { CodexRoutingMode } from '../../../lib/codex/settings-apply.js';

export default class CodexSettingsMode extends Command {
  static description = 'Select Codex cache-aware routing: off, sticky, smartsqueeze, or orchestrator.';
  static args = {
    mode: Args.string({
      required: true,
      options: ['off', 'sticky', 'smartsqueeze', 'orchestrator'],
    }),
  };
  static examples = ['<%= config.bin %> codex settings mode smartsqueeze'];

  async run(): Promise<void> {
    const { args } = await this.parse(CodexSettingsMode);
    await runCodexRoutingMode(args.mode as CodexRoutingMode, (code) => this.exit(code));
  }
}
