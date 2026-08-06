import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Command, Flags } from '@oclif/core';
import * as p from '@clack/prompts';
import { execa } from 'execa';
import { banner, err, info, ok, warn } from '../lib/ui/banners.js';

const NPM_PKG = '@regoloai/brick';

export default class Uninstall extends Command {
  static description = 'Stop every Brick stack, preserve user data, then uninstall the global CLI package';
  static flags = {
    yes: Flags.boolean({ char: 'y', description: 'skip the confirmation prompt' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Uninstall);
    banner();

    if (this.sourceCheckoutRoot()) {
      err('this CLI is running from a source checkout/npm link; refusing to remove an unrelated global package.');
      info('run `brick down` for each profile, then remove the npm link from the checkout.');
      this.exit(1);
    }

    if (!flags.yes) {
      const confirmed = await p.confirm({
        message: `Stop all Brick stacks and run \`npm uninstall -g ${NPM_PKG}\`? Configuration and volumes will be preserved.`,
        initialValue: false,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        warn('uninstall aborted');
        return;
      }
    }

    const cleanupScript = join(this.config.root, 'scripts', 'docker-cleanup.cjs');
    const cleanup = await execa(process.execPath, [cleanupScript, '--strict'], {
      reject: false,
      stdio: 'inherit',
    });
    if (cleanup.exitCode !== 0) {
      err('could not stop every Brick stack; the CLI was not uninstalled.');
      this.exit(1);
    }

    info(`npm uninstall -g ${NPM_PKG} ...`);
    const removed = await execa('npm', ['uninstall', '-g', NPM_PKG], {
      reject: false,
      stdio: 'inherit',
    });
    if (removed.exitCode !== 0) {
      err('npm uninstall failed — the stacks are stopped and your data is preserved.');
      this.exit(1);
    }
    ok('Brick CLI uninstalled; reinstall with `npm install -g @regoloai/brick@latest`.');
  }

  private sourceCheckoutRoot(): string | null {
    let dir = this.config.root;
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, '.git'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }
}
