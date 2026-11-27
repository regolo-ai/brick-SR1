import { Args, Command, Flags } from '@oclif/core';
import { rm } from 'node:fs/promises';
import { paths, profileExists, RESERVED_PROFILES } from '../../lib/config/paths.js';
import { requireStoppedAndClean } from '../../lib/profiles.js';
export default class ProfileDelete extends Command {
  static args = { name: Args.string({ required: true }) };
  static flags = { yes: Flags.boolean({ char: 'y' }) };
  async run(): Promise<void> { const { args, flags } = await this.parse(ProfileDelete); if (RESERVED_PROFILES.has(args.name)) this.error(`'${args.name}' is reserved and cannot be deleted`); if (!profileExists(args.name)) this.error(`profile '${args.name}' not found`); await requireStoppedAndClean(args.name); if (!flags.yes) this.error('refusing to delete without --yes'); await rm(paths(args.name).profileDir, { recursive: true, force: true }); this.log(`deleted '${args.name}'`); }
}
