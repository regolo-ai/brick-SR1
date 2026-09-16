import { Command, Flags } from '@oclif/core';
import { listProfiles, RESERVED_PROFILES } from '../../lib/config/paths.js';
import { discoverRunningProfiles } from '../../lib/profiles.js';

export default class ProfileList extends Command {
  static description = 'List profiles';
  static flags = { json: Flags.boolean({ default: false }) };
  async run(): Promise<void> {
    const { flags } = await this.parse(ProfileList);
    const running = new Set((await discoverRunningProfiles()).map((p) => p.profile));
    const rows = listProfiles().map((name) => ({ name, reserved: RESERVED_PROFILES.has(name), running: running.has(name) }));
    if (flags.json) { this.log(JSON.stringify(rows, null, 2)); return; }
    this.log(rows.length ? rows.map((r) => `${r.running ? '●' : ' '} ${r.name}${r.reserved ? ' (official)' : ''}`).join('\n') : 'No profiles configured.');
  }
}
