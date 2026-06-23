import { Command } from '@oclif/core';
import * as p from '@clack/prompts';
import { MODES, type ClaudeMode as ModeKey, MODEL_MAP_BY_MODE, formatMap } from '../../lib/claude/modes.js';
import { runClaudeMode } from '../../lib/claude/runMode.js';
import { readWiring } from '../../lib/claude/wiring-state.js';
import { banner } from '../../lib/ui/banners.js';

const MODE_DESC: Record<ModeKey, string> = {
  eco:  'All queries → Haiku. Cheapest and fastest.',
  lite: 'Simple → Haiku, hard → Sonnet. Light cost.',
  mid:  'Balanced default: Haiku / Sonnet / Opus by complexity.',
  pro:  'Sonnet baseline, Opus for hard queries.',
  max:  'All queries → Opus. Maximum quality.',
};

export default class ClaudeMode extends Command {
  static description =
    'Interactively select the active Claude routing mode (eco / lite / mid / pro / max).';

  static examples = ['<%= config.bin %> claude mode'];

  async run(): Promise<void> {
    banner();

    const wiring = readWiring();
    const current = wiring?.mode ?? 'mid';

    const choice = await p.select({
      message: `Select routing mode  (current: ${current})`,
      initialValue: current,
      options: MODES.map((m) => ({
        value: m,
        label: `${m.padEnd(4)}  ${formatMap(MODEL_MAP_BY_MODE[m])}`,
        hint: MODE_DESC[m],
      })),
    });

    if (p.isCancel(choice)) {
      p.cancel('Aborted.');
      process.exit(0);
    }

    // Brief note below the selection.
    p.note(
      'Mode sets cost/quality tradeoff per query complexity.\n' +
      'Router restarts immediately if running. Takes effect for new Claude Code sessions.',
      'How it works'
    );

    await runClaudeMode(choice as ModeKey, (code) => process.exit(code));
  }
}
