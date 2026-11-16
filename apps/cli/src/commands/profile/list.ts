import { Command, Flags } from '@oclif/core';
import { listProfiles } from '../../lib/config/paths.js';

export default class ProfileList extends Command {
  static description = 'List profiles';
  static flags = { json: Flags.boolean({ default: false }) };
  async run(): Promise<void> {
    const { flags } = await this.parse(ProfileList);
    const names = listProfiles();
    if (flags.json) {
      this.log(JSON.stringify(names, null, 2));
      return;
    }
    this.log(names.length ? names.join('\n') : 'No profiles configured.');
  }
}
