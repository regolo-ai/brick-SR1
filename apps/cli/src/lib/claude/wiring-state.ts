import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { paths, root } from '../config/paths.js';
import { MODES, type ClaudeMode } from './modes.js';

export interface WiringState {
  wired: boolean;
  baseUrl: string;
  /** env.ANTHROPIC_BASE_URL before `on` ran; null means the key was absent. */
  previousBaseUrl: string | null;
  /** true if `on` created the settings.json `env` block (so `off` removes it when empty). */
  createdEnvBlock: boolean;
  /** Last mode the user selected via the profile editor. Optional for backward compat. */
  mode?: ClaudeMode;
  /** Whether context-awareness (classify on last-K-turns window) is enabled. Optional for backward compat. */
  contextAwareness?: boolean;
  /** The complexity classifier uses a configured API endpoint. */
  computeMode?: 'api';
  /** Whether native-model subagent traffic is routed through Brick. Optional for backward compat. */
  routeSubagents?: boolean;
  /** Whether dynamic model routing is on. When false, traffic is pinned to fixedModel. Optional for backward compat. */
  modelRouting?: boolean;
  /** Whether autonomous thinking-effort routing is on. Optional for backward compat. */
  thinkingRouting?: boolean;
  /** Model pinned when modelRouting is off (e.g. "claude-opus-4-8"). Optional. */
  fixedModel?: string;
  /** Cache-aware routing mode: 'off' (default), 'sticky', 'smartsqueeze', or 'orchestrator'. Optional. */
  routingMode?: 'off' | 'sticky' | 'smartsqueeze' | 'orchestrator';
}

function wiringPath(): string {
  const target = paths('claude').harness;
  const legacy = join(root(), 'claude-wiring.json');
  if (!existsSync(target) && existsSync(legacy)) { mkdirSync(paths('claude').runtime, { recursive: true, mode: 0o700 }); try { writeFileSync(target, readFileSync(legacy), { mode: 0o600 }); rmSync(legacy); } catch {} }
  return target;
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
      const computeMode = parsed.computeMode === 'api'
        ? (parsed.computeMode as 'api')
        : undefined;
      return {
        wired: true,
        baseUrl: parsed.baseUrl,
        previousBaseUrl: typeof parsed.previousBaseUrl === 'string' ? parsed.previousBaseUrl : null,
        createdEnvBlock: parsed.createdEnvBlock === true,
        ...(mode ? { mode } : {}),
        ...(typeof parsed.contextAwareness === 'boolean' ? { contextAwareness: parsed.contextAwareness } : {}),
        ...(computeMode ? { computeMode } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeWiring(state: WiringState): void {
  const dir = paths('claude').runtime;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(wiringPath(), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function clearWiring(): void {
  const path = wiringPath();
  if (existsSync(path)) rmSync(path);
}
