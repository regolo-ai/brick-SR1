import { Command, Flags } from '@oclif/core';
import { loadConfig } from '../../lib/config/load.js';
import { readState } from '../../lib/config/paths.js';
import { ensureServing, isHealthy } from '../../lib/docker/serve.js';
import { localBaseUrl } from '../../lib/net/local.js';
import { ensureDefaultCodexProfile } from '../../lib/codex/bootstrap.js';
import {
  wireCodex,
  codexConfigPath,
  readCodexConfig,
  isWired,
  getTopLevelModel,
  getTopLevelModelProvider,
} from '../../lib/codex/config-toml.js';
import { readCodexWiring, writeCodexWiring } from '../../lib/codex/wiring-state.js';
import { ensureClassifierCompute } from '../../lib/config/regolo-key.js';
import { banner, err, info, ok, print, warn } from '../../lib/ui/banners.js';

export default class CodexOn extends Command {
  static description =
    'Wire OpenAI Codex through the local Brick router (sets model/model_provider to brick and adds a managed provider in ~/.codex/config.toml). Auto-starts the router if it is down.';

  static examples = [
    '<%= config.bin %> codex on',
    '<%= config.bin %> codex on --no-start',
  ];

  static flags = {
    'no-start': Flags.boolean({ description: 'do not auto-start the router; fail if it is not already healthy' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(CodexOn);
    banner();

    // Materialize the dedicated Codex profile (OpenAI pool skill router) if absent.
    const profile = await ensureDefaultCodexProfile();

    const cfg = await loadConfig(profile);
    const port = cfg.server_port;

    // The Claude and Codex router stacks both bind host 8000 (mutually exclusive).
    // This guard must run before any classifier setup below, since a
    // `needs-choice` + Local answer there can trigger `docker compose up`.
    const running = readState().runningProfile;
    if (running && running !== profile && (await isHealthy(port))) {
      warn(`a different Brick router ('${running}') is already serving port ${port}.`);
      warn(`stop it first (\`brick claude off --stop\` or \`brick stop\`) before wiring Codex.`);
      this.exit(1);
    }

    // Hosted Regolo classifier (default): ensure a Regolo API key before start.
    await ensureClassifierCompute(
      profile,
      'Set up the complexity classifier for this Codex profile.',
    );

    // 1. Ensure the router is up and healthy before pointing Codex at it.
    if (!(await isHealthy(port))) {
      if (flags['no-start']) {
        err(`router not healthy on ${localBaseUrl(port)} and --no-start given. run \`brick serve\` first.`);
        this.exit(1);
      }
      info('router not responding — starting the Codex stack');
      try {
        const r = await ensureServing(profile);
        if (!r.healthy) {
          err(`router did not become healthy on ${localBaseUrl(port)}. check \`brick logs\`.`);
          this.exit(1);
        }
      } catch (e: any) {
        err(e?.message ?? String(e));
        this.exit(1);
      }
    } else {
      ok(`router healthy on ${localBaseUrl(port)}`);
    }

    const baseUrl = localBaseUrl(port);

    // 2. Idempotent: already wired to the same URL and the TOML still points at Brick.
    const existing = readCodexWiring();
    const codexConfig = readCodexConfig();
    const configAlreadyWired =
      isWired(codexConfig) &&
      getTopLevelModel(codexConfig) === 'brick' &&
      getTopLevelModelProvider(codexConfig) === 'brick';
    if (existing?.wired && existing.baseUrl === baseUrl && configAlreadyWired) {
      ok(`already wired to ${baseUrl}`);
      print();
      this.printHint();
      return;
    }

    // 3. Patch ~/.codex/config.toml. Back up prior root keys only on the first `on`.
    let result: {
      previousModel: string | null;
      previousModelProvider: string | null;
      previousProfile: string | null;
      createdFile: boolean;
    };
    try {
      result = wireCodex(baseUrl);
    } catch (e: any) {
      err(e?.message ?? String(e));
      this.exit(1);
    }
    const previousModel = existing?.wired ? existing.previousModel : result!.previousModel;
    const previousModelProvider = existing?.wired ? existing.previousModelProvider : result!.previousModelProvider;
    const previousProfile = existing?.wired ? existing.previousProfile : result!.previousProfile;
    const createdFile = existing?.wired ? existing.createdFile : result!.createdFile;

    writeCodexWiring({ wired: true, baseUrl, previousModel, previousModelProvider, previousProfile, createdFile });

    ok(`Codex wired to Brick → ${baseUrl} (model_provider "brick", model "brick", wire_api=responses)`);
    info(`patched ${codexConfigPath()}`);
    print();
    this.printHint();
  }

  private printHint(): void {
    print('Codex now defaults to the "brick" model provider → the local Brick router routes among the OpenAI pool.');
    print('Your OpenAI API key is forwarded verbatim to api.openai.com. Undo with `brick codex off`.');
    print('Check wiring with `brick codex status`.');
  }
}
