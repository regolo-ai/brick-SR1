import { Args, Command } from '@oclif/core';
import { editConfigProfile } from '../../lib/config/editor.js';
export default class ProfileEdit extends Command {
  static description = 'Edit a profile in the interactive editor';
  static args = { name: Args.string({ required: true }) };
  async run(): Promise<void> { const { args } = await this.parse(ProfileEdit); await editConfigProfile(args.name); }
}
