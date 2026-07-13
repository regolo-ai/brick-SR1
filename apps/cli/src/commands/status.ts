import { Args, Command } from '@oclif/core';
import { dockerCompose } from '../lib/docker/run.js';
import { loadConfig } from '../lib/config/load.js';
import { resolveProfile, readState, listProfiles } from '../lib/config/paths.js';
import { info, ok, warn, err, print } from '../lib/ui/banners.js';
import { fetchMetrics, classifierPercentiles, totalRequests, fallbackPct, formatLatency } from '../lib/claude/metrics.js';
import { localBaseUrl } from '../lib/net/local.js';

export default class Status extends Command {
  static description = 'Show profiles, container state, and health';
  static args = {
    profile: Args.string({ required: false, description: 'profile name (defaults to active profile)' }),
  };
  async run(): Promise<void> {
    const { args } = await this.parse(Status);
    const state = readState();
    const profs = listProfiles();
    info(`profiles: ${profs.length === 0 ? '(none)' : profs.map((p) => `${p}${state.activeProfile === p ? ' [active]' : ''}${state.runningProfile === p ? ' [running]' : ''}`).join('  ·  ')}`);

    let profile: string;
    try { profile = resolveProfile(args.profile); }
    catch (e: any) { err(e?.message ?? String(e)); return; }

    const ps = await dockerCompose(profile, ['ps']);
    info(`container state (profile: ${profile}):`);
    print(ps.stdout || '(no compose project up)');
    let baseUrl: string | null = null;
    try {
      const cfg = await loadConfig(profile);
      baseUrl = localBaseUrl(cfg.server_port);
      const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) ok(`/health → ${r.status}`);
      else warn(`/health → ${r.status}`);
    } catch (e: any) { err(`health probe failed: ${e?.message ?? e}`); }

    if (baseUrl) {
      const metrics = await fetchMetrics(baseUrl);
      if (metrics && totalRequests(metrics) > 0) {
        const { p50, p95 } = classifierPercentiles(metrics);
        const avg = metrics.classifyDurationCount > 0
          ? metrics.classifyDurationSum / metrics.classifyDurationCount
          : null;
        info('latency (classifier):');
        if (avg !== null) print(`avg: ${formatLatency(avg)}`);
        if (p50 !== null) print(`p50: ${formatLatency(p50)}`);
        if (p95 !== null) print(`p95: ${formatLatency(p95)}`);
        const fp = fallbackPct(metrics);
        print(`fallback rate: ${fp.toFixed(1)}%  (${metrics.fallbackTotal} / ${totalRequests(metrics)} requests)`);
      } else if (metrics) {
        info('latency: no requests yet');
      } else {
        info('latency: metrics endpoint unreachable');
      }
    }
  }
}
