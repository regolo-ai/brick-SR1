import { Command, Flags } from '@oclif/core';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { root, listProfiles, paths } from '../lib/config/paths.js';
import { runtimeStatus } from '../lib/runtime/process.js';
import { saveBundle, restoreBundle } from '../lib/runtime/update-bundle.js';
const require = createRequire(import.meta.url);
export default class Update extends Command {
  static description = 'Update CLI and CPU runtime together, retaining a rollback bundle';
  static flags = { to: Flags.string({ description: 'npm version or tag', exclusive: ['rollback'] }), rollback: Flags.directory({ exists: true, description: 'Restore a bundle saved by brick update', exclusive: ['to'] }) };
  async run(): Promise<void> {
    const { flags } = await this.parse(Update);
    const targetVersion = flags.to ?? 'latest';
    if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(targetVersion)) this.error('Invalid npm version or tag');
    const packageRoot = resolve(this.config.root);
    const globalRoot = (await execa('npm', ['root', '--global'])).stdout.trim();
    if (packageRoot !== resolve(globalRoot, '@regoloai/brick')) this.error('brick update requires a global npm installation; update this local prefix with npm.');
    if (flags.rollback) {
      const restored = await restoreBundle(resolve(flags.rollback));
      this.log(`Restored ${restored.version}. Run brick restart for each profile you want to switch.`);
      return;
    }
    const prefix = (await execa('npm', ['prefix', '--global'])).stdout.trim();
    const installer = require('../../scripts/runtime-install.cjs');
    const old = installer.installedRuntime();
    const backup = join(root(), 'bundles', `${old.version}-${randomUUID()}`);
    await saveBundle(backup, { packageRoot, runtimeRoot: old.packageRoot, version: old.version, binLink: join(prefix, 'bin/brick') });
    const oldModels = join(backup, 'cli', 'assets', 'models', installer.manifest.revision);
    const active: string[] = [];
    for (const profile of listProfiles()) {
      const state = await runtimeStatus(profile);
      if (!state) continue;
      active.push(profile);
      await writeFile(join(paths(profile).runtime, 'rollback.json'), JSON.stringify({ ...state, binary: join(backup, 'runtime', 'bin', 'brick-runtime'), models: oldModels }), { mode: 0o600 });
    }
    let installationSucceeded = false;
    try {
      const result = await execa('npm', ['install', '--global', `@regoloai/brick@${targetVersion}`], { stdio: 'inherit', reject: false });
      installationSucceeded = result.exitCode === 0;
    } catch { /* A spawn failure also requires a complete restoration. */ }
    if (!installationSucceeded) {
      await restoreBundle(backup);
      this.error(`Installation failed; previous bundle restored. Backup: ${backup}`);
    }
    for (const profile of active) {
      const restarted = await execa(process.execPath, [join(packageRoot, 'bin', 'run.js'), 'restart', profile], { stdio: 'inherit', reject: false });
      if (restarted.exitCode !== 0) this.error(`New runtime failed; inspect profile status and rollback logs. Backup: ${backup}`);
    }
    this.log(`Updated CLI and runtime. Rollback bundle: ${backup}`);
  }
}
