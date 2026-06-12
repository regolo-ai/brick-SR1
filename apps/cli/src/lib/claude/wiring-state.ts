import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { root } from '../config/paths.js';
import { MODES, type ClaudeMode } from './modes.js';

export interface WiringState {
  wired: boolean;
  baseUrl: string;
  /** env.ANTHROPIC_BASE_URL before `on` ran; null means the key was absent. */
  previousBaseUrl: string | null;
  /** true if `on` created the settings.json `env` block (so `off` removes it when empty). */
  createdEnvBlock: boolean;
  /** Last mode the user selected via `brick claude <eco|lite|mid|pro|max>`. Optional for backward compat. */
  mode?: ClaudeMode;
}

function wiringPath(): string {
  return join(root(), 'claude-wiring.json');
}

export function readWiring(): WiringState | null {
  const path = wiringPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && parsed.wired === true && typeof parsed.baseUrl === 'string') {
      const mode = typeof parsed.mode === 'string' && (MODES as readonly string[]).includes(parsed.mode)
        ? (parsed.mode as ClaudeMode)
        : undefined;
      return {
        wired: true,
        baseUrl: parsed.baseUrl,
        previousBaseUrl: typeof parsed.previousBaseUrl === 'string' ? parsed.previousBaseUrl : null,
        createdEnvBlock: parsed.createdEnvBlock === true,
        ...(mode ? { mode } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeWiring(state: WiringState): void {
  const dir = root();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(wiringPath(), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function clearWiring(): void {
  const path = wiringPath();
  if (existsSync(path)) rmSync(path);
}
