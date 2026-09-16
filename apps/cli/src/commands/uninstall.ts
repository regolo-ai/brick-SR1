import { Command, Flags } from '@oclif/core';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { listProfiles } from '../lib/config/paths.js';
import { stopRuntime } from '../lib/runtime/process.js';
import { disconnectOfficialHarness } from '../lib/harness.js';
export default class Uninstall extends Command {
  static description = 'Stop Brick runtimes and remove the global package, preserving profiles and history';
  static flags = { yes: Flags.boolean({ char: 'y', default: false }) };
  async run(): Promise<void> {
    await this.parse(Uninstall);
    for (let current = resolve(this.config.root); current !== dirname(current); current = dirname(current)) {
      try { await access(join(current, '.git')); this.error('Unlink this source checkout explicitly; no global package was removed.'); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const profile of listProfiles()) { await disconnectOfficialHarness(profile); await stopRuntime(profile); }
    const result = await execa('npm', ['uninstall', '--global', '@regoloai/brick'], { stdio: 'inherit', reject: false });
    if (result.exitCode !== 0) this.error('npm uninstall failed; profile data remains intact.');
  }
}
