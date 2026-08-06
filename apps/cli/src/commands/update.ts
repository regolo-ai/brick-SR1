import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Command, Flags } from '@oclif/core';
import * as p from '@clack/prompts';
import { execa } from 'execa';
import { readState, profileExists, paths } from '../lib/config/paths.js';
import { readWiring } from '../lib/claude/wiring-state.js';
import { readCodexWiring } from '../lib/codex/wiring-state.js';
import { DEFAULT_CLAUDE_PROFILE } from '../lib/claude/bootstrap.js';
import { DEFAULT_CODEX_PROFILE } from '../lib/codex/bootstrap.js';
import { dockerCompose } from '../lib/docker/run.js';
import { waitHealth } from '../lib/docker/serve.js';
import { localBaseUrl } from '../lib/net/local.js';
import { loadConfig } from '../lib/config/load.js';
import { banner, ok, warn, err, info, print, header } from '../lib/ui/banners.js';

const NPM_PKG = '@regoloai/brick';

/**
 * `brick update` refreshes Brick along its two independent axes:
 *  - router: `docker compose pull` + `up -d` on every active stack, so the
 *    container is recreated on the latest image. This is what carries routing
 *    behavior changes.
 *  - cli: for a global npm install, `npm i -g <pkg>@latest`; for a source /
 *    `npm link` checkout, print the `git pull && npm run build` recipe rather
 *    than mutating the working tree.
 *
 * Default updates both axes. `--check` reports installed vs available and
 * changes nothing. Recreating containers is outward-facing, so the router axis
 * confirms first unless `--yes`.
 */
