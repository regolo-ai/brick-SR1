import { Args, Command } from '@oclif/core';
import { ensureServing } from '../lib/runtime/serve.js';
import { editConfigProfile } from '../lib/config/editor.js';
export default class Restart extends Command {
  static description = 'Restart a profile';
  static args = { profile: Args.string({ required: true }) };
  async run(): Promise<void> { const { args } = await this.parse(Restart); try { await ensureServing(args.profile, { forceRecreate: true }); } catch (error: any) { if (!String(error?.message).includes('has no active models') || !process.stdin.isTTY) throw error; await editConfigProfile(args.profile, `Select models for '${args.profile}'`); await ensureServing(args.profile, { forceRecreate: true }); } }
}
