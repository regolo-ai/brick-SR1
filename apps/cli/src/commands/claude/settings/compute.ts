import { Args, Command } from '@oclif/core';
import * as p from '@clack/prompts';
import { runCompute } from '../../../lib/claude/runSettings.js';
import { LOCAL_DISCLAIMER, REGOLO_API_KEY_HELP } from '../../../lib/claude/settings-apply.js';

export default class ClaudeSettingsCompute extends Command {
  static description =
    'Choose where the complexity classifier runs: local (auto-spawned server) or api (hosted Regolo endpoint).';

  static args = {
    mode: Args.string({ description: 'local or api', options: ['local', 'api'], required: true }),
  };

  static examples = [
    '<%= config.bin %> claude settings compute local',
    '<%= config.bin %> claude settings compute api',
  ];

  async run(): Promise<void> {
    const { args } = await this.parse(ClaudeSettingsCompute);

    if (args.mode === 'local') {
      p.note(LOCAL_DISCLAIMER, 'Local inference');
      await runCompute('local', undefined, (code) => this.exit(code));
      return;
    }

    // api: hosted Regolo classifier (fixed base_url + model). The only thing
    // we need from the user is their Regolo API key.
    p.note(REGOLO_API_KEY_HELP, 'Regolo API key');
    const token = await p.password({ message: 'Regolo API key' });
    if (p.isCancel(token)) {
      p.cancel('Aborted.');
      this.exit(0);
    }
    await runCompute(
      'api',
      { token: String(token ?? '') },
      (code) => this.exit(code),
    );
  }
}
