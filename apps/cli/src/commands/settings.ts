import { Args, Command } from '@oclif/core';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { editConfigProfile } from './config/edit.js';
import { paths, profileExists } from '../lib/config/paths.js';
import { err } from '../lib/ui/banners.js';

/**
 * Generic Brick settings surface. Claude and Codex have transport-specific
 * settings commands and must not be edited through this entry point.
 */
export default class Settings extends Command {
  static description = 'Edit settings for a standalone Brick profile (not Claude/Codex)';
  static args = {
    profile: Args.string({ required: true, description: 'standalone profile name (must be explicit)' }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(Settings);
    const profile = String(args.profile);
    const reserved = new Set(['claude', 'codex']);
    if (reserved.has(profile.toLowerCase())) {
      err(`profile '${profile}' is reserved for Claude/Codex. Use 'brick claude settings' or 'brick codex settings'.`);
      this.exit(1);
    }
    if (!profileExists(profile)) {
      err(`profile '${profile}' not found. Run 'brick config list' to see available profiles.`);
      this.exit(1);
    }
    try {
      const raw = yaml.load(await readFile(paths(profile).config, 'utf8')) as any;
      if (raw?.anthropic_passthrough) {
        err(`profile '${profile}' contains Claude transport settings. Use 'brick claude settings' instead.`);
        this.exit(1);
      }
    } catch (e: any) {
      err(`cannot load ${paths(profile).config}: ${e?.message ?? String(e)}`);
      this.exit(1);
    }
    await editConfigProfile(profile, `brick settings (standalone profile: ${profile})`);
  }
}
