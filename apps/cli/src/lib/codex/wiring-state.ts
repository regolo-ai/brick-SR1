import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { root } from '../config/paths.js';
import { MODES, type ClaudeMode } from '../claude/modes.js';

export interface CodexWiringState {
  wired: boolean;
  baseUrl: string;
  /** Top-level `profile` value in ~/.codex/config.toml before `on` ran (null = absent). */
  previousProfile: string | null;
  /** true if `on` created ~/.codex/config.toml (so `off` can leave it minimal). */
  createdFile: boolean;
  /** Last mode selected via `brick codex <eco|lite|mid|pro|max>`. */
  mode?: ClaudeMode;
}

function wiringPath(): string {
  return join(root(), 'codex-wiring.json');
}

export function readCodexWiring(): CodexWiringState | null {
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
        previousProfile: typeof parsed.previousProfile === 'string' ? parsed.previousProfile : null,
        createdFile: parsed.createdFile === true,
        ...(mode ? { mode } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeCodexWiring(state: CodexWiringState): void {
  const dir = root();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(wiringPath(), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function clearCodexWiring(): void {
  const path = wiringPath();
  if (existsSync(path)) rmSync(path);
}
