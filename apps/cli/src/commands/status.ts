import { Args, Command, Flags } from '@oclif/core';
import React from 'react';
import { render } from 'ink';
import { runtimeStatus } from '../lib/runtime/process.js';
import { loadConfig } from '../lib/config/load.js';
import { resolveProfile, readState, listProfiles } from '../lib/config/paths.js';
import { info, ok, warn, err, print } from '../lib/ui/banners.js';
import { fetchStats, formatLatency } from '../lib/claude/metrics.js';
import { localBaseUrl } from '../lib/net/local.js';
import { discoverRunningProfiles } from '../lib/profiles.js';
import { readContextDiscoverySnapshot } from '../lib/catalog/context-windows.js';
import { Dashboard } from '../lib/claude-tui/Dashboard.js';
import { readCodexWiring } from '../lib/codex/wiring-state.js';
import { getTopLevelModel, getTopLevelModelProvider, isWired, readCodexConfig } from '../lib/codex/config-toml.js';
import { readWiring as readClaudeWiring } from '../lib/claude/wiring-state.js';
import { getBaseUrl as getClaudeBaseUrl, hasBrickModelOption } from '../lib/claude/settings.js';

function normalizedUrl(value?: string | null): string | undefined {
  return value?.replace(/\/+$/, '');
}

function harnessConnection(profile: string, baseUrl: string): {
  url?: string;
  attached: boolean;
  label: string;
  disconnectedLabel: string;
  unattachedLabel: string;
} {
  if (profile === 'codex') {
    const wiring = readCodexWiring();
    const config = readCodexConfig();
    return {
      url: normalizedUrl(wiring?.baseUrl),
      attached: !!wiring?.wired && normalizedUrl(wiring.baseUrl) === normalizedUrl(baseUrl) &&
        isWired(config) && getTopLevelModel(config) === 'brick' && getTopLevelModelProvider(config) === 'brick',
      label: 'Codex config',
      disconnectedLabel: 'not wired — run brick start codex after updating the router',
      unattachedLabel: 'not wired to this router',
    };
  }
  if (profile === 'claude') {
    const wiring = readClaudeWiring();
    const settingsUrl = normalizedUrl(getClaudeBaseUrl());
    return {
      url: settingsUrl,
      attached: !!wiring?.wired && settingsUrl === normalizedUrl(baseUrl) && hasBrickModelOption(),
      label: 'Claude settings',
      disconnectedLabel: 'not wired — run brick start claude',
      unattachedLabel: 'not wired to this router',
    };
  }
  return { url: baseUrl, attached: true, label: `profile ${profile}`, disconnectedLabel: 'not attached', unattachedLabel: 'not attached' };
}

