import { Args, Command } from '@oclif/core';
import * as p from '@clack/prompts';
import { runCodexCompute } from '../../../lib/codex/runSettings.js';
import { LOCAL_DISCLAIMER } from '../../../lib/codex/settings-apply.js';

export default class CodexSettingsCompute extends Command {
  static description =
    'Choose where the Codex complexity classifier runs: local (auto-spawned server) or api (remote endpoint).';

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

    const baseUrl = await p.text({
      message: 'Classifier base URL',
      placeholder: 'https://host:port',
      validate: (v) => (v && /^https?:\/\//.test(v) ? undefined : 'enter an http(s) URL'),
    });
    if (p.isCancel(baseUrl)) {
      p.cancel('Aborted.');
      this.exit(0);
    }
    const token = await p.password({ message: 'Bearer token (leave blank if none)' });
    if (p.isCancel(token)) {
      p.cancel('Aborted.');
      this.exit(0);
    }
    await runCodexCompute(
      'api',
      { baseUrl: String(baseUrl), token: String(token ?? '') },
      (code) => this.exit(code),
    );
  }
}
