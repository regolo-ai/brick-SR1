import { Command } from '@oclif/core';
import yaml from 'js-yaml';
import { resolveProfile } from '../../../lib/config/paths.js';
import { loadConfigText } from '../../../lib/config/load.js';
import { readWiring } from '../../../lib/claude/wiring-state.js';
import { DEFAULT_CONTEXT_K } from '../../../lib/claude/settings-apply.js';
import { banner, err, print } from '../../../lib/ui/banners.js';

export default class ClaudeSettingsShow extends Command {
  static description = 'Show the current Brick Claude settings (context-awareness, compute, subagent routing).';

  static examples = ['<%= config.bin %> claude settings show'];

  async run(): Promise<void> {
    banner();
    let profile: string;
    try {
      profile = resolveProfile();
    } catch (e: any) {
      err(e?.message ?? String(e));
      this.exit(1);
    }

    const wiring = readWiring();
    let obj: any = {};
    try {
      obj = yaml.load(await loadConfigText(profile)) ?? {};
    } catch {
      /* missing/unreadable config -> show defaults */
    }

    const cw = obj?.anthropic_passthrough?.context_window;
    const ctx = cw?.enabled !== false ? `on (last ${cw?.k ?? DEFAULT_CONTEXT_K} turns)` : 'off';
    const cs = obj?.complexity_service ?? {};
    const isRemote = typeof cs.base_url === 'string' && !/127\.0\.0\.1|localhost/.test(cs.base_url);
    const compute = wiring?.computeMode ?? (isRemote ? 'api' : 'local');
    const subagents = obj?.anthropic_passthrough?.route_subagents ? 'on (routed through Brick)' : 'off (bypass)';
    const rmRaw = obj?.anthropic_passthrough?.routing_mode;
    const routingMode =
      rmRaw === 'sticky'
        ? 'sticky (cache-aware)'
        : rmRaw === 'smartsqueeze'
          ? 'smartsqueeze (cache-aware + compaction)'
          : rmRaw === 'orchestrator'
            ? 'orchestrator (shadow)'
            : 'off (per-request)';

    print(`profile:            ${profile}`);
    print(`context-awareness:  ${ctx}`);
    print(`compute:            ${compute}${cs.base_url ? `  (${cs.base_url})` : ''}`);
    print(`subagent routing:   ${subagents}`);
    print(`cache-aware routing:${routingMode}`);
  }
}
