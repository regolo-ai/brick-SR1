import { Args, Command, Flags } from '@oclif/core';
import { readFile } from 'node:fs/promises';
import chalk from 'chalk';
import yaml from 'js-yaml';
import { paths, resolveProfile, listProfiles, readState } from '../../lib/config/paths.js';
import { ConfigSchema } from '../../lib/config/schema.js';
import { err, info, print } from '../../lib/ui/banners.js';
import { makeTable, renderTable } from '../../lib/ui/tables.js';

const SUB_VERBS = new Set(['ai', 'edit']);

export default class ConfigShow extends Command {
  static description = 'Show the configuration of a profile (or, with `<profile> ai`/`edit`, dispatch to that sub-command)';
  static strict = false;
  static args = {
    profile: Args.string({ required: false, description: 'profile name (defaults to active profile)' }),
    action: Args.string({ required: false, description: 'optional: "ai" or "edit" to open that sub-command for the profile' }),
  };
  static flags = {
    raw: Flags.boolean({ default: false, description: 'print the YAML verbatim (no summary)' }),
    json: Flags.boolean({ default: false, description: 'print as JSON' }),
    path: Flags.boolean({ default: false, description: 'print only the config path' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ConfigShow);

    // Allow `brick config <profile> ai` / `<profile> edit` syntax by re-dispatching.
    if (args.profile && args.action && SUB_VERBS.has(args.action)) {
      const target = args.action === 'ai' ? 'config:ai' : 'config:edit';
      await this.config.runCommand(target, [args.profile]);
      return;
    }

    if (!args.profile && listProfiles().length === 0) {
      err('no profiles configured. Run `brick config new <name>` to create one.');
      this.exit(1);
    }

    const profile = resolveProfile(args.profile);
    const pp = paths(profile);
    const state = readState();

    if (flags.path) { console.log(pp.config); return; }

    let raw: string;
    try { raw = await readFile(pp.config, 'utf8'); }
    catch { err(`no config at ${pp.config}.`); this.exit(1); }

    if (flags.raw) { process.stdout.write(raw); return; }

    let parsed: any;
    try { parsed = yaml.load(raw); } catch (e: any) { err(`failed to parse YAML: ${e?.message ?? e}`); this.exit(1); }

    if (flags.json) { console.log(JSON.stringify(parsed, null, 2)); return; }

    const cfg = ConfigSchema.parse(parsed);

    const flags_str: string[] = [];
    if (state.activeProfile === profile) flags_str.push(chalk.green('active'));
    if (state.runningProfile === profile) flags_str.push(chalk.green('● running'));
    info(`profile: ${chalk.cyan(profile)}${flags_str.length ? '  ' + flags_str.join(' · ') : ''}`);
    info(`config path: ${chalk.cyan(pp.config)}`);
    info(`server port: ${chalk.cyan(String(cfg.server_port))}  ·  default model: ${chalk.cyan(cfg.default_model)}  ·  reasoning effort: ${chalk.cyan(cfg.default_reasoning_effort)}`);

    const provTable = makeTable(['provider', 'type', 'base_url']);
    for (const [id, p] of Object.entries(cfg.providers ?? {})) provTable.push([id, p.type, p.base_url]);
    print();
    print(chalk.bold('providers'));
    print(renderTable(provTable));

    const mTable = makeTable(['model', 'endpoints', 'param_size', 'reasoning_family']);
    for (const [id, m] of Object.entries(cfg.model_config ?? {})) {
      mTable.push([id + (id === cfg.default_model ? chalk.green(' (default)') : ''), (m.preferred_endpoints ?? []).join(','), m.param_size ?? '-', m.reasoning_family ?? '-']);
    }
    print();
    print(chalk.bold('models'));
    print(renderTable(mTable));

    const srTable = makeTable(['skill model', 'vector', 'reasoning']);
    for (const m of cfg.skill_router?.models ?? []) {
      srTable.push([
        m.model,
        m.skill_vector.map((v: number) => v.toFixed(3)).join(','),
        m.use_reasoning ? `on (${m.reasoning_effort ?? 'medium'})` : '-',
      ]);
    }
    print();
    print(chalk.bold('skill router'));
    print(renderTable(srTable));

    const features: string[] = [];
    features.push(`skill_router: ${cfg.skill_router?.enabled ? chalk.green('on') : chalk.dim('off')}` + (cfg.skill_router?.enabled ? ` (${cfg.skill_router.models.length} models · ${cfg.skill_router.capabilities.length}D)` : ''));
    const complexityEndpoint = cfg.complexity_service?.base_url ?? (cfg.complexity_service?.address ? `${cfg.complexity_service.address}:${cfg.complexity_service.port ?? 8094}` : '');
    const complexityMode = cfg.complexity_service?.protocol === 'openai' ? 'remote openai' : 'local';
    features.push(`complexity_service: ${cfg.complexity_service?.enabled ? chalk.green('on') : chalk.dim('off')}` + (cfg.complexity_service?.enabled ? ` (${complexityMode} · ${complexityEndpoint})` : ''));
    features.push(`brick multimodal: ${cfg.brick?.enabled ? chalk.green('on') : chalk.dim('off')}` + (cfg.brick?.enabled ? ` (STT=${cfg.brick.stt_model} OCR=${cfg.brick.ocr_model} Vision=${cfg.brick.vision_model})` : ''));
    if (cfg.plugins) {
      const enabled = Object.entries(cfg.plugins).filter(([, v]: any) => v?.enabled).map(([k]) => k);
      features.push(`plugins: ${enabled.length ? chalk.green(enabled.join(', ')) : chalk.dim('none')}`);
    }
    features.push(`keyword_rules: ${cfg.skill_router?.keyword_rules.length ?? 0}  ·  legacy decisions: ${cfg.decisions.length}  ·  models: ${Object.keys(cfg.model_config).length}`);
    print();
    print(chalk.bold('features'));
    for (const f of features) print('  ' + f);

    print();
    info(`run \`brick config ${profile} edit\` to change values, or \`brick config ${profile} ai\` for guided edits.`);
  }
}
