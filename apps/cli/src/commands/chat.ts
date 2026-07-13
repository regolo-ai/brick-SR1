import { Command, Flags } from '@oclif/core';
import React from 'react';
import { render } from 'ink';
import { loadConfig } from '../lib/config/load.js';
import { paths, resolveProfile, readState } from '../lib/config/paths.js';
import type { ThinkingMode } from '../lib/client/openai.js';
import { App } from '../lib/chat-tui/App.js';
import { localBaseUrl } from '../lib/net/local.js';

export default class Chat extends Command {
  static description = 'Interactive chat (ink TUI: bottom input + scrolling history, Claude Code style)';
  static flags = {
    profile: Flags.string({ description: 'profile name (defaults to active profile)' }),
    model: Flags.string({ default: 'brick', description: 'virtual model name' }),
    system: Flags.string({ description: 'system prompt' }),
    'show-thinking': Flags.boolean({ default: false, description: 'show reasoning content from the start' }),
    'max-tokens': Flags.integer({ default: 4096, description: 'max tokens for response' }),
    thinking: Flags.string({ options: ['off', 'low', 'medium', 'high', 'auto'], description: 'force brick-thinking mode (off|low|medium|high|auto)' }),
  };
  async run(): Promise<void> {
    const { flags } = await this.parse(Chat);
    const profile = resolveProfile(flags.profile);
    const state = readState();
    if (!state.runningProfile) this.error(`no profile is running. Start one with \`brick serve ${profile}\``, { exit: 1 });
    if (state.runningProfile !== profile) this.warn(`requested profile '${profile}' but '${state.runningProfile}' is running — connecting to '${state.runningProfile}'.`);
    const target = state.runningProfile;
    const cfg = await loadConfig(target);
    const baseUrl = localBaseUrl(cfg.server_port);
    const initialThinking = (flags.thinking as ThinkingMode | undefined) ?? 'auto';

    if (!process.stdin.isTTY) {
      this.error('brick chat requires an interactive TTY. Use `brick generate "<prompt>"` for non-interactive use.', { exit: 2 });
    }

    const isTTY = process.stdout.isTTY;
    const exitAltScreen = () => { if (isTTY) process.stdout.write('\x1b[?1049l'); };
    if (isTTY) process.stdout.write('\x1b[?1049h');
    process.once('exit', exitAltScreen);

    try {
      const { waitUntilExit } = render(
        React.createElement(App, {
          baseUrl,
          model: flags.model,
          systemPrompt: flags.system,
          maxTokens: flags['max-tokens'],
          initialThinking,
          initialShowThinking: flags['show-thinking'],
        })
      );
      await waitUntilExit();
    } finally {
      process.removeListener('exit', exitAltScreen);
      exitAltScreen();
    }
  }
}
