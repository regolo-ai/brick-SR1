import { Command } from '@oclif/core';
import * as p from '@clack/prompts';
import yaml from 'js-yaml';
import { resolveProfile } from '../../../lib/config/paths.js';
import { loadConfigText } from '../../../lib/config/load.js';
import { readWiring } from '../../../lib/claude/wiring-state.js';
import { runContext, runCompute, runSubagents, runModelRouting, runThinkingRouting } from '../../../lib/claude/runSettings.js';
import { LOCAL_DISCLAIMER, DEFAULT_CONTEXT_K } from '../../../lib/claude/settings-apply.js';
import { banner, err } from '../../../lib/ui/banners.js';

/** Models offered when model routing is off and a fixed model must be picked. */
const FIXED_MODEL_OPTIONS = [
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5', hint: 'fastest, cheapest' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', hint: 'balanced' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8', hint: 'most capable' },
] as const;

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

      // Absent key defaults to on (matches the Go pointer-nil default).
      const ap = obj?.anthropic_passthrough ?? {};
      const modelRoutingOn = ap.use_model_routing !== false;
      const thinkingRoutingOn = ap.use_thinking_routing !== false;
      const fixedModel = typeof ap.fixed_model === 'string' && ap.fixed_model ? ap.fixed_model : 'claude-sonnet-4-6';
      const modelRoutingLabel = modelRoutingOn ? 'on (by complexity)' : `off (fixed: ${fixedModel})`;
      const thinkingRoutingLabel = thinkingRoutingOn ? 'on (autonomous)' : 'off (client effort)';
      // The fixed-model picker is only relevant when the model is pinned.
      const showFixedModel = !modelRoutingOn;

      const section = await p.select({
        message: `Brick Claude settings  (profile: ${profile})`,
        options: [
          { value: 'context', label: `Context-awareness: ${ctxLabel}`, hint: 'classify on recent turns' },
          { value: 'compute', label: `Compute: ${computeLabel}`, hint: 'local vs API classifier' },
          { value: 'subagents', label: `Subagent routing: ${subagentsLabel}`, hint: 'route native-model subagents through Brick' },
          { value: 'modelrouting', label: `Model routing: ${modelRoutingLabel}`, hint: 'pick model by complexity vs fixed model' },
          { value: 'thinkingrouting', label: `Thinking routing: ${thinkingRoutingLabel}`, hint: 'autonomous effort vs client effort' },
          ...(showFixedModel
            ? [{ value: 'fixedmodel', label: `Fixed model: ${fixedModel}`, hint: 'model used when routing is off' }]
            : []),
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
      } else if (section === 'modelrouting') {
        const onoff = await p.select({
          message: 'Model routing',
          options: [
            { value: 'on', label: 'On', hint: 'Brick picks the model by complexity' },
            { value: 'off', label: 'Off', hint: 'pin every request to a fixed model' },
          ],
        });
        if (p.isCancel(onoff)) continue;
        if (onoff === 'off') {
          // When turning routing off, pick the fixed model in the same step so the
          // user is never left with model routing off and no model chosen.
          const picked = await p.select({
            message: 'Fixed model (used for every request)',
            options: FIXED_MODEL_OPTIONS.map((m) => ({ value: m.value, label: m.label, hint: m.hint })),
            initialValue: fixedModel,
          });
          if (p.isCancel(picked)) continue;
          await runModelRouting(false, String(picked), (c) => process.exit(c));
        } else {
          await runModelRouting(true, undefined, (c) => process.exit(c));
        }
      } else if (section === 'thinkingrouting') {
        const onoff = await p.select({
          message: 'Thinking routing',
          options: [
            { value: 'on', label: 'On', hint: 'Brick computes the reasoning effort per query' },
            { value: 'off', label: 'Off', hint: "forward the client's own effort unchanged" },
          ],
        });
        if (p.isCancel(onoff)) continue;
        await runThinkingRouting(onoff === 'on', (c) => process.exit(c));
      } else if (section === 'fixedmodel') {
        const picked = await p.select({
          message: 'Fixed model (used when model routing is off)',
          options: FIXED_MODEL_OPTIONS.map((m) => ({ value: m.value, label: m.label, hint: m.hint })),
          initialValue: fixedModel,
        });
        if (p.isCancel(picked)) continue;
        await runModelRouting(false, String(picked), (c) => process.exit(c));
      }
    }
  }
}
