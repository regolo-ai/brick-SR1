import { Command } from '@oclif/core';
import yaml from 'js-yaml';
import { ensureDefaultCodexProfile } from '../../../lib/codex/bootstrap.js';
import { loadConfigText } from '../../../lib/config/load.js';
import { readCodexWiring } from '../../../lib/codex/wiring-state.js';
import { DEFAULT_CONTEXT_K } from '../../../lib/codex/settings-apply.js';
import { banner, err, print } from '../../../lib/ui/banners.js';

export default class CodexSettingsShow extends Command {
  static description = 'Show the current Brick Codex settings.';

  static examples = ['<%= config.bin %> codex settings show'];

  async run(): Promise<void> {
    banner();
    let profile: string;
    try {
      profile = await ensureDefaultCodexProfile();
    } catch (e: any) {
      err(e?.message ?? String(e));
      this.exit(1);
    }

    const wiring = readCodexWiring();
    let obj: any = {};
    try {
      obj = yaml.load(await loadConfigText(profile)) ?? {};
    } catch {
      /* missing/unreadable config -> show defaults */
    }

    const brick = obj?.brick ?? {};
    const cw = brick?.context_window;
    const ctx = cw?.enabled !== false ? `on (last ${cw?.k ?? DEFAULT_CONTEXT_K} turns)` : 'off';
    const rm = brick.routing_mode;
    const routingMode =
      rm === 'sticky' ? 'sticky (cache-aware)' :
      rm === 'orchestrator' ? 'orchestrator (shadow)' :
      rm === 'off' ? 'off (per-request)' :
      'smartsqueeze (cache-aware)';
    const cs = obj?.complexity_service ?? {};
    const isRemote = typeof cs.base_url === 'string' && !/127\.0\.0\.1|localhost|classifier/.test(cs.base_url);
    const compute = wiring?.computeMode ?? (isRemote ? 'api' : 'local');
    const modelRouting = brick.use_model_routing !== false
      ? 'on (by complexity)'
      : `off (fixed: ${brick.fixed_model ?? obj.default_model ?? 'gpt-5.4'})`;
    const thinkingRouting = obj?.skill_router?.dynamic_effort !== false ? 'on (autonomous)' : 'off (client effort)';
    const models = Array.isArray(obj?.skill_router?.models)
      ? obj.skill_router.models.map((m: any) => m?.model).filter(Boolean).join(', ')
      : '(empty)';

    print(`profile:            ${profile}`);
    print(`context-awareness:  ${ctx}`);
    print(`compute:            ${compute}${cs.base_url ? `  (${cs.base_url})` : ''}`);
    print(`model routing:      ${modelRouting}`);
    print(`thinking routing:   ${thinkingRouting}`);
    print(`cache-aware routing:${routingMode}`);
    print(`models:             ${models}`);
  }
}
