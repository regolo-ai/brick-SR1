import { Command } from '@oclif/core';
import * as p from '@clack/prompts';
import yaml from 'js-yaml';
import { ensureDefaultCodexProfile } from '../../../lib/codex/bootstrap.js';
import { loadConfigText } from '../../../lib/config/load.js';
import { saveCodexConfigAndRestart } from '../../../lib/codex/settings-apply.js';
import { writeCodexModelCatalog } from '../../../lib/codex/catalog.js';
import { runCodexModelsPoolWizard } from '../../../lib/wizard/steps/codex-models-pool.js';
import { banner, err, info, warn } from '../../../lib/ui/banners.js';

export default class CodexSettingsModels extends Command {
  static description = 'Configure the Codex OpenAI model pool and per-model thinking modes.';

  static examples = ['<%= config.bin %> codex settings models'];

  async run(): Promise<void> {
    banner();
    let profile: string;
    try {
      profile = await ensureDefaultCodexProfile();
    } catch (e: any) {
      err(e?.message ?? String(e));
      this.exit(1);
    }

    let obj: any;
    try {
      obj = yaml.load(await loadConfigText(profile)) ?? {};
    } catch (e: any) {
      err(e?.message ?? String(e));
      this.exit(1);
    }

    const changed = await runCodexModelsPoolWizard(obj);
    if (!changed) {
      p.outro('No changes.');
      return;
    }

    try {
      const modelIds = Array.isArray(obj?.skill_router?.models)
        ? obj.skill_router.models.map((m: any) => m?.model).filter((m: any): m is string => typeof m === 'string')
        : undefined;
      await writeCodexModelCatalog(profile, modelIds);
      const res = await saveCodexConfigAndRestart(profile, obj, true);
      p.outro('Model pool and thinking modes saved.');
      if (res.routerWasRunning) {
        if (res.restartedRouter) info('router restarted to pick up the new config.');
        else warn('router is running but restart failed; restart it manually.');
      } else {
        warn('router is not running; change takes effect on the next `brick codex on`.');
      }
    } catch (e: any) {
      err(e?.message ?? String(e));
      this.exit(1);
    }
  }
}
