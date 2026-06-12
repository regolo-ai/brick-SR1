import { Command, Flags } from '@oclif/core';
import React from 'react';
import { render } from 'ink';
import {
  fetchSnapshot,
  routingRows,
  totalRequests,
  classifierPercentiles,
  fallbackPct,
  formatLatency,
  type ParsedMetrics,
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
    '<%= config.bin %> claude status --watch',
    '<%= config.bin %> claude status --url http://localhost:19000',
  ];

  static flags = {
    url: Flags.string({
      char: 'u',
      description: 'brick base URL (default: $ANTHROPIC_BASE_URL or http://localhost:18000)',
    }),
    watch: Flags.boolean({
      char: 'w',
      description: 'live terminal dashboard that refreshes performance stats',
    }),
    interval: Flags.integer({
      default: 2,
      description: 'dashboard refresh interval in seconds (with --watch)',
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

    if (flags.watch) {
      if (!process.stdout.isTTY) {
        this.error('--watch requires an interactive TTY. Run `brick claude status` for one-shot output.', { exit: 2 });
      }
      const { waitUntilExit } = render(
        React.createElement(Dashboard, { baseUrl, envUrl: displayUrl, intervalMs: Math.max(500, flags.interval * 1000) })
      );
      await waitUntilExit();
      return;
    }

    const snap = await fetchSnapshot(baseUrl, displayUrl);

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
    this.printRoutingStats(snap.metrics);

    this.log('');
    this.log(`${COLORS.dim}Live dashboard: brick claude status --watch${COLORS.reset}`);
  }

  private printRoutingStats(m: ParsedMetrics): void {
    const total = totalRequests(m);
    if (total === 0) {
      this.log(`  ${COLORS.dim}No /v1/messages requests served yet.${COLORS.reset}`);
      return;
    }

    for (const row of routingRows(m)) {
      const pct = row.pct.toFixed(0).padStart(2);
      this.log(`  ${row.label.padEnd(6)} → ${row.model.padEnd(20)}  ${String(row.count).padStart(4)}  (${pct}%)`);
    }
    this.log(`  Total requests        ${total}`);

    const { p50, p95 } = classifierPercentiles(m);
    if (p50 !== null && p95 !== null) {
      this.log(`  Classifier p50/p95    ${formatLatency(p50)} / ${formatLatency(p95)}`);
    }

    const pct = fallbackPct(m);
    const fallbackColor = pct > 5 ? COLORS.red : pct > 1 ? COLORS.yellow : COLORS.green;
    this.log(`  Fallback rate          ${fallbackColor}${pct.toFixed(1)}%${COLORS.reset} (${m.fallbackTotal} fallbacks)`);
  }
}
