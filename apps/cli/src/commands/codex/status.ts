import { Command, Flags } from '@oclif/core';
import React from 'react';
import { render } from 'ink';
import { DEFAULT_CODEX_PORT } from '../../lib/codex/bootstrap.js';
import { localBaseUrl } from '../../lib/net/local.js';
import {
  readCodexConfig,
  getTopLevelModel,
  getTopLevelModelProvider,
  getTopLevelProfile,
  isWired,
  codexConfigPath,
} from '../../lib/codex/config-toml.js';
import { readCodexWiring } from '../../lib/codex/wiring-state.js';
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
  type ParsedMetrics,
} from '../../lib/claude/metrics.js';
import { Dashboard } from '../../lib/claude-tui/Dashboard.js';
import { R_BY_MODE } from '../../lib/claude/modes.js';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const tick = `${C.green}✓${C.reset}`;
const cross = `${C.red}✗${C.reset}`;

export default class CodexStatus extends Command {
  static description = 'Show whether OpenAI Codex is wired to the local Brick router, and how it has been routing prompts.';

  static examples = [
    '<%= config.bin %> codex status',
    '<%= config.bin %> codex status --once',
    '<%= config.bin %> codex status --url http://localhost:8000',
  ];

  static flags = {
    url: Flags.string({
      char: 'u',
      description: 'brick base URL (default: wired Codex URL or http://localhost:8000)',
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
    const { flags } = await this.parse(CodexStatus);
    const wiring = readCodexWiring();
    const baseUrl = (flags.url ?? wiring?.baseUrl ?? localBaseUrl(DEFAULT_CODEX_PORT)).replace(/\/$/, '');

    const text = readCodexConfig();
    const blockPresent = isWired(text);
    const activeModel = getTopLevelModel(text);
    const activeProvider = getTopLevelModelProvider(text);
    const legacyProfile = getTopLevelProfile(text);
    const wired = blockPresent && activeModel === 'brick' && activeProvider === 'brick';

    const wantsLive = !flags.once && process.stdout.isTTY;
    if (wantsLive) {
      const { waitUntilExit } = render(
        React.createElement(Dashboard, {
          baseUrl,
          envUrl: wired ? baseUrl : undefined,
          intervalMs: Math.max(500, flags.interval * 1000),
          mode: wiring?.mode,
          connectionLabel: 'CODEX provider',
          emptyRequestsLabel: 'no /v1/chat/completions requests served yet',
          nativeLabel: 'client-selected model, router bypass',
          showEconomy: false,
        })
      );
      await waitUntilExit();
      return;
    }

    const snap = await fetchSnapshot(baseUrl, wired ? baseUrl : undefined);

    this.log('');
    this.log(`${C.bold}${C.cyan}Codex Wiring${C.reset}`);
    this.log(`  config.toml         ${codexConfigPath()}`);
    this.log(
      `  model               ${activeModel ?? `${C.dim}(none)${C.reset}`}  ${
        activeModel === 'brick' ? `${tick} brick` : `${cross} not brick`
      }`
    );
    this.log(
      `  model_provider      ${activeProvider ?? `${C.dim}(none)${C.reset}`}  ${
        activeProvider === 'brick' ? `${tick} brick` : `${cross} not brick`
      }`
    );
    this.log(`  managed provider    ${blockPresent ? `${tick} present (wire_api=responses)` : `${cross} absent`}`);
    if (legacyProfile === 'brick') {
      this.log(`  legacy profile      ${C.yellow}profile = "brick" still present${C.reset}`);
    }
    this.log(`  brick router        ${baseUrl}  ${snap.health ? `${tick} healthy` : `${cross} unreachable`}`);

    const diag = snap.diag;
    if (!diag) {
      this.log(`  classifier          ${cross} could not reach /api/v1/diag/classifier on brick`);
    } else if (!diag.enabled) {
      this.log(`  classifier          ${C.dim}disabled in config${C.reset}`);
    } else if (diag.reachable) {
      this.log(
        `  classifier          ${diag.endpoint ?? '(unknown)'}  ${tick} healthy (${diag.device ?? '?'}, last ${
          diag.latency_ms ?? '?'
        }ms)`
      );
    } else {
      this.log(
        `  classifier          ${diag.endpoint ?? '(unknown)'}  ${cross} unreachable${
          diag.error ? ` - ${diag.error}` : ''
        }`
      );
    }

    if (wiring?.mode) {
      this.log(`  mode                ${wiring.mode}  (r=${R_BY_MODE[wiring.mode]})`);
    }
    if (wiring?.computeMode) {
      this.log(`  compute             ${wiring.computeMode}`);
    }
    if (typeof wiring?.contextAwareness === 'boolean') {
      this.log(`  context awareness   ${wiring.contextAwareness ? 'on' : 'off'}`);
    }
    if (typeof wiring?.modelRouting === 'boolean') {
      this.log(`  model routing       ${wiring.modelRouting ? 'on' : 'off'}${wiring.fixedModel ? `  (${wiring.fixedModel})` : ''}`);
    }
    if (typeof wiring?.thinkingRouting === 'boolean') {
      this.log(`  thinking routing    ${wiring.thinkingRouting ? 'on' : 'off'}`);
    }

    if (!snap.health) {
      this.log('');
      this.log(`${C.yellow}brick is not responding. Skipping routing stats.${C.reset}`);
      return;
    }

    if (!snap.metrics) {
      this.log('');
      this.log(`${C.yellow}Metrics endpoint not reachable; cannot show routing stats.${C.reset}`);
      this.log(`${C.dim}  (brick exposes Prometheus metrics on its own port - usually 9190 or 19190.)${C.reset}`);
      return;
    }

    this.log('');
    this.log(`${C.bold}${C.cyan}Routing Since Restart${C.reset}`);
    this.printRoutingStats(snap.metrics);

    this.log('');
    this.log(`${C.dim}Live dashboard: run brick codex status in an interactive terminal (or --once for this static view).${C.reset}`);
  }

  private printRoutingStats(m: ParsedMetrics): void {
    const total = totalRequests(m);
    if (total === 0) {
      this.log(`  ${C.dim}No /v1/chat/completions requests served yet.${C.reset}`);
      return;
    }

    this.log(`  ${C.dim}routed by model${C.reset}`);
    for (const row of routedRowsByModel(m)) {
      const pct = row.pct.toFixed(0).padStart(2);
      this.log(`    ${row.model.padEnd(22)}  ${String(row.count).padStart(4)}  (${pct}%)`);
      for (const e of effortRowsForModel(m, row.model)) {
        const epct = e.pct.toFixed(0).padStart(2);
        this.log(`      ${C.dim}└ ${e.label.padEnd(18)}  ${String(e.count).padStart(4)}  (${epct}%)${C.reset}`);
      }
    }

    const native = nativeRowsByModel(m);
    if (native.length > 0) {
      this.log('');
      this.log(`  ${C.dim}client-selected model, router bypass${C.reset}`);
      for (const row of native) {
        const pct = row.pct.toFixed(0).padStart(2);
        this.log(`    ${row.model.padEnd(22)}  ${String(row.count).padStart(4)}  (${pct}%)`);
      }
    }

    const difficulty = difficultyDistribution(m);
    if (difficulty.length > 0) {
      this.log('');
      this.log(`  ${C.dim}difficulty mix (classifier verdict, routed only)${C.reset}`);
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
        `  Classifier latency    avg ${formatLatency(mean)} ${C.dim}.${C.reset} p50 ${formatLatency(
          p50
        )} ${C.dim}.${C.reset} p95 ${formatLatency(p95)}`
      );
    }

    const pct = fallbackPct(m);
    const fallbackColor = pct > 5 ? C.red : pct > 1 ? C.yellow : C.green;
    this.log(`  Fallback rate          ${fallbackColor}${pct.toFixed(1)}%${C.reset} (${m.fallbackTotal} fallbacks)`);
  }
}
