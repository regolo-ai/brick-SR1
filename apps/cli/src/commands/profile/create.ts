import { Args,Command } from '@oclif/core';
import { mkdir } from 'node:fs/promises';
import { paths,profileExists } from '../../lib/config/paths.js';
import { assertCustomProfileName } from '../../lib/profiles.js';
import { loadSkillTable } from '../../lib/skills/resolver.js';
import { warn } from '../../lib/ui/banners.js';
import { runWizard } from '../../lib/wizard/run.js';

export default class ProfileCreate extends Command {
  static description = 'Create a profile';
  static args = { name: Args.string({ required: true }) };
  async run(): Promise<void> {
    const { args } = await this.parse(ProfileCreate);
    const name = assertCustomProfileName(args.name);
    if (profileExists(name)) this.error(`profile '${name}' already exists`);
    await loadSkillTable({ warn });
    await mkdir(paths(name).profileDir, { recursive: true, mode: 0o700 });
    await runWizard(name);
  }
}
