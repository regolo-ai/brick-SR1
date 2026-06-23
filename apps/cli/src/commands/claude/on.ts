import { Command, Flags } from '@oclif/core';
import { resolveProfile, listProfiles } from '../../lib/config/paths.js';
import { loadConfig, loadConfigRaw } from '../../lib/config/load.js';
import { ensureServing, isHealthy } from '../../lib/docker/serve.js';
import { ensureDefaultProfile } from '../../lib/claude/bootstrap.js';
import { getBaseUrl, setBaseUrl, settingsPath, hasBrickModelOption } from '../../lib/claude/settings.js';
import { readWiring, writeWiring } from '../../lib/claude/wiring-state.js';
import { banner, err, info, ok, print, warn } from '../../lib/ui/banners.js';

export default class ClaudeOn extends Command {
  static description =
    'Wire Claude Code through the local Brick router (sets ANTHROPIC_BASE_URL in ~/.claude/settings.json). Auto-starts the router if it is down.';

  static examples = [
    '<%= config.bin %> claude on',
    '<%= config.bin %> claude on --no-start',
  ];

  static flags = {
    'no-start': Flags.boolean({ description: 'do not auto-start the router; fail if it is not already healthy' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ClaudeOn);
    banner();

    let profile: string;
    try {
      profile = resolveProfile();
    } catch (e: any) {
      if (listProfiles().length === 0) {
        // Brand-new user: materialize a ready-to-serve default Claude profile.
        profile = await ensureDefaultProfile();
        ok(`created default Claude profile '${profile}'`);
      } else {
        err(e?.message ?? String(e));
        this.exit(1);
      }
    }

    const cfg = await loadConfig(profile);
    const port = cfg.server_port;

    // 1. Ensure the router is up and healthy before we point Claude Code at it.
    if (!(await isHealthy(port))) {
      if (flags['no-start']) {
        err(`router not healthy on http://localhost:${port} and --no-start given. run \`brick serve\` first.`);
        this.exit(1);
      }
      info('router not responding — starting it');
      try {
        const r = await ensureServing(profile);
        if (!r.healthy) {
          err(`router did not become healthy on http://localhost:${port}. check \`brick logs\`.`);
          this.exit(1);
        }
      } catch (e: any) {
        err(e?.message ?? String(e));
        this.exit(1);
      }
    } else {
      ok(`router healthy on http://localhost:${port}`);
    }

    // 2. Soft check: Claude Code hits /v1/messages, which needs the Anthropic passthrough.
    try {
      const rawCfg = (await loadConfigRaw(profile)) as any;
      if (rawCfg?.anthropic_passthrough?.enabled !== true) {
        warn('anthropic_passthrough is not enabled in this profile — Claude Code uses /v1/messages.');
        warn('enable it in the profile config.yaml or Claude Code requests will not route.');
      }
    } catch { /* non-blocking */ }

    const baseUrl = `http://localhost:${port}`;

    // 3. Idempotent: already wired to the same URL AND the picker entry is
    // present → nothing to do. (A wiring written before the custom-model-option
    // feature lacks the picker entry, so we fall through to re-write it.)
    const existing = readWiring();
    if (existing?.wired && existing.baseUrl === baseUrl && getBaseUrl() === baseUrl && hasBrickModelOption()) {
      ok(`already wired to ${baseUrl}`);
      print();
      this.printRestartHint();
      return;
    }

    // 4. Back up the prior value only on the first `on` (don't overwrite a real prior value).
    let previousBaseUrl: string | null;
    let createdEnvBlock: boolean;
    if (existing?.wired) {
      previousBaseUrl = existing.previousBaseUrl;
    } else {
      previousBaseUrl = getBaseUrl() ?? null;
    }

    try {
      const res = setBaseUrl(baseUrl);
      createdEnvBlock = existing?.wired ? existing.createdEnvBlock : res.createdEnvBlock;
    } catch (e: any) {
      err(e?.message ?? String(e));
      this.exit(1);
    }

    writeWiring({ wired: true, baseUrl, previousBaseUrl, createdEnvBlock });

    ok(`Claude Code wired to Brick → ${baseUrl}`);
    info(`set ANTHROPIC_BASE_URL in ${settingsPath()}`);
    print();
    this.printRestartHint();
  }

  private printRestartHint(): void {
    print('Your current Claude Code session keeps its existing connection and is not affected.');
    print('Open a NEW session (run /exit then `claude`, or a new terminal) to route through Brick.');
    print('Check wiring with `brick claude status`. Undo with `brick claude off`.');
  }
}
