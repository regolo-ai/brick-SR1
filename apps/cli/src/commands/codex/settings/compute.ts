import { Args, Command } from '@oclif/core';
import * as p from '@clack/prompts';
import { runCodexCompute } from '../../../lib/codex/runSettings.js';
import { LOCAL_DISCLAIMER, REGOLO_API_KEY_HELP } from '../../../lib/codex/settings-apply.js';

export default class CodexSettingsCompute extends Command {
  static description =
    'Choose where the Codex complexity classifier runs: local (auto-spawned server) or api (hosted Regolo endpoint).';

  static args = {
    mode: Args.string({ description: 'local or api', options: ['local', 'api'], required: true }),
  };

  static examples = [
    '<%= config.bin %> codex settings compute local',
    '<%= config.bin %> codex settings compute api',
  ];

  async run(): Promise<void> {
    const { args } = await this.parse(CodexSettingsCompute);

    if (args.mode === 'local') {
      p.note(LOCAL_DISCLAIMER, 'Local inference');
      await runCodexCompute('local', undefined, (code) => this.exit(code));
      return;
    }

    // api: hosted Regolo classifier (fixed base_url + model), user supplies key.
    p.note(REGOLO_API_KEY_HELP, 'Regolo API key');
    const token = await p.password({ message: 'Regolo API key' });
    if (p.isCancel(token)) {
      p.cancel('Aborted.');
      this.exit(0);
    }
    await runCodexCompute(
      'api',
      { token: String(token ?? '') },
      (code) => this.exit(code),
    );
  }
}
