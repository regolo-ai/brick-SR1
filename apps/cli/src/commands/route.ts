import { Args, Command, Flags } from '@oclif/core';
import { loadConfig } from '../lib/config/load.js';
import { readEnvValue } from '../lib/config/env-file.js';
import { paths } from '../lib/config/paths.js';
import { localBaseUrl } from '../lib/net/local.js';
import { requireExactlyOneRunning } from '../lib/profiles.js';

export default class Route extends Command {
  static description = 'Inspect local SystemOne routing without calling a generation provider';
  static args = { prompt: Args.string({ required: true }) };
  static flags = {
    json: Flags.boolean({ default: false }),
    repeat: Flags.integer({ default: 1, min: 1 }),
    effort: Flags.string({ options: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Override the profile routing knob using request effort' }),
  };
  async run(): Promise<void> {
    const { args, flags } = await this.parse(Route);
    const profile = await requireExactlyOneRunning();
    const cfg = await loadConfig(profile);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.codex_router?.enabled) headers['X-Brick-Key'] = await readEnvValue(paths(profile).env, cfg.codex_router.local_key_env) ?? '';
    const samples: number[] = [];
    let decision: any;
    for (let i = 0; i < flags.repeat; i++) {
      const started = performance.now();
      const response = await fetch(`${localBaseUrl(cfg.server_port)}/v1/routing/test`, {
        method: 'POST', headers, signal: AbortSignal.timeout(180000),
        body: JSON.stringify({ messages: [{ role: 'user', content: args.prompt }], ...(flags.effort ? { reasoning_effort: flags.effort } : {}) }),
      });
      decision = await response.json();
      if (!response.ok) this.error(decision.error?.message ?? 'SystemOne routing failed');
      samples.push(Math.round(performance.now() - started));
    }
    if (flags.json) { this.log(JSON.stringify({ ...decision, latency_ms: samples }, null, 2)); return; }
    this.log(`Selected model: ${decision.selected_model}`);
    this.log(`Knob: ${decision.knob}`);
    if (decision.query_vector) this.log(`Query vector: ${JSON.stringify(decision.query_vector)}`);
    if (decision.scaled_vector) this.log(`Scaled vector: ${JSON.stringify(decision.scaled_vector)}`);
    for (const candidate of decision.distances ?? []) this.log(`${candidate.model}: ${candidate.distance}`);
    this.log(`Routing latency (ms): ${samples.join(', ')}`);
  }
}
