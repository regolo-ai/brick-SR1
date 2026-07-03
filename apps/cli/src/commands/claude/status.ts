import { Command, Flags } from '@oclif/core';
import React from 'react';
import { render } from 'ink';
import {
  fetchSnapshot,
  routedRowsByModel,
  nativeRowsByModel,
  difficultyDistribution,
  effortRowsForModel,
  totalRequests,
  classifierPercentiles,
  classifierMean,
  fallbackPct,
  formatLatency,
  fetchEconomics,
  unifyEconomy,
  type ParsedMetrics,
  type EconomicsResponse,
} from '../../lib/claude/metrics.js';
import { Dashboard } from '../../lib/claude-tui/Dashboard.js';
import { readWiring } from '../../lib/claude/wiring-state.js';
import { getBaseUrl as getSettingsBaseUrl } from '../../lib/claude/settings.js';
import { R_BY_MODE, MODEL_MAP_BY_MODE, formatMap } from '../../lib/claude/modes.js';

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const tick = `${COLORS.green}✓${COLORS.reset}`;
const cross = `${COLORS.red}✗${COLORS.reset}`;

export default class ClaudeStatus extends Command {
  static description =
    'Show whether Claude Code is wired to the local Brick router, and how it has been routing prompts.';

  static examples = [
    '<%= config.bin %> claude status',
    '<%= config.bin %> claude status --once',
    '<%= config.bin %> claude status --url http://localhost:19000',
  ];

