import { Command, Args, Flags } from '@oclif/core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import * as p from '@clack/prompts';
import { root, resolveProfile, profileExists } from '../../lib/config/paths.js';
import { loadConfigText } from '../../lib/config/load.js';
import { saveConfigText } from '../../lib/config/save.js';
import { paths } from '../../lib/config/paths.js';
import { extractSkills } from '../../lib/skills/extract.js';
import { publishSkillRecord } from '../../lib/skills/hf.js';

export default class SkillsExtract extends Command {
  static description =
    'Measure a model\'s skill vector by running the frozen probe set against it (verifiable categories: math, knowledge MCQ) and write the result into the profile config + local cache.';

  static examples = [
    '<%= config.bin %> skills extract my-model --base-url https://api.regolo.ai/v1 --api-key-env REGOLO_API_KEY',
    '<%= config.bin %> skills extract my-model --base-url http://localhost:8080/v1 --limit 10',
    '<%= config.bin %> skills extract my-model --base-url ... --publish',
  ];

  static args = {
    model: Args.string({ description: 'model id to measure (as the endpoint expects it)', required: true }),
  };

  static flags = {
    'base-url': Flags.string({ description: 'OpenAI-compatible base URL (e.g. https://api.regolo.ai/v1)', required: true }),
    'api-key': Flags.string({ description: 'API key (prefer --api-key-env)' }),
    'api-key-env': Flags.string({ description: 'env var holding the API key' }),
    profile: Flags.string({ description: 'profile whose config to update (default: active profile)' }),
    concurrency: Flags.integer({ default: 4, description: 'parallel requests' }),
    limit: Flags.integer({ description: 'max questions per category (debug / cost cap)' }),
    'dry-run': Flags.boolean({ description: 'measure and print, do not write config/cache' }),
    publish: Flags.boolean({ description: 'offer to publish the measured record to the public HF skill table (opt-in)' }),
    yes: Flags.boolean({ char: 'y', description: 'skip confirmations (non-interactive)' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SkillsExtract);
    const apiKey = flags['api-key'] ?? (flags['api-key-env'] ? process.env[flags['api-key-env']] : undefined);

    p.intro(`brick skills extract — ${args.model}`);
    const spin = p.spinner();
    spin.start('running probe set');
    const result = await extractSkills({
      model: args.model,
      baseUrl: flags['base-url'],
      apiKey,
      concurrency: flags.concurrency,
      limit: flags.limit,
      onProgress: (done, total, category) => spin.message(`${category}: ${done}/${total}`),
    });
    spin.stop('probe set complete');

    for (const c of result.categories) {
      this.log(
        `  ${c.category}: ${c.correct}/${c.total} correct (probe acc ${(c.probeAccuracy * 100).toFixed(1)}%) -> skill ${c.skill.toFixed(4)}`
      );
    }
    this.log(`  skill_vector: [${result.skillVector.join(', ')}]`);
    this.log(`  sources: ${result.coordSources.join(', ')}`);

    if (flags['dry-run']) {
      p.outro('dry-run: nothing written');
      return;
    }

    // local cache (~/.brick/skill-tables/<model>.json)
    const cacheDir = join(root(), 'skill-tables');
    await mkdir(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, `${args.model.replace(/[/\\]/g, '_')}.json`);
    await writeFile(cachePath, JSON.stringify(result.record, null, 2) + '\n');
    this.log(`cached: ${cachePath}`);

    // update profile config (text-level edit to preserve unknown blocks like
    // anthropic_passthrough; ConfigSchema.parse would strip them)
    const profile = resolveProfile(flags.profile);
    if (profileExists(profile)) {
      const text = await loadConfigText(profile);
      const obj = yaml.load(text) as any;
      const models = obj?.skill_router?.models;
      if (Array.isArray(models)) {
        const entry = models.find((m: any) => m?.model === args.model);
        if (entry) {
          entry.skill_vector = result.skillVector;
          entry.skill_source = 'measured';
          entry.skill_confidence = result.coordSources.map((s) => (s === 'measured' ? 'high' : 'low'));
          await saveConfigText(yaml.dump(obj, { lineWidth: 120, noRefs: true, sortKeys: false }), profile);
          this.log(`updated profile '${profile}': ${paths(profile).config}`);
          this.log('restart the router to pick up the new vector (brick restart / docker restart).');
        } else {
          this.log(`model '${args.model}' not in profile '${profile}' skill_router.models; config untouched (cache still written).`);
        }
      } else {
        this.log(`profile '${profile}' has no skill_router block; config untouched (cache still written).`);
      }
    }

    // opt-in publication to the shared HF table
    if (flags.publish) {
      let consent = flags.yes;
      if (!consent) {
        const ok = await p.confirm({
          message: `Publish this measured record for '${args.model}' to the public dataset regolo/brick-skill-tables? (helps other users skip inference)`,
          initialValue: false,
        });
        consent = !p.isCancel(ok) && ok === true;
      }
      if (consent) {
        const url = await publishSkillRecord(result.record);
        this.log(`published: ${url}`);
      } else {
        this.log('publication skipped.');
      }
    }

    p.outro('done');
  }
}