export default class Status extends Command {
  static description = 'Show profiles, runtime state, and health';
  static args = {
    profile: Args.string({ required: false, description: 'profile name' }),
    action: Args.string({ required: false }),
  };
  static flags = {
    static: Flags.boolean({ description: 'show one-shot text output instead of the live dashboard' }),
    json: Flags.boolean({ description: 'emit machine-readable status' }),
    interval: Flags.integer({ min: 1, default: 2, description: 'dashboard refresh interval in seconds' }),
  };
  async run(): Promise<void> {
    const { args, flags } = await this.parse(Status);
    const state = readState();
    const profs = listProfiles();
    const mayRenderDashboard = !!args.profile && !flags.static && !flags.json && args.action !== 'static' && process.stdout.isTTY;
    if (!flags.json && !mayRenderDashboard) info(`profiles: ${profs.length === 0 ? '(none)' : profs.map((p) => `${p}${state.activeProfile === p ? ' [active]' : ''}${state.runningProfile === p ? ' [running]' : ''}`).join('  ·  ')}`);

    if (!args.profile) {
      const running = await discoverRunningProfiles();
      if (flags.json) { this.log(JSON.stringify(profs.map((name) => ({ profile: name, running: running.some((p) => p.profile === name) })))); return; }
      this.log(profs.length ? profs.map((name) => `${running.some((p) => p.profile === name) ? '●' : ' '} ${name}`).join('\n') : 'No profiles configured.');
      return;
    }
    let profile: string;
    try { profile = resolveProfile(args.profile); }
    catch (e: any) { err(e?.message ?? String(e)); return; }

    let cfg: Awaited<ReturnType<typeof loadConfig>>;
    try { cfg = await loadConfig(profile); }
    catch (e: any) { err(`failed to load profile '${profile}': ${e?.message ?? e}`); return; }

    const baseUrl = localBaseUrl(cfg.server_port);
    const wantsLive = !flags.static && !flags.json && args.action !== 'static' && process.stdout.isTTY;
    if (wantsLive) {
      const connection = harnessConnection(profile, baseUrl);
      const { waitUntilExit } = render(
        React.createElement(Dashboard, {
          baseUrl,
          envUrl: connection.url,
          attached: connection.attached,
          intervalMs: Math.max(500, flags.interval * 1000),
          connectionLabel: connection.label,
          disconnectedLabel: connection.disconnectedLabel,
          unattachedLabel: connection.unattachedLabel,
          emptyRequestsLabel: 'no router requests served yet',
          nativeLabel: 'native requests (router bypass)',
          economyBaselineModel: cfg.default_model,
        }),
      );
      await waitUntilExit();
      return;
    }

    let discovery: Awaited<ReturnType<typeof readContextDiscoverySnapshot>> = [];
    try {
      discovery = await readContextDiscoverySnapshot(profile);
      if (flags.json) {
        const running = await discoverRunningProfiles();
        this.log(JSON.stringify({ profile, running: running.some((item) => item.profile === profile), context_discovery: discovery }));
        return;
      }
      info('context discovery:');
      for (const item of discovery) {
        const ageMs = Date.now() - new Date(item.verifiedAt).getTime();
        const age = ageMs < 60_000 ? 'just now' : ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)}m ago` : `${Math.floor(ageMs / 3_600_000)}h ago`;
        print(`${item.model}: ${item.maxInputTokens ?? 'unverified'} input tokens · ${item.state} · ${item.source} · ${age}`);
      }
    } catch {
      if (flags.json) {
        const running = await discoverRunningProfiles();
        this.log(JSON.stringify({ profile, running: running.some((item) => item.profile === profile), context_discovery: [] }));
        return;
      }
      info('context discovery: no result recorded');
    }

    const processState = await runtimeStatus(profile);
    print(processState ? `PID ${processState.pid}; routing ${processState.routingReady ? 'ready' : 'unavailable'}` : 'Stopped');
    try {
      const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) ok(`/health → ${r.status}`);
      else warn(`/health → ${r.status}`);
    } catch (e: any) { err(`health probe failed: ${e?.message ?? e}`); }

    {
      const stats = await fetchStats(baseUrl);
      if (stats && stats.overall.calls > 0) {
        const avg = stats.latencies?.routing.average_ms == null ? null : stats.latencies.routing.average_ms / 1000;
        const p50 = stats.latencies?.routing.p50_ms == null ? null : stats.latencies.routing.p50_ms / 1000;
        const p95 = stats.latencies?.routing.p95_ms == null ? null : stats.latencies.routing.p95_ms / 1000;
        info('latency (classifier):');
        if (avg !== null) print(`avg: ${formatLatency(avg)}`);
        if (p50 !== null) print(`p50: ${formatLatency(p50)}`);
        if (p95 !== null) print(`p95: ${formatLatency(p95)}`);
        const fp = (stats.classifier?.fallback_rate ?? 0) * 100;
        print(`fallback rate: ${fp.toFixed(1)}%  (${stats.classifier?.fallbacks ?? 0} fallbacks)`);
      } else if (stats) {
        info('latency: no requests yet');
      } else {
        info('latency: stats API unreachable');
      }
    }
  }
}