  static flags = {
    url: Flags.string({
      char: 'u',
      description: 'brick base URL (default: $ANTHROPIC_BASE_URL or http://localhost:18000)',
    }),
    once: Flags.boolean({
      char: 'o',
      description: 'one-shot static output instead of the live dashboard',
    }),
    watch: Flags.boolean({
      char: 'w',
      description: 'force the live dashboard (now the default in an interactive terminal)',
    }),
    interval: Flags.integer({
      default: 2,
      description: 'dashboard refresh interval in seconds',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ClaudeStatus);
    const envUrl = process.env.ANTHROPIC_BASE_URL?.trim();
    // Prefer the wired URL from wiring-state (written by `brick claude on`), then
    // fall back to the env var, then to settings.json, then to the hard default.
    const wiring = readWiring();
    const settingsUrl = getSettingsBaseUrl();
    const effectiveUrl = flags.url ?? envUrl ?? wiring?.baseUrl ?? settingsUrl ?? 'http://localhost:8000';
    const baseUrl = effectiveUrl.replace(/\/$/, '');

    // Determine what to show for ANTHROPIC_BASE_URL: env var, settings.json, or unset.
    const displayUrl = envUrl ?? settingsUrl;
    const displaySource = envUrl ? 'env' : settingsUrl ? 'settings.json' : null;
    const isAttached = !!displayUrl && displayUrl.replace(/\/$/, '') === baseUrl;

    // The live dashboard is the default in an interactive terminal. `--once`
    // forces the static text output; when there is no TTY (pipe, redirect, CI)
    // we silently fall back to it instead of erroring.
    const wantsLive = !flags.once && process.stdout.isTTY;
    if (wantsLive) {
      const { waitUntilExit } = render(
        React.createElement(Dashboard, { baseUrl, envUrl: displayUrl, intervalMs: Math.max(500, flags.interval * 1000), mode: wiring?.mode })
      );
      await waitUntilExit();
      return;
    }

    const snap = await fetchSnapshot(baseUrl, displayUrl);
    const econ = await fetchEconomics(baseUrl);

    this.log('');
    this.log(`${COLORS.bold}${COLORS.cyan}Connection${COLORS.reset}`);
    if (displayUrl) {
      const sourceTag = displaySource === 'settings.json' ? ` ${COLORS.dim}(via settings.json)${COLORS.reset}` : '';
      this.log(
        `  ANTHROPIC_BASE_URL  ${displayUrl}${sourceTag}  ${
          isAttached ? `${tick} wired` : `${cross} not pointing at ${baseUrl}`
        }`
      );
    } else {
      this.log(`  ANTHROPIC_BASE_URL  ${COLORS.dim}(not set in env or settings.json)${COLORS.reset}  ${cross} not wired`);
    }
    this.log(`  brick             ${baseUrl}  ${snap.health ? `${tick} healthy` : `${cross} unreachable`}`);

    const diag = snap.diag;
    if (!diag) {
      this.log(`  classifier          ${cross} could not reach /api/v1/diag/classifier on brick`);
    } else if (!diag.enabled) {
      this.log(`  classifier          ${COLORS.dim}disabled in config${COLORS.reset}`);
    } else if (diag.reachable) {
      this.log(
        `  classifier          ${diag.endpoint ?? '(unknown)'}  ${tick} healthy (${diag.device ?? '?'}, last ${
          diag.latency_ms ?? '?'
        }ms)`
      );
    } else {
      this.log(
        `  classifier          ${diag.endpoint ?? '(unknown)'}  ${cross} unreachable${
          diag.error ? ` — ${diag.error}` : ''
        }`
      );
    }

    if (wiring?.mode) {
      const r = R_BY_MODE[wiring.mode];
      const map = formatMap(MODEL_MAP_BY_MODE[wiring.mode]);
      this.log(`  mode                ${wiring.mode}  (r=${r})  ${COLORS.dim}· ${map}${COLORS.reset}`);
    }

    if (!snap.health) {
      this.log('');
      this.log(`${COLORS.yellow}brick is not responding. Skipping routing stats.${COLORS.reset}`);
      return;
    }

    if (!snap.metrics) {
      this.log('');
      this.log(`${COLORS.yellow}Metrics endpoint not reachable; cannot show routing stats.${COLORS.reset}`);
      this.log(`${COLORS.dim}  (brick exposes Prometheus metrics on its own port — usually 9190 or 19190.)${COLORS.reset}`);
      return;
    }

    this.log('');
    this.log(`${COLORS.bold}${COLORS.cyan}Routing since restart${COLORS.reset}`);
    this.printRoutingStats(snap.metrics, econ);

    this.log('');
    this.log(`${COLORS.dim}Live dashboard: run brick claude status in an interactive terminal (or --once for this static view).${COLORS.reset}`);
  }

  private printRoutingStats(m: ParsedMetrics, econ: EconomicsResponse | null): void {
    const total = totalRequests(m);
    if (total === 0) {
      this.log(`  ${COLORS.dim}No /v1/messages requests served yet.${COLORS.reset}`);
      return;
    }

    this.log(`  ${COLORS.dim}routed by model${COLORS.reset}`);
    for (const row of routedRowsByModel(m)) {
      const pct = row.pct.toFixed(0).padStart(2);
      this.log(`    ${row.model.padEnd(22)}  ${String(row.count).padStart(4)}  (${pct}%)`);
      for (const e of effortRowsForModel(m, row.model)) {
        const epct = e.pct.toFixed(0).padStart(2);
        this.log(`      ${COLORS.dim}└ ${e.label.padEnd(18)}  ${String(e.count).padStart(4)}  (${epct}%)${COLORS.reset}`);
      }
    }

    const native = nativeRowsByModel(m);
    if (native.length > 0) {
      this.log('');
      this.log(`  ${COLORS.dim}subagents (native model, router bypass)${COLORS.reset}`);
      for (const row of native) {
        const pct = row.pct.toFixed(0).padStart(2);
        this.log(`    ${row.model.padEnd(22)}  ${String(row.count).padStart(4)}  (${pct}%)`);
      }
    }

    const difficulty = difficultyDistribution(m);
    if (difficulty.length > 0) {
      this.log('');
      this.log(`  ${COLORS.dim}difficulty mix (classifier verdict, routed only)${COLORS.reset}`);
      for (const row of difficulty) {
        const pct = row.pct.toFixed(0).padStart(2);
        this.log(`    ${row.label.padEnd(22)}  ${String(row.count).padStart(4)}  (${pct}%)`);
      }
    }

    this.log('');
    this.log(`  Total requests        ${total}`);

    const mean = classifierMean(m);
    const { p50, p95 } = classifierPercentiles(m);
    if (mean !== null && p50 !== null && p95 !== null) {
      this.log(
        `  Classifier latency    avg ${formatLatency(mean)} ${COLORS.dim}·${COLORS.reset} p50 ${formatLatency(
          p50
        )} ${COLORS.dim}·${COLORS.reset} p95 ${formatLatency(p95)}`
      );
    }

    const pct = fallbackPct(m);
    const fallbackColor = pct > 5 ? COLORS.red : pct > 1 ? COLORS.yellow : COLORS.green;
    this.log(`  Fallback rate          ${fallbackColor}${pct.toFixed(1)}%${COLORS.reset} (${m.fallbackTotal} fallbacks)`);

    const ue = unifyEconomy(econ, m);
    const hasEconomyData = ue.source === 'real' || (ue.totalRoutedReqs ?? 0) > 0;
    if (hasEconomyData) {
      this.log('');
      this.log(`${COLORS.bold}${COLORS.cyan}Economy${COLORS.reset}`);
      const savedColor = ue.savedPct > 50 ? COLORS.green : ue.savedPct > 20 ? COLORS.yellow : COLORS.dim;
      if (ue.source === 'real') {
        this.log(
          `  ${savedColor}saved ~${ue.savedPct.toFixed(0)}%${COLORS.reset} vs all-${ue.mostExpensiveModel}  ${COLORS.dim}(real token counts, cache-aware)${COLORS.reset}`
        );
        const cacheTokens = (ue.totalCacheReadTokens ?? 0) + (ue.totalCacheCreationTokens ?? 0);
        this.log(
          `  ${COLORS.dim}tokens: ${ue.totalInputTokens?.toLocaleString()} in + ${cacheTokens.toLocaleString()} cache / ${ue.totalOutputTokens?.toLocaleString()} out${COLORS.reset}`
        );
      } else {
        this.log(
          `  ${savedColor}saved ~${ue.savedPct.toFixed(0)}%${COLORS.reset} vs all-opus  ${COLORS.dim}(${ue.totalRoutedReqs} routed reqs)${COLORS.reset}`
        );
        this.log(`  ${COLORS.dim}relative estimate from request mix; excludes real token counts & caching${COLORS.reset}`);
      }
    }
  }
}
