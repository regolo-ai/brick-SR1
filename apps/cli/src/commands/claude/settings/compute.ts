import { Args, Command } from '@oclif/core';
import * as p from '@clack/prompts';
import { runCompute } from '../../../lib/claude/runSettings.js';
import { LOCAL_DISCLAIMER } from '../../../lib/claude/settings-apply.js';

export default class ClaudeSettingsCompute extends Command {
  static description =
    'Choose where the complexity classifier runs: local (auto-spawned server) or api (remote endpoint).';

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

    // api: collect the user-supplied endpoint and bearer token.
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
    await runCompute(
      'api',
      { baseUrl: String(baseUrl), token: String(token ?? '') },
      (code) => this.exit(code),
    );
  }
}
