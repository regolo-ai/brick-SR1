import { Args, Command, Flags } from '@oclif/core';
import { chatCompletion } from '../lib/client/openai.js';
import { loadConfig } from '../lib/config/load.js';
import { print } from '../lib/ui/banners.js';
import { localBaseUrl } from '../lib/net/local.js';
import chalk from 'chalk';

function fmtLatency(ms: number): string {
  if (ms < 1000) return chalk.green(`${ms} ms`);
  if (ms < 3000) return chalk.yellow(`${(ms / 1000).toFixed(2)} s`);
  return chalk.red(`${(ms / 1000).toFixed(2)} s`);
}

export default class Route extends Command {
  static description = 'Show which backend model the router selects for <prompt>';
  static args = { prompt: Args.string({ required: true, description: 'user prompt' }) };
  static flags = {
    profile: Flags.string({ description: 'profile name (defaults to running or active profile)' }),
    model: Flags.string({ default: 'brick' }),
    json: Flags.boolean({ default: false }),
    'no-generate': Flags.boolean({ default: false, description: 'use minimal max_tokens=1 to measure routing-only latency' }),
    repeat: Flags.integer({ default: 1, description: 'run N times and report min/median/max latency' }),
    thinking: Flags.string({ options: ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'], description: 'force brick-thinking mode (off|low|medium|high|xhigh|max|auto)' }),
  };
  async run(): Promise<void> {
    const { args, flags } = await this.parse(Route);
    const cfg = await loadConfig(flags.profile);
    const baseUrl = localBaseUrl(cfg.server_port);
    const maxTokens = flags['no-generate'] ? 1 : 8;
    const samples: { latencyMs: number; selectedModel?: string; thinkingApplied?: string; status: number; content: string }[] = [];
    for (let i = 0; i < flags.repeat; i++) {
      const r = await chatCompletion({
        baseUrl, model: flags.model,
        messages: [{ role: 'user', content: args.prompt }],
        maxTokens,
        thinking: flags.thinking as any,
      });
      samples.push({ latencyMs: r.latencyMs, selectedModel: r.selectedModel, thinkingApplied: r.thinkingApplied, status: r.status, content: r.content });
    }
    const lat = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
    const min = lat[0];
    const med = lat[Math.floor(lat.length / 2)];
    const max = lat[lat.length - 1];
    const last = samples[samples.length - 1];

    if (flags.json) {
      console.log(JSON.stringify({
        prompt: args.prompt,
        selected_model: last.selectedModel,
        thinking_applied: last.thinkingApplied,
        status: last.status,
        latency_ms: { min, median: med, max, samples: lat },
        content: last.content,
      }, null, 2));
      return;
    }
    print();
    print(chalk.cyan('prompt:         ') + args.prompt);
    print(chalk.cyan('selected model: ') + chalk.green(last.selectedModel ?? '(no header)'));
    if (last.thinkingApplied) print(chalk.cyan('thinking mode:  ') + chalk.green(last.thinkingApplied));
    print(chalk.cyan('http status:    ') + last.status);
    if (flags.repeat === 1) {
      print(chalk.cyan('latency:        ') + fmtLatency(last.latencyMs));
    } else {
      print(chalk.cyan('latency:        ') + `min ${fmtLatency(min)} · median ${fmtLatency(med)} · max ${fmtLatency(max)} (n=${flags.repeat})`);
    }
    print(chalk.cyan('preview:        ') + (last.content || '').slice(0, 200));
    print();
  }
}
