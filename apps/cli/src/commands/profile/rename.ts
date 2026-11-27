import { Args, Command } from '@oclif/core';
import { rename } from 'node:fs/promises';
import { paths, profileExists, RESERVED_PROFILES } from '../../lib/config/paths.js';
import { assertCustomProfileName, requireStoppedAndClean } from '../../lib/profiles.js';
export default class ProfileRename extends Command {
  static args = { old: Args.string({ required: true }), new: Args.string({ required: true }) };
  async run(): Promise<void> { const { args } = await this.parse(ProfileRename); assertCustomProfileName(args.new); if (RESERVED_PROFILES.has(args.old) || !profileExists(args.old)) this.error(`cannot rename profile '${args.old}'`); if (profileExists(args.new)) this.error(`profile '${args.new}' already exists`); await requireStoppedAndClean(args.old); await rename(paths(args.old).profileDir, paths(args.new).profileDir); this.log(`renamed '${args.old}' to '${args.new}'`); }
}
