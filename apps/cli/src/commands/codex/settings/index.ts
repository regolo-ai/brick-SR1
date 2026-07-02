import { Command } from '@oclif/core';
import * as p from '@clack/prompts';
import yaml from 'js-yaml';
import { ensureDefaultCodexProfile } from '../../../lib/codex/bootstrap.js';
import { loadConfigText } from '../../../lib/config/load.js';
import { readCodexWiring } from '../../../lib/codex/wiring-state.js';
import {
  DEFAULT_CONTEXT_K,
  LOCAL_DISCLAIMER,
  saveCodexConfigAndRestart,
  type SettingsApplyResult,
} from '../../../lib/codex/settings-apply.js';
import {
  runCodexContext,
  runCodexCompute,
  runCodexModelRouting,
  runCodexThinkingRouting,
} from '../../../lib/codex/runSettings.js';
import { runCodexModelsPoolWizard } from '../../../lib/wizard/steps/codex-models-pool.js';
import { banner, err, info, warn } from '../../../lib/ui/banners.js';

function reportRestart(res: SettingsApplyResult): void {
  if (res.routerWasRunning) {
    if (res.restartedRouter) info('router restarted to pick up the new config.');
    else if (res.changed) warn('router is running but restart failed; restart it manually.');
  } else if (res.changed) {
    warn('router is not running; change takes effect on the next `brick codex on`.');
  }
}

function fixedModelOptions(obj: any): Array<{ value: string; label: string; hint?: string }> {
  const models = Array.isArray(obj?.skill_router?.models) ? obj.skill_router.models : [];
  const out = models
    .map((m: any) => (typeof m?.model === 'string' ? m.model : null))
    .filter((m: string | null): m is string => !!m)
    .map((m: string) => ({ value: m, label: m }));
  if (out.length > 0) return out;
  const fallback = typeof obj?.default_model === 'string' ? obj.default_model : 'gpt-5.4';
  return [{ value: fallback, label: fallback }];
}

export default class CodexSettings extends Command {
  static description = 'Brick Codex settings: context-awareness, classifier compute, model routing, and thinking routing.';

  static examples = ['<%= config.bin %> codex settings'];

  async run(): Promise<void> {
    p.updateSettings({ aliases: { left: 'cancel' } });
    banner();

    let profile: string;
    try {
      profile = await ensureDefaultCodexProfile();
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
      const wiring = readCodexWiring();
      const brick = obj?.brick ?? {};
      const cw = brick?.context_window;
      const ctxLabel = cw?.enabled ? `on (last ${cw.k ?? DEFAULT_CONTEXT_K})` : 'off';
      const cs = obj?.complexity_service ?? {};
      const isRemote = typeof cs.base_url === 'string' && !/127\.0\.0\.1|localhost|classifier/.test(cs.base_url);
      const computeLabel = wiring?.computeMode ?? (isRemote ? 'api' : 'local');
      const modelRoutingOn = brick.use_model_routing !== false;
      const thinkingRoutingOn = obj?.skill_router?.dynamic_effort !== false;
      const fixedModel = typeof brick.fixed_model === 'string' && brick.fixed_model ? brick.fixed_model : obj.default_model ?? 'gpt-5.4';
      const modelRoutingLabel = modelRoutingOn ? 'on (by complexity)' : `off (fixed: ${fixedModel})`;
      const thinkingRoutingLabel = thinkingRoutingOn ? 'on (autonomous)' : 'off (client effort)';
      const poolModels = fixedModelOptions(obj).map((m) => m.value);
      const poolLabel = poolModels.length > 0 ? poolModels.join(', ') : '(empty)';

      const section = await p.select({
        message: `Brick Codex settings  (profile: ${profile})`,
        options: [
          { value: 'context', label: `Context-awareness: ${ctxLabel}`, hint: 'classify on recent turns' },
          { value: 'compute', label: `Compute: ${computeLabel}`, hint: 'local vs API classifier' },
          { value: 'modelrouting', label: `Model routing: ${modelRoutingLabel}`, hint: 'pick model by complexity vs fixed model' },
          { value: 'thinkingrouting', label: `Thinking routing: ${thinkingRoutingLabel}`, hint: 'autonomous reasoning_effort vs client effort' },
          { value: 'models', label: `Models: ${poolLabel}`, hint: 'OpenAI pool and thinking modes per model' },
          ...(!modelRoutingOn
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
        await runCodexContext(onoff === 'on', k, (c) => process.exit(c));
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
          await runCodexCompute('local', undefined, (c) => process.exit(c));
        } else {
          const baseUrl = await p.text({
            message: 'Classifier base URL',
            placeholder: 'https://host:port',
            validate: (v) => (v && /^https?:\/\//.test(v) ? undefined : 'enter an http(s) URL'),
          });
          if (p.isCancel(baseUrl)) continue;
          const token = await p.password({ message: 'Bearer token (leave blank if none)' });
          if (p.isCancel(token)) continue;
          await runCodexCompute('api', { baseUrl: String(baseUrl), token: String(token ?? '') }, (c) => process.exit(c));
        }
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
          const picked = await p.select({
            message: 'Fixed model (used for every request)',
            options: fixedModelOptions(obj),
            initialValue: fixedModel,
          });
          if (p.isCancel(picked)) continue;
          await runCodexModelRouting(false, String(picked), (c) => process.exit(c));
        } else {
          await runCodexModelRouting(true, undefined, (c) => process.exit(c));
        }
      } else if (section === 'thinkingrouting') {
        const onoff = await p.select({
          message: 'Thinking routing',
          options: [
            { value: 'on', label: 'On', hint: 'Brick computes reasoning_effort per query' },
            { value: 'off', label: 'Off', hint: "forward the client's own effort unchanged" },
          ],
        });
        if (p.isCancel(onoff)) continue;
        await runCodexThinkingRouting(onoff === 'on', (c) => process.exit(c));
      } else if (section === 'models') {
        const changed = await runCodexModelsPoolWizard(obj);
        if (changed) {
          try {
            const res = await saveCodexConfigAndRestart(profile, obj, true);
            p.note('model pool and thinking modes saved.', 'models');
            reportRestart(res);
          } catch (e: any) {
            err(`save failed: ${e?.message ?? e}`);
          }
        }
      } else if (section === 'fixedmodel') {
        const picked = await p.select({
          message: 'Fixed model (used when model routing is off)',
          options: fixedModelOptions(obj),
          initialValue: fixedModel,
        });
        if (p.isCancel(picked)) continue;
        await runCodexModelRouting(false, String(picked), (c) => process.exit(c));
      }
    }
  }
}
