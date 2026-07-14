import { Command } from '@oclif/core';
import * as p from '@clack/prompts';
import yaml from 'js-yaml';
import { resolveProfile, paths } from '../../../lib/config/paths.js';
import { loadConfigText } from '../../../lib/config/load.js';
import { saveConfigText } from '../../../lib/config/save.js';
import { readEnvValue } from '../../../lib/config/env-file.js';
import { readWiring } from '../../../lib/claude/wiring-state.js';
import { runContext, runCompute, runSubagents, runModelRouting, runThinkingRouting, runRoutingMode } from '../../../lib/claude/runSettings.js';
import { runModelsPoolWizard } from '../../../lib/wizard/steps/models-pool.js';
import { LOCAL_DISCLAIMER, REGOLO_API_KEY_HELP, DEFAULT_CONTEXT_K, REGOLO_API_KEY_ENV } from '../../../lib/claude/settings-apply.js';
import { banner, err, ok } from '../../../lib/ui/banners.js';
import { ConfigSchema, type BrickConfig } from '../../../lib/config/schema.js';

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
      const routingMode: 'off' | 'sticky' | 'smartsqueeze' | 'orchestrator' =
        ap.routing_mode === 'sticky' || ap.routing_mode === 'smartsqueeze' || ap.routing_mode === 'orchestrator'
          ? ap.routing_mode
          : 'off';
      const routingModeLabel =
        routingMode === 'sticky'
          ? 'sticky (cache-aware)'
          : routingMode === 'smartsqueeze'
            ? 'smartsqueeze (cache-aware + compaction)'
            : routingMode === 'orchestrator'
              ? 'orchestrator (shadow)'
              : 'off (per-request)';
      // Il pool è composto dai valori unici di model_map
      const mm = ap.model_map ?? {};
      const poolModels = [...new Set(Object.values(mm).filter(Boolean))] as string[];
      const poolLabel = poolModels.length > 0
        ? poolModels.map((m: string) => m.replace('claude-', '').replace(/-\d+.*/, '')).join(', ')
        : 'all (unrestricted)';
      // The fixed-model picker is only relevant when the model is pinned.
      const showFixedModel = !modelRoutingOn;

      const section = await p.select({
        message: `Brick Claude settings  (profile: ${profile})`,
        options: [
          { value: 'models', label: `Models: ${poolLabel}`, hint: 'pool di modelli Claude e thinking modes per modello' },
          { value: 'context', label: `Context-awareness: ${ctxLabel}`, hint: 'classify on recent turns' },
          { value: 'compute', label: `Compute: ${computeLabel}`, hint: 'local vs API classifier' },
          { value: 'subagents', label: `Subagent routing: ${subagentsLabel}`, hint: 'route native-model subagents through Brick' },
          { value: 'modelrouting', label: `Model routing: ${modelRoutingLabel}`, hint: 'pick model by complexity vs fixed model' },
          { value: 'thinkingrouting', label: `Thinking routing: ${thinkingRoutingLabel}`, hint: 'autonomous effort vs client effort' },
          { value: 'routingmode', label: `Cache-aware routing: ${routingModeLabel}`, hint: 'sticky hysteresis to avoid prompt-cache invalidation on model switch' },
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
          initialValue: cw?.enabled ? 'on' : 'off',
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
            { value: 'api', label: 'API (hosted Regolo classifier)', hint: 'just paste your Regolo API key' },
            { value: 'local', label: 'Local (auto-spawned server)', hint: 'self-hosted, needs a GPU/CPU budget' },
          ],
          initialValue: computeLabel === 'local' ? 'local' : 'api',
        });
        if (p.isCancel(cm)) continue;
        if (cm === 'local') {
          p.note(LOCAL_DISCLAIMER, 'Local inference');
          await runCompute('local', undefined, (c) => process.exit(c));
        } else {
          // Regolo hosted classifier. Se la chiave e' gia' nel .env del profilo
          // non richiederla di nuovo: se il compute e' gia' su API non c'e' nulla
          // da fare (torna al menu), altrimenti riapplica API riusando la chiave
          // salvata senza ri-prompt.
          const existing = await readEnvValue(paths(profile).env, REGOLO_API_KEY_ENV);
          if (existing && existing.trim() !== '') {
            if (computeLabel === 'api') {
              ok('Regolo API key already set; compute is on API.');
              continue;
            }
            await runCompute('api', undefined, (c) => process.exit(c));
          } else {
            p.note(REGOLO_API_KEY_HELP, 'Regolo API key');
            const token = await p.password({ message: 'Regolo API key' });
            if (p.isCancel(token)) continue;
            await runCompute('api', { token: String(token ?? '') }, (c) => process.exit(c));
          }
        }
      } else if (section === 'subagents') {
        const onoff = await p.select({
          message: 'Route native-model subagents through Brick',
          options: [
            { value: 'on', label: 'On (routed)' },
            { value: 'off', label: 'Off (bypass)' },
          ],
          initialValue: subagentsOn ? 'on' : 'off',
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
          initialValue: modelRoutingOn ? 'on' : 'off',
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
          initialValue: thinkingRoutingOn ? 'on' : 'off',
        });
        if (p.isCancel(onoff)) continue;
        await runThinkingRouting(onoff === 'on', (c) => process.exit(c));
      } else if (section === 'routingmode') {
        const picked = await p.select({
          message: 'Cache-aware routing mode',
          options: [
            { value: 'off', label: 'Off', hint: 'per-request routing, no cross-turn memory' },
            { value: 'sticky', label: 'Sticky', hint: 'stay on the model unless a switch beats the prompt-cache cost' },
            { value: 'smartsqueeze', label: 'Smartsqueeze', hint: 'sticky + compact the context on a switch (ships shadow-first)' },
            { value: 'orchestrator', label: 'Orchestrator (shadow)', hint: 'v2 path: computed for evaluation, not served' },
          ],
          initialValue: routingMode,
        });
        if (p.isCancel(picked)) continue;
        await runRoutingMode(picked as 'off' | 'sticky' | 'smartsqueeze' | 'orchestrator', (c) => process.exit(c));
      } else if (section === 'models') {
        // Wizard: seleziona pool modelli Claude + thinking modes per modello.
        // Carica il raw YAML come oggetto, modifica in-place, risalva.
        let cfgForWizard: BrickConfig;
        try {
          cfgForWizard = ConfigSchema.parse(yaml.load(await loadConfigText(profile)) ?? {});
        } catch (e: any) {
          err(`cannot load config: ${e?.message ?? e}`);
          continue;
        }
        const changed = await runModelsPoolWizard(cfgForWizard);
        if (changed) {
          try {
            await saveConfigText(yaml.dump(cfgForWizard, { lineWidth: 120, noRefs: true, sortKeys: false }), profile);
            p.note('model pool and thinking modes saved.', 'models');
          } catch (e: any) {
            err(`save failed: ${e?.message ?? e}`);
          }
        }
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
