import { Command } from '@oclif/core';
import * as p from '@clack/prompts';
import { MODES, R_BY_MODE, type CodexMode } from '../../lib/codex/modes.js';
import { runCodexMode } from '../../lib/codex/runMode.js';
import { readCodexWiring } from '../../lib/codex/wiring-state.js';
import { banner } from '../../lib/ui/banners.js';

const MODE_DESC: Record<CodexMode, string> = {
  eco: 'Strongly prefers cheaper OpenAI models.',
  lite: 'Cost-conscious routing with room for harder prompts.',
  mid: 'Balanced default across the OpenAI pool.',
  pro: 'Biases toward stronger models for quality.',
  max: 'Strongly prefers the most capable models.',
};

export default class CodexModeCommand extends Command {
  static description = 'Interactively select the active Codex routing mode (eco / lite / mid / pro / max).';

  static examples = ['<%= config.bin %> codex mode'];

  async run(): Promise<void> {
    banner();

    const wiring = readCodexWiring();
    const current = wiring?.mode ?? 'mid';

    const choice = await p.select({
      message: `Select Codex routing mode  (current: ${current})`,
      initialValue: current,
      options: MODES.map((m) => ({
        value: m,
        label: `${m.padEnd(4)}  r=${R_BY_MODE[m]}`,
        hint: MODE_DESC[m],
      })),
    });

    if (p.isCancel(choice)) {
      p.cancel('Aborted.');
      process.exit(0);
    }

    p.note(
      'Mode sets the cost/quality bias for the OpenAI skill router.\n' +
      'Router restarts immediately if running. Takes effect for new Codex requests.',
      'How it works'
    );

    await runCodexMode(choice as CodexMode, (code) => process.exit(code));
  }
}
