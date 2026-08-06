import { Args, Command, Flags } from '@oclif/core';
import { chatCompletion } from '../lib/client/openai.js';
import { loadConfig } from '../lib/config/load.js';
import { localBaseUrl } from '../lib/net/local.js';

export default class Generate extends Command {
  static description = 'One-shot completion against the router (prints assistant content to stdout)';
  static args = { prompt: Args.string({ required: true }) };
  static flags = {
    profile: Flags.string({ description: 'profile name (defaults to running or active profile)' }),
    model: Flags.string({ default: 'brick' }),
    system: Flags.string(),
    'max-tokens': Flags.integer({ default: 512 }),
    thinking: Flags.string({ options: ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'], description: 'force brick-thinking mode (off|low|medium|high|xhigh|max|auto)' }),
  };
  async run(): Promise<void> {
    const { args, flags } = await this.parse(Generate);
    const cfg = await loadConfig(flags.profile);
    const baseUrl = localBaseUrl(cfg.server_port);
    const messages = [];
    if (flags.system) messages.push({ role: 'system' as const, content: flags.system });
    messages.push({ role: 'user' as const, content: args.prompt });
    const r = await chatCompletion({
      baseUrl, model: flags.model, messages, maxTokens: flags['max-tokens'],
      thinking: flags.thinking as any,
    });
    const out = r.content && r.content.trim().length > 0 ? r.content : (r.reasoning ?? '');
    process.stdout.write(out + '\n');
    if (r.status >= 400) this.exit(1);
  }
}
