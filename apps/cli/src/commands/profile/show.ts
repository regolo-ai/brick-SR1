import { Args, Command, Flags } from '@oclif/core';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { paths, resolveProfile } from '../../lib/config/paths.js';
import { ConfigSchema } from '../../lib/config/schema.js';
export default class ProfileShow extends Command {
  static description = 'Show a profile configuration';
  static args = { name: Args.string({ required: true }) };
  static flags = { raw: Flags.boolean(), json: Flags.boolean(), path: Flags.boolean() };
  async run(): Promise<void> { const { args, flags } = await this.parse(ProfileShow); const name = resolveProfile(args.name); const path = paths(name).config; if (flags.path) { this.log(path); return; } const raw = await readFile(path, 'utf8'); if (flags.raw) { this.log(raw.trimEnd()); return; } const value = yaml.load(raw); if (flags.json) { this.log(JSON.stringify(value, null, 2)); return; } const cfg = ConfigSchema.parse(value); this.log(`profile: ${name}\nserver port: ${cfg.server_port}\ndefault model: ${cfg.default_model || '(none)'}\nactive models: ${(cfg.skill_router?.active_models ?? []).join(', ') || '(none)'}`); }
}
