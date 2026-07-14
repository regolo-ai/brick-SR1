import { Command, Flags } from '@oclif/core';
import { readWiring } from '../../../lib/claude/wiring-state.js';
import { getBaseUrl as getSettingsBaseUrl } from '../../../lib/claude/settings.js';
import { fetchRoutingStats, type RoutingModeStats } from '../../../lib/claude/metrics.js';
import { banner, ok, warn, err, info, print, header } from '../../../lib/ui/banners.js';
import { localBaseUrl } from '../../../lib/net/local.js';

// Promotion-gate thresholds for taking the orchestrator (mode B) out of shadow,
// mirrored from the design so the table can annotate progress. Median savings is
// tracked in price units here (per the sticky switch delta); the ~15% figure is
// a percentage target the economics endpoint reports separately, so we surface
// the raw signals and the session/latency gates rather than overclaiming a %.
const GATE_MIN_SESSIONS = 50;
const GATE_MAX_P95_DELTA_MS = 300;

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export default class ClaudeStatsRouting extends Command {
  static description =
    'Show per-mode routing event aggregates (sessions, sticky savings, p50/p95 latency) from the local Brick router. Feeds the orchestrator promotion gate.';

  static examples = [
    '<%= config.bin %> claude stats routing',
    '<%= config.bin %> claude stats routing --url http://localhost:19000',
  ];

  static flags = {
    url: Flags.string({
      char: 'u',
      description: 'brick base URL (default: $ANTHROPIC_BASE_URL, wiring, then http://localhost:8000)',
    }),
    json: Flags.boolean({ description: 'print the raw stats JSON' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ClaudeStatsRouting);
    const envUrl = process.env.ANTHROPIC_BASE_URL?.trim();
    const wiring = readWiring();
    const settingsUrl = getSettingsBaseUrl();
    const effectiveUrl = flags.url ?? envUrl ?? wiring?.baseUrl ?? settingsUrl ?? localBaseUrl(8000);
    const baseUrl = effectiveUrl.replace(/\/$/, '');

    const stats = await fetchRoutingStats(baseUrl);
    if (!stats) {
      err(`could not read routing stats from ${baseUrl}. Is the router running? (\`brick claude status\`)`);
      return;
    }
    if (flags.json) {
      this.log(JSON.stringify(stats, null, 2));
      return;
    }

    banner();
    header(`routing stats — ${baseUrl}`);

    if (!stats.modes || stats.modes.length === 0) {
      warn(stats.note || 'no routing events recorded yet');
      info('generate some routed traffic (use Claude Code wired to Brick), then re-run.');
      return;
    }

    // Columns: mode | requests | sessions | held | prefix-only save/held | net (honest) | p50 | p95.
    // "save/held" is the optimistic prefix-reprocessing-avoided figure; "net" is
    // the counterfactual total (sticky vs always-switch), shown only for turns
    // the router could price (enriched log + pricing table available).
    const rows = [...stats.modes].sort((a, b) => a.mode.localeCompare(b.mode));
    // The smartsqueeze column only appears when some mode actually compacted, so
    // the sticky/off view stays unchanged.
    const anySqueeze = rows.some((m) => (m.squeeze_turns ?? 0) > 0);
    const squeezeHead = anySqueeze ? pad('squeeze save', 16) : '';
    print(
      `${pad('mode', 14)}${pad('reqs', 7)}${pad('sessions', 10)}${pad('held', 6)}${pad('save/held', 12)}${pad('net (honest)', 14)}${squeezeHead}${pad('p50 ms', 9)}${pad('p95 ms', 9)}`
    );
    for (const m of rows) {
      const net = m.net_units_sticky_minus_no_sticky !== undefined && m.savings_pct !== undefined
        ? `${m.net_units_sticky_minus_no_sticky.toFixed(0)} (${m.savings_pct.toFixed(1)}%)`
        : '—';
      let squeeze = '';
      if (anySqueeze) {
        const turns = m.squeeze_turns ?? 0;
        if (turns > 0) {
          const units = m.squeeze_est_units_saved !== undefined ? m.squeeze_est_units_saved.toFixed(0) : '?';
          squeeze = pad(`${units}u/${turns}t`, 16);
        } else {
          squeeze = pad('—', 16);
        }
      }
      print(
        `${pad(m.mode, 14)}${pad(String(m.requests), 7)}${pad(String(m.sessions), 10)}${pad(String(m.held_requests), 6)}` +
          `${pad(m.median_switch_delta_price_units_held.toFixed(3), 12)}${pad(net, 14)}${squeeze}${pad(String(m.latency_p50_ms), 9)}${pad(String(m.latency_p95_ms), 9)}`
      );
    }
    print('');
    info(`total: ${stats.total_requests} requests across ${stats.total_sessions} sessions`);
    const anyPriced = rows.some((m) => m.priced_requests !== undefined);
    if (!anyPriced) {
      info("'net (honest)' needs enriched routing events (per-turn token breakdown) + a loaded pricing table; showing prefix-only 'save/held' only for now.");
    }
    const ss = rows.find((m) => m.mode === 'smartsqueeze' && (m.squeeze_turns ?? 0) > 0);
    if (ss) {
      const units = ss.squeeze_est_units_saved !== undefined ? `${ss.squeeze_est_units_saved.toFixed(0)} price units` : '(pricing table needed to value it)';
      info(
        `smartsqueeze: compacted ${ss.squeeze_turns} switch turn(s), ~${ss.squeeze_est_tokens_saved_total ?? 0} prefix tokens cleared (median ${ss.squeeze_est_tokens_saved_median ?? 0}/turn), avoided re-prefill worth ${units}.`
      );
    }

    this.printGate(rows);
  }

  /** Annotate progress toward the orchestrator promotion gate, computed from the
   *  sticky row (and its latency delta vs the off baseline when present). */
  private printGate(rows: RoutingModeStats[]): void {
    const sticky = rows.find((m) => m.mode === 'sticky');
    const off = rows.find((m) => m.mode === 'off');
    if (!sticky) {
      info('promotion gate: run mode `sticky` to accumulate the numbers (brick claude settings mode sticky).');
      return;
    }
    header('promotion gate (mode B / orchestrator)');

    const sessOk = sticky.sessions >= GATE_MIN_SESSIONS;
    print(`${sessOk ? '✓' : '·'} dev sessions: ${sticky.sessions} / ${GATE_MIN_SESSIONS}`);

    if (off) {
      const delta = sticky.latency_p95_ms - off.latency_p95_ms;
      const latOk = delta <= GATE_MAX_P95_DELTA_MS;
      print(`${latOk ? '✓' : '·'} p95 latency vs off: ${delta >= 0 ? '+' : ''}${delta} ms (<= +${GATE_MAX_P95_DELTA_MS} ms)`);
    } else {
      print(`· p95 latency vs off: need an 'off' baseline (run mode off for a while to compare)`);
    }

    if (sticky.net_units_sticky_minus_no_sticky !== undefined && sticky.savings_pct !== undefined) {
      print(
        `· net savings (sticky vs always-switch): ${sticky.net_units_sticky_minus_no_sticky.toFixed(0)} price units (${sticky.savings_pct.toFixed(1)}%), ${sticky.priced_requests} priced turns` +
          (sticky.held_turns_where_sticky_costlier ? `, ${sticky.held_turns_where_sticky_costlier} held turn(s) where sticky cost MORE` : '')
      );
    } else {
      print(`· median sticky savings (prefix-only, optimistic): ${sticky.median_switch_delta_price_units_held.toFixed(3)} price units/held turn`);
    }
    info('see docs/proof/sticky-savings.md for a worked example and how these numbers are computed.');
  }
}
