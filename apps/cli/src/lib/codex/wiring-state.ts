import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { root } from '../config/paths.js';
import { MODES, type ClaudeMode } from '../claude/modes.js';
import type { ComputeMode } from '../claude/settings-apply.js';

export interface CodexWiringState {
  wired: boolean;
  baseUrl: string;
  /** Top-level `model` value in ~/.codex/config.toml before `on` ran (null = absent). */
  previousModel: string | null;
  /** Top-level `model_provider` value in ~/.codex/config.toml before `on` ran (null = absent). */
  previousModelProvider: string | null;
  /** Legacy top-level `profile` value, retained only for migration cleanup. */
  previousProfile?: string | null;
  /** true if `on` created ~/.codex/config.toml (so `off` can leave it minimal). */
  createdFile: boolean;
  /** Last mode selected via `brick codex <eco|lite|mid|pro|max>`. */
  mode?: ClaudeMode;
  computeMode?: ComputeMode;
  contextAwareness?: boolean;
  modelRouting?: boolean;
  thinkingRouting?: boolean;
  fixedModel?: string;
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
      const computeMode = parsed.computeMode === 'local' || parsed.computeMode === 'api'
        ? parsed.computeMode
        : undefined;
      return {
        wired: true,
        baseUrl: parsed.baseUrl,
        previousModel: typeof parsed.previousModel === 'string' ? parsed.previousModel : null,
        previousModelProvider: typeof parsed.previousModelProvider === 'string' ? parsed.previousModelProvider : null,
        previousProfile: typeof parsed.previousProfile === 'string' ? parsed.previousProfile : null,
        createdFile: parsed.createdFile === true,
        ...(mode ? { mode } : {}),
        ...(computeMode ? { computeMode } : {}),
        ...(typeof parsed.contextAwareness === 'boolean' ? { contextAwareness: parsed.contextAwareness } : {}),
        ...(typeof parsed.modelRouting === 'boolean' ? { modelRouting: parsed.modelRouting } : {}),
        ...(typeof parsed.thinkingRouting === 'boolean' ? { thinkingRouting: parsed.thinkingRouting } : {}),
        ...(typeof parsed.fixedModel === 'string' ? { fixedModel: parsed.fixedModel } : {}),
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
