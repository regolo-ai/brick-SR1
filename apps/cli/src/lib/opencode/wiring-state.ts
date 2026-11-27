import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';

/**
 * Wiring state for the `opencode` official harness profile.
 *
 * It lives next to the other harness state (`<brick home>/profiles/opencode/runtime/harness.json`)
 * and records the exact values that `brick start opencode` replaced, so `brick stop opencode`
 * can put them back. The brick home is resolved on every call (not at import time) so tests can
 * point `BRICK_HOME`/`HOME` at a scratch directory.
 */
export interface OpencodeWiringState {
  wired: boolean;
  /** Router root the managed provider points at, e.g. `http://127.0.0.1:8000`. */
  baseUrl: string;
  /** `~/.config/opencode/opencode.json` that was written. */
  configPath: string;
  /**
   * Raw JSONC text of the `provider` value before wiring (null when the key was absent).
   * Restoring this verbatim is what makes `disconnect` exact.
   */
  previousProviderRaw: string | null;
  /** true when `wire` created opencode.json, so `unwire` may remove it again. */
  createdFile: boolean;
  /** Model ids written under `provider.brick.models` (catalog + `brick`). */
  models: string[];
}

export function brickHome(): string {
  return process.env.BRICK_HOME?.trim() || join(homedir(), '.brick');
}

export function opencodeWiringPath(): string {
  return join(brickHome(), 'profiles', 'opencode', 'runtime', 'harness.json');
}

export function readOpencodeWiring(): OpencodeWiringState | null {
  const path = opencodeWiringPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || parsed.wired !== true || typeof parsed.baseUrl !== 'string') return null;
    return {
      wired: true,
      baseUrl: parsed.baseUrl,
      configPath: typeof parsed.configPath === 'string' ? parsed.configPath : '',
      previousProviderRaw: typeof parsed.previousProviderRaw === 'string' ? parsed.previousProviderRaw : null,
      createdFile: parsed.createdFile === true,
      models: Array.isArray(parsed.models) ? parsed.models.filter((m: unknown): m is string => typeof m === 'string') : [],
    };
  } catch {
    return null;
  }
}

export function writeOpencodeWiring(state: OpencodeWiringState): void {
  const path = opencodeWiringPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function clearOpencodeWiring(): void {
  const path = opencodeWiringPath();
  if (existsSync(path)) rmSync(path);
}
