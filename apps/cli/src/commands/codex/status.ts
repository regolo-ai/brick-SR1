import { Command, Flags } from '@oclif/core';
import { codexConfigPath, readCodexConfig, getTopLevelModel, getTopLevelModelProvider, isWired } from '../../lib/codex/config-toml.js';
import { readCodexWiring } from '../../lib/codex/wiring-state.js';

/** Passive status never performs classification or inference. */
export default class CodexStatus extends Command {
  static description = 'Show Codex wiring and native router reachability without inference probes.';
  static flags = {
    url: Flags.string({ char: 'u', description: 'router URL' }),
    once: Flags.boolean({ char: 'o', description: 'show one status snapshot' }),
    watch: Flags.boolean({ char: 'w', description: 'refresh passive router status' }),
    interval: Flags.integer({ default: 2, description: 'refresh interval in seconds' }),
  };
  async run(): Promise<void> {
    const { flags } = await this.parse(CodexStatus);
    const wiring = readCodexWiring();
    const url = flags.url ?? wiring?.baseUrl ?? 'http://127.0.0.1:8000';
    do {
      const text = readCodexConfig();
      let health: any = null;
      let stats: any = null;
      try { const response = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(2000), redirect: 'error' }); if (response.ok) health = await response.json(); } catch { /* Report reachability independently of authentication. */ }
      if (health) {
        try { const response = await fetch(`${url.replace(/\/$/, '')}/api/v1/stats`, { signal: AbortSignal.timeout(2000), redirect: 'error' }); if (response.ok) stats = await response.json(); } catch { /* Kept distinct from a reachable but empty history. */ }
      }
      this.log(`Config: ${codexConfigPath()}`);
      this.log(`Wiring: ${isWired(text) ? 'managed' : 'off'}; model: ${getTopLevelModel(text) ?? '(default)'}; provider: ${getTopLevelModelProvider(text) ?? '(default)'}`);
      this.log(`Router: ${health ? 'reachable' : 'unreachable'} (${url})`);
      this.log(`Protocol: ${health?.codex_router ?? 'native Responses support not confirmed'}`);
      if (!health) this.log('Routing: API unreachable');
      else if (!stats) this.log('Routing: stats API unavailable');
      else if ((stats.overall?.calls ?? 0) === 0) this.log('Routing: no calls recorded yet');
      else {
        this.log(`Routing: ${stats.overall.calls} calls (${stats.overall.completed_calls} completed, ${stats.overall.failed_calls} failed)`);
        for (const row of stats.models ?? []) {
          const thinking = (row.reasoning_modes ?? []).map((m: any) => `${m.mode}:${m.calls}`).join(', ') || 'default';
          this.log(`  ${row.model}: ${row.routed_calls} routed, ${row.native_calls} native · thinking ${thinking}`);
        }
      }
      this.log('Upstream authentication: not probed. Tool capability: not probed. Status refresh does not run inference.');
      if (!flags.watch || flags.once) break;
      await new Promise(resolve => setTimeout(resolve, Math.max(1, flags.interval) * 1000));
    } while (true);
  }
}
