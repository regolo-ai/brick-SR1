import { Command, Flags } from '@oclif/core';
import * as p from '@clack/prompts';
import { restoreBaseUrl, settingsPath } from '../../lib/claude/settings.js';
import { readWiring, clearWiring } from '../../lib/claude/wiring-state.js';
import { dockerCompose } from '../../lib/docker/run.js';
import { readState, updateState, resolveProfile } from '../../lib/config/paths.js';
import { banner, err, info, ok, print, warn } from '../../lib/ui/banners.js';

export default class ClaudeOff extends Command {
  static description =
    'Unwire Claude Code from Brick and restore the standard environment (reverts ANTHROPIC_BASE_URL in ~/.claude/settings.json).';

  static examples = [
    '<%= config.bin %> claude off',
    '<%= config.bin %> claude off --stop',
    '<%= config.bin %> claude off --keep',
  ];

  static flags = {
    stop: Flags.boolean({ description: 'also stop the Brick router (no prompt)', exclusive: ['keep'] }),
    keep: Flags.boolean({ description: 'leave the Brick router running (no prompt)', exclusive: ['stop'] }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ClaudeOff);
    banner();

    const wiring = readWiring();
    if (!wiring?.wired) {
      ok('Claude Code is not wired to Brick — nothing to undo.');
      return;
    }

    // 1. Restore the standard Claude Code environment.
    try {
      restoreBaseUrl(wiring.previousBaseUrl, wiring.createdEnvBlock);
    } catch (e: any) {
      err(e?.message ?? String(e));
      this.exit(1);
    }
    clearWiring();

    if (wiring.previousBaseUrl !== null) {
      ok(`restored ANTHROPIC_BASE_URL → ${wiring.previousBaseUrl}`);
    } else {
      ok('removed ANTHROPIC_BASE_URL — back to standard Claude Code environment');
    }
    info(`updated ${settingsPath()}`);

    // 2. Optionally stop the Brick router too.
    const running = readState().runningProfile;
    if (running) {
      const shouldStop = await this.decideStop(flags, running);
      if (shouldStop) await this.stopRouter(running);
      else info(`Brick router '${running}' left running. stop later with \`brick stop\`.`);
    }

    print();
    print('New Claude Code sessions use the default Anthropic endpoint.');
    print('Sessions already open through Brick keep routing until they are restarted.');
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
        { value: 'keep', label: 'Leave it running', hint: 'reattach later with `brick claude on`' },
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
