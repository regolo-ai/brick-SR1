import { Args, Command, Flags } from '@oclif/core';
import { readFile, writeFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { nativeConfigWithWarnings, migrateNativeProfile } from '../lib/config/native-migration.js';
import { paths, resolveProfile } from '../lib/config/paths.js';

export default class Migrate extends Command {
  static description = 'Rewrite a profile configuration to the current Brick format and report removed fields';
  static args = { profile: Args.string({ required: true, description: 'profile name' }) };
  static flags = {
    'dry-run': Flags.boolean({ default: false, description: 'Print the migrated YAML without writing the profile' }),
    out: Flags.string({ description: 'Write the migrated YAML to this file instead of the profile' }),
  };
  async run(): Promise<void> {
    const { args, flags } = await this.parse(Migrate);
    const profile = resolveProfile(args.profile);
    const text = await readFile(paths(profile).config, 'utf8');
    let input: unknown;
    try {
      input = yaml.load(text);
    } catch {
      this.error('Invalid YAML in profile configuration; files were not changed.');
    }
    let migrated: any;
    let warnings: string[];
    try {
      ({ config: migrated, warnings } = nativeConfigWithWarnings(input));
    } catch (error: any) {
      const message = error?.message ?? String(error);
      this.error(message.includes('files were not changed') ? message : `${message}; files were not changed.`);
    }
    for (const warning of warnings) this.warn(warning);
    const output = yaml.dump(migrated, { noRefs: true, lineWidth: 120 });
    if (flags['dry-run']) {
      this.log(output);
      return;
    }
    if (flags.out) {
      await writeFile(flags.out, output, { mode: 0o600 });
      this.log(`migrated configuration written to ${flags.out}`);
      return;
    }
    if (JSON.stringify(input) === JSON.stringify(migrated)) {
      this.log(`'${profile}' is already current`);
      return;
    }
    await migrateNativeProfile(profile);
    this.log(`migrated '${profile}'`);
  }
}
