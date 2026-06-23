import { Command, Flags } from '@oclif/core';
import * as p from '@clack/prompts';
import { unwireCodex, codexConfigPath } from '../../lib/codex/config-toml.js';
import { readCodexWiring, clearCodexWiring } from '../../lib/codex/wiring-state.js';
import { dockerCompose } from '../../lib/docker/run.js';
import { readState, updateState, resolveProfile } from '../../lib/config/paths.js';
import { banner, err, info, ok, print, warn } from '../../lib/ui/banners.js';

export default class CodexOff extends Command {
  static description =
    'Unwire OpenAI Codex from Brick (removes the brick provider/profile block and restores the prior default profile in ~/.codex/config.toml).';

  static examples = [
    '<%= config.bin %> codex off',
    '<%= config.bin %> codex off --stop',
    '<%= config.bin %> codex off --keep',
  ];

  static flags = {
    stop: Flags.boolean({ description: 'also stop the Brick router (no prompt)', exclusive: ['keep'] }),
    keep: Flags.boolean({ description: 'leave the Brick router running (no prompt)', exclusive: ['stop'] }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(CodexOff);
    banner();

    const wiring = readCodexWiring();
    if (!wiring?.wired) {
      ok('Codex is not wired to Brick — nothing to undo.');
      return;
    }

    // 1. Restore the standard Codex config.
    try {
      unwireCodex(wiring.previousProfile);
    } catch (e: any) {
      err(e?.message ?? String(e));
      this.exit(1);
    }
    clearCodexWiring();

    if (wiring.previousProfile !== null) {
      ok(`restored default Codex profile → ${wiring.previousProfile}`);
    } else {
      ok('removed the brick provider/profile — back to standard Codex configuration');
    }
    info(`updated ${codexConfigPath()}`);

    // 2. Optionally stop the Brick router too.
    const running = readState().runningProfile;
    if (running) {
      const shouldStop = await this.decideStop(flags, running);
      if (shouldStop) await this.stopRouter(running);
      else info(`Brick router '${running}' left running. stop later with \`brick stop\`.`);
    }

    print();
    print('New Codex sessions use your standard configuration.');
  }

  private async decideStop(flags: { stop: boolean; keep: boolean }, running: string): Promise<boolean> {
    if (flags.stop) return true;
    if (flags.keep) return false;
    if (!process.stdin.isTTY) {
      warn(`Brick router '${running}' is still running (no TTY for prompt). use --stop or \`brick stop\` to stop it.`);
      return false;
    }
    const choice = await p.select({
      message: `Brick router '${running}' is still running. What now?`,
      options: [
        { value: 'keep', label: 'Leave it running', hint: 'reattach later with `brick codex on`' },
        { value: 'stop', label: 'Stop it', hint: 'docker compose stop · data persists' },
      ],
      initialValue: 'keep',
    });
    if (p.isCancel(choice)) { p.cancel('left running'); return false; }
    return choice === 'stop';
  }

  private async stopRouter(running: string): Promise<void> {
    let profile: string;
    try { profile = resolveProfile(running); }
    catch (e: any) { warn(`could not resolve running profile: ${e?.message ?? e}`); return; }

    const r = await dockerCompose(profile, ['stop']);
    if (r.exitCode !== 0) { warn(`stop failed: ${r.stderr.slice(0, 300)}`); return; }
    if (readState().runningProfile === profile) updateState({ runningProfile: null });
    ok(`stopped Brick router (profile: ${profile})`);
  }
}
