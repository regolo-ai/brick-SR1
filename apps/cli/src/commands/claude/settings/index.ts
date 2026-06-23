import { Command } from '@oclif/core';
import * as p from '@clack/prompts';
import yaml from 'js-yaml';
import { resolveProfile } from '../../../lib/config/paths.js';
import { loadConfigText } from '../../../lib/config/load.js';
import { readWiring } from '../../../lib/claude/wiring-state.js';
import { runContext, runCompute, runSubagents } from '../../../lib/claude/runSettings.js';
import { LOCAL_DISCLAIMER, DEFAULT_CONTEXT_K } from '../../../lib/claude/settings-apply.js';
import { banner, err } from '../../../lib/ui/banners.js';

export default class ClaudeSettings extends Command {
  static description =
    'Brick Claude settings: context-awareness, classifier compute location, and subagent routing.';

  static examples = ['<%= config.bin %> claude settings'];

  async run(): Promise<void> {
    // Left arrow cancels the active prompt; since every submenu treats a
    // cancel as "go back" (continue), pressing left returns to the main menu.
    p.updateSettings({ aliases: { left: 'cancel' } });
    banner();
    let profile: string;
    try {
      profile = resolveProfile();
    } catch (e: any) {
      err(e?.message ?? String(e));
      this.exit(1);
    }

    for (;;) {
      let obj: any = {};
      try {
        obj = yaml.load(await loadConfigText(profile)) ?? {};
      } catch {
        /* show defaults */
      }
      const wiring = readWiring();
      const cw = obj?.anthropic_passthrough?.context_window;
      const ctxLabel = cw?.enabled ? `on (last ${cw.k ?? DEFAULT_CONTEXT_K})` : 'off';
      const cs = obj?.complexity_service ?? {};
      const isRemote = typeof cs.base_url === 'string' && !/127\.0\.0\.1|localhost/.test(cs.base_url);
      const computeLabel = wiring?.computeMode ?? (isRemote ? 'api' : 'local');
      const subagentsOn = !!obj?.anthropic_passthrough?.route_subagents;
      const subagentsLabel = subagentsOn ? 'on (routed)' : 'off (bypass)';

      const section = await p.select({
        message: `Brick Claude settings  (profile: ${profile})`,
        options: [
          { value: 'context', label: `Context-awareness: ${ctxLabel}`, hint: 'classify on recent turns' },
          { value: 'compute', label: `Compute: ${computeLabel}`, hint: 'local vs API classifier' },
          { value: 'subagents', label: `Subagent routing: ${subagentsLabel}`, hint: 'route native-model subagents through Brick' },
          { value: 'exit', label: 'Exit' },
        ],
      });
      if (p.isCancel(section) || section === 'exit') {
        p.outro('Done.');
        return;
      }

      if (section === 'context') {
        const onoff = await p.select({
          message: 'Context-awareness',
          options: [
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ],
        });
        if (p.isCancel(onoff)) continue;
        let k = cw?.k ?? DEFAULT_CONTEXT_K;
        if (onoff === 'on') {
          const kv = await p.text({
            message: 'Trailing turns (K)',
            initialValue: String(k),
            validate: (v) => (/^\d+$/.test(v) && Number(v) > 0 ? undefined : 'enter a positive integer'),
          });
          if (p.isCancel(kv)) continue;
          k = Number(kv);
        }
        await runContext(onoff === 'on', k, (c) => process.exit(c));
      } else if (section === 'compute') {
        const cm = await p.select({
          message: 'Classifier compute',
          options: [
            { value: 'local', label: 'Local (auto-spawned server)' },
            { value: 'api', label: 'API (remote endpoint)' },
          ],
        });
        if (p.isCancel(cm)) continue;
        if (cm === 'local') {
          p.note(LOCAL_DISCLAIMER, 'Local inference');
          await runCompute('local', undefined, (c) => process.exit(c));
        } else {
          const baseUrl = await p.text({
            message: 'Classifier base URL',
            placeholder: 'https://host:port',
            validate: (v) => (v && /^https?:\/\//.test(v) ? undefined : 'enter an http(s) URL'),
          });
          if (p.isCancel(baseUrl)) continue;
          const token = await p.password({ message: 'Bearer token (leave blank if none)' });
          if (p.isCancel(token)) continue;
          await runCompute('api', { baseUrl: String(baseUrl), token: String(token ?? '') }, (c) => process.exit(c));
        }
      } else if (section === 'subagents') {
        const onoff = await p.select({
          message: 'Route native-model subagents through Brick',
          options: [
            { value: 'on', label: 'On (routed)' },
            { value: 'off', label: 'Off (bypass)' },
          ],
        });
        if (p.isCancel(onoff)) continue;
        await runSubagents(onoff === 'on', (c) => process.exit(c));
      }
    }
  }
}
