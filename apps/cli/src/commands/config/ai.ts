import { Args, Command, Flags } from '@oclif/core';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { render } from 'ink';
import { paths, resolveProfile, readState } from '../../lib/config/paths.js';
import { loadConfig } from '../../lib/config/load.js';
import { AgentApp } from '../../lib/config-ai/AgentApp.js';
import { err } from '../../lib/ui/banners.js';
import { localBaseUrl } from '../../lib/net/local.js';

// chatCompletion() appends "/v1/chat/completions"; keep this URL without /v1.
const REGOLO_BASE_URL = 'https://api.regolo.ai';
const REGOLO_FALLBACK_MODEL = 'qwen3.5-122b';

export default class ConfigAi extends Command {
  static description = 'Open an AI agent that edits the profile’s config.yaml via chat';
  static args = {
    profile: Args.string({ required: false, description: 'profile name (defaults to active)' }),
  };
  static flags = {
    'fallback-model': Flags.string({ default: REGOLO_FALLBACK_MODEL, description: 'model used when no profile is running and we fall back to Regolo direct' }),
    'max-tokens': Flags.integer({ default: 2048 }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ConfigAi);

    if (!process.stdin.isTTY) {
      this.error('brick config <name> ai requires an interactive TTY.', { exit: 2 });
    }

    let profile: string;
    try { profile = resolveProfile(args.profile); }
    catch (e: any) { err(e?.message ?? String(e)); this.exit(1); }

    const pp = paths(profile);
    try { await loadConfig(profile); }
    catch (e: any) { err(`cannot load config for '${profile}': ${e?.message ?? e}`); this.exit(1); }

    const state = readState();
    let baseUrl: string;
    let model: string;
    let backendLabel: string;
    let apiKey: string | undefined;

    if (state.runningProfile) {
      const runningCfg = await loadConfig(state.runningProfile);
      baseUrl = localBaseUrl(runningCfg.server_port);
      model = 'brick';
      backendLabel = `brick @ ${state.runningProfile}`;
    } else {
      apiKey = await readEnvKey(pp.env, 'REGOLO_API_KEY');
      if (!apiKey) {
        err(`no profile running and no REGOLO_API_KEY in ${pp.env}. Either run \`brick serve <name>\` first or set the key.`);
        this.exit(1);
      }
      baseUrl = REGOLO_BASE_URL;
      model = flags['fallback-model'];
      backendLabel = `regolo direct (${model})`;
    }

    const { waitUntilExit } = render(
      React.createElement(AgentApp, {
        profile,
        baseUrl,
        model,
        apiKey,
        configPath: pp.config,
        backendLabel,
        maxTokens: flags['max-tokens'],
      })
    );
    await waitUntilExit();
  }
}

async function readEnvKey(envPath: string, key: string): Promise<string | undefined> {
  try {
    const txt = await readFile(envPath, 'utf8');
    const m = txt.match(new RegExp(`^${key}=(.+)$`, 'm'));
    return m ? m[1].trim() : undefined;
  } catch {
    return process.env[key] ?? undefined;
  }
}
