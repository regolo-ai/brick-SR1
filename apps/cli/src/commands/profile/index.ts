import { Command } from '@oclif/core';
export default class Profile extends Command {
  static description = 'Manage Brick profiles';
  async run(): Promise<void> { await this.config.runCommand('profile:list', []); }
}