export default class Update extends Command {
  static description = 'Update Brick: pull the latest router image(s) and refresh the CLI';
  static examples = [
    '<%= config.bin %> update',
    '<%= config.bin %> update --check',
    '<%= config.bin %> update --router --yes',
  ];
  static flags = {
    cli: Flags.boolean({ description: 'update only the CLI package' }),
    router: Flags.boolean({ description: 'update only the router image(s)' }),
    profile: Flags.string({ description: 'restrict the router update to one profile' }),
    check: Flags.boolean({ description: 'report installed vs available versions, change nothing' }),
    yes: Flags.boolean({ char: 'y', description: 'skip confirmation prompts' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Update);
    banner();

    // Default: both axes. Selecting one flag narrows to just that axis.
    const doCli = flags.cli || !flags.router;
    const doRouter = flags.router || !flags.cli;

    if (flags.check) {
      await this.checkVersions(doCli, doRouter, flags.profile);
      return;
    }
    if (doRouter) await this.updateRouter(flags.profile, flags.yes);
    if (doCli) await this.updateCli(flags.yes);
  }

  /** Profiles whose stack should be updated: explicit --profile, else every active one. */
  private targetProfiles(explicit?: string): string[] {
    if (explicit) {
      if (!profileExists(explicit)) throw new Error(`profile '${explicit}' not found. Run \`brick config list\`.`);
      return existsSync(paths(explicit).compose) ? [explicit] : [];
    }
    const set = new Set<string>();
    const st = readState();
    if (st.runningProfile) set.add(st.runningProfile);
    if (readWiring()?.wired) set.add(DEFAULT_CLAUDE_PROFILE);
    if (readCodexWiring()?.wired) set.add(DEFAULT_CODEX_PROFILE);
    return [...set].filter((pr) => profileExists(pr) && existsSync(paths(pr).compose));
  }

  /** Image refs the compose resolves to (reads the actual on-disk compose). */
  private async composeImages(profile: string): Promise<string[]> {
    const r = await dockerCompose(profile, ['config', '--images']);
    if (r.exitCode !== 0) return [];
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  /** Print a profile's image refs and warn if any still targets the legacy org. */
  private printImages(profile: string, imgs: string[]): void {
    print(`profile ${profile}: ${imgs.join(', ') || '(no images resolved)'}`);
    if (imgs.some((i) => i.includes('ghcr.io/massaindustries') || i.includes('ghcr.io/regolo-ai'))) {
      warn(`[${profile}] compose still targets a legacy ghcr.io image; regenerate with \`brick claude on\` / \`brick codex on\` to switch to docker.io/regolo.`);
    }
  }

  private async updateRouter(explicit: string | undefined, yes: boolean): Promise<void> {
    header('router images');
    let profiles: string[];
    try {
      profiles = this.targetProfiles(explicit);
    } catch (e: any) {
      err(e?.message ?? String(e));
      return;
    }
    if (profiles.length === 0) {
      warn('no active Brick stack found (nothing running, claude/codex not wired).');
      info('start one with `brick claude on`, `brick codex on`, or `brick serve`, then re-run.');
      return;
    }

    for (const pr of profiles) {
      const imgs = await this.composeImages(pr);
      this.printImages(pr, imgs);
    }

    if (!yes) {
      const go = await p.confirm({
        message: `Pull latest and recreate ${profiles.length} stack(s)? In-flight requests may be briefly interrupted.`,
        initialValue: false,
      });
      if (p.isCancel(go) || !go) {
        warn('router update aborted');
        return;
      }
    }

    for (const pr of profiles) {
      info(`[${pr}] docker compose pull ...`);
      const pull = await dockerCompose(pr, ['pull']);
      if (pull.exitCode !== 0) {
        err(`[${pr}] pull failed: ${(pull.stderr.split('\n')[0] || '').slice(0, 200)}`);
        continue;
      }
      info(`[${pr}] docker compose up -d ...`);
      const up = await dockerCompose(pr, ['up', '-d', '--force-recreate', '--remove-orphans']);
      if (up.exitCode !== 0) {
        err(`[${pr}] up failed: ${up.stderr.slice(0, 300)}`);
        continue;
      }
      let port = 0;
      try {
        port = (await loadConfig(pr)).server_port;
      } catch {
        /* no readable config port; skip health probe */
      }
      if (port) {
        info(`[${pr}] waiting for health on ${localBaseUrl(port)}/health ...`);
        const healthy = await waitHealth(port);
        if (healthy) ok(`[${pr}] updated and healthy`);
        else warn(`[${pr}] recreated but health not OK yet — check \`brick logs ${pr}\``);
      } else {
        ok(`[${pr}] updated`);
      }
    }
  }

  private async updateCli(yes: boolean): Promise<void> {
    header('cli');
    print(`installed: ${this.config.version}`);

    const src = this.sourceCheckoutRoot();
    if (src) {
      info('installed from source (npm link / git checkout). Update it with:');
      print(`  cd ${src} && git pull && npm run build`);
      return;
    }

    if (!yes) {
      const go = await p.confirm({ message: `Run \`npm i -g ${NPM_PKG}@latest\` now?`, initialValue: false });
      if (p.isCancel(go) || !go) {
        warn('CLI update skipped');
        return;
      }
    }
    info(`npm i -g ${NPM_PKG}@latest ...`);
    const r = await execa('npm', ['i', '-g', `${NPM_PKG}@latest`], { reject: false, stdio: 'inherit' });
    if (r.exitCode === 0) ok('CLI updated');
    else err('npm install failed — see output above');
  }

  private async checkVersions(doCli: boolean, doRouter: boolean, explicit?: string): Promise<void> {
    if (doCli) {
      header('cli');
      print(`installed: ${this.config.version}`);
      const latest = await this.npmLatest();
      if (latest === null) info('npm registry: not reachable or package not published yet');
      else if (latest === this.config.version) ok('up to date');
      else warn(`latest on npm: ${latest} — run \`brick update --cli\``);
    }
    if (doRouter) {
      header('router images');
      let profiles: string[] = [];
      try {
        profiles = this.targetProfiles(explicit);
      } catch (e: any) {
        err(e?.message ?? String(e));
        return;
      }
      if (profiles.length === 0) {
        info('no active stack (nothing running, claude/codex not wired)');
        return;
      }
      for (const pr of profiles) {
        const imgs = await this.composeImages(pr);
        this.printImages(pr, imgs);
      }
      info('run `brick update --router` to pull the latest of these.');
    }
  }

  /** npm dist-tag `latest` for the package, or null if unreachable / unpublished. */
  private async npmLatest(): Promise<string | null> {
    try {
      const r = await fetch(`https://registry.npmjs.org/${NPM_PKG}`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return null;
      const j: any = await r.json();
      const latest = j?.['dist-tags']?.latest;
      return typeof latest === 'string' ? latest : null;
    } catch {
      return null;
    }
  }

  /** Walk up from the package root to find a git checkout (source / npm link install). */
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
