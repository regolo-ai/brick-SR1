import { Args, Command, Flags } from '@oclif/core';
import { readFile } from 'node:fs/promises';
import chalk from 'chalk';
import yaml from 'js-yaml';
import { listProfiles, paths, readState, resolveProfile } from '../../lib/config/paths.js';
import { readPricingFile, type PricingEntry } from '../../lib/economy/table.js';
import { syncProfilePricing } from '../../lib/economy/sync.js';
import { pricingWatcherStatus } from '../../lib/economy/watch.js';
import { assignModelColors } from '../../lib/ui/model-colors.js';
import { ACCENT, ok, print, warn } from '../../lib/ui/banners.js';

function age(iso?: string): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

function money(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  if (value >= 1) return value.toFixed(2);
  // Sub-dollar prices (gpt-6-luna 0.10) read better with three decimals.
  return value.toFixed(3).replace(/0$/, '');
}

function nativeLabel(row: PricingEntry): string {
  if (row.source_currency && row.source_input_price !== undefined && row.source_output_price !== undefined) {
    return `€${money(row.source_input_price)} / €${money(row.source_output_price)}`;
  }
  return '—';
}

function renderTable(items: PricingEntry[], pool: Set<string>): string {
  const colors = assignModelColors(items.map((row) => row.model));
  const header = ['model', 'provider', 'in $/1M', 'out $/1M', 'native', 'source', 'age'];
  const body = items.map((row) => [
    row.model,
    row.provider ?? '—',
    money(row.input_price),
    money(row.output_price),
    nativeLabel(row),
    row.source ?? '—',
    age(row.fetched_at),
  ]);
  const widths = header.map((col, i) => Math.max(col.length, ...body.map((line) => line[i].length)));
  const pad = (value: string, i: number) => (i === 0 ? value.padEnd(widths[i]) : value.padStart(widths[i]));
  const lines = [header.map(pad).join('  ')];
  for (const [index, line] of body.entries()) {
    const name = chalk.hex(colors.get(items[index].model) ?? '#00d4aa')(pad(line[0], 0));
    const rest = line.slice(1).map((value, i) => pad(value, i + 1));
    const marked = pool.has(items[index].model) ? rest : rest.map((value, i) => (i === 0 ? value : chalk.dim(value)));
    lines.push([name, ...marked].join('  '));
  }
  return lines.join('\n');
}

export default class ProfilePricing extends Command {
  static description = 'Show the model prices used by a profile, refreshed hourly';
  static args = { profile: Args.string({ required: false, description: 'profile name (default: active profile)' }) };
  static flags = {
    json: Flags.boolean({ description: 'emit the pricing table as JSON' }),
    all: Flags.boolean({ description: 'include models that are not in the profile pool' }),
    sync: Flags.boolean({ description: 'refresh prices from the public sources before printing' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ProfilePricing);
    const state = readState();
    const requested = args.profile ?? state.activeProfile ?? listProfiles()[0];
    if (!requested) this.error('no profiles configured; run `brick profile create <name>` first');
    let profile: string;
    try { profile = resolveProfile(requested); }
    catch (error: any) { this.error(error?.message ?? String(error)); }

    const pp = paths(profile);
    const raw = yaml.load(await readFile(pp.config, 'utf8')) as any;
    const pool = new Set<string>(Object.keys(raw?.model_config ?? {}));

    if (flags.sync) {
      const result = await syncProfilePricing(profile, { warn: (message) => warn(message) });
      ok(`prices synced (${result.sources.join('+') || 'no sources'}): ${result.added.length} added, ${result.updated.length} updated, ${result.kept.length} kept`);
      if (result.fx) print(`EUR→USD ${result.fx.rate} (ECB ${result.fx.date}${result.fx.stale ? ', cached' : ''})`);
      if (result.unpriced.length > 0) print(chalk.dim(`no price available for: ${result.unpriced.join(', ')}`));
    }

    const table = await readPricingFile(`${pp.profileDir}/pricing.yaml`);
    const selected = flags.all ? table : table.filter((row) => pool.has(row.model));
    const watcher = await pricingWatcherStatus(profile);

    if (flags.json) {
      this.log(JSON.stringify({
        profile,
        pricing_file: `${pp.profileDir}/pricing.yaml`,
        watcher: watcher ? { running: true, pid: watcher.pid, since: watcher.started_at } : { running: false },
        prices: selected,
      }, null, 2));
      return;
    }

    this.log(`${ACCENT('◆ pricing')}  ${profile}  ${chalk.dim(`${pp.profileDir}/pricing.yaml`)}`);
    this.log(chalk.dim(watcher ? `sync: hourly watcher running (pid ${watcher.pid})` : 'sync: watcher not running'));
    this.log('');
    this.log(selected.length > 0 ? renderTable(selected, pool) : chalk.dim('no price rows yet; run `brick profile pricing --sync`'));
  }
}
