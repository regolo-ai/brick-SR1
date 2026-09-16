import { Args, Command } from '@oclif/core';
import { ensureServing } from '../lib/runtime/serve.js';
import { discoverRunningProfiles } from '../lib/profiles.js';
import { connectOfficialHarness } from '../lib/harness.js';
import { editConfigProfile } from '../lib/config/editor.js';
import { ok } from '../lib/ui/banners.js';
export default class Start extends Command {
  static description = 'Start a profile';
  static args = { profile: Args.string({ required: true }) };
  async run(): Promise<void> { const { args } = await this.parse(Start); const running = await discoverRunningProfiles(); if (running.some((p) => p.profile !== args.profile)) this.error(`profile '${running[0].profile}' is already running`); let result; try { result = await ensureServing(args.profile); } catch (error: any) { if (!String(error?.message).includes('has no active models') || !process.stdin.isTTY) throw error; await editConfigProfile(args.profile, `Select models for '${args.profile}'`); result = await ensureServing(args.profile); } if (!result.healthy) this.error(`router for '${args.profile}' did not become healthy`); await connectOfficialHarness(args.profile, result.port); ok(`Profile started: '${args.profile}'`); }
}
