import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { paths } from '../config/paths.js';
import type { OpencodeModel } from './wiring.js';

export interface OpencodeWiringState {
  wired: boolean;
  baseUrl: string;
  /** Model catalog written into `provider.brick.models`. */
  models: OpencodeModel[];
  /** true if wiring created the OpenCode config (so unwiring can drop it). */
  createdFile: boolean;
  /** true if the OpenCode config already had a top-level `provider` object. */
  providerExisted: boolean;
}

function wiringPath(): string {
  return paths('opencode').harness;
}

export function readOpencodeWiring(): OpencodeWiringState | null {
  const path = wiringPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && parsed.wired === true && typeof parsed.baseUrl === 'string') {
      return {
        wired: true,
        baseUrl: parsed.baseUrl,
        models: Array.isArray(parsed.models)
          ? parsed.models.filter((m: any) => m && typeof m.id === 'string').map((m: any) => ({ id: m.id, ...(typeof m.label === 'string' ? { label: m.label } : {}) }))
          : [],
        createdFile: parsed.createdFile === true,
        providerExisted: parsed.providerExisted === true,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeOpencodeWiring(state: OpencodeWiringState): void {
  const dir = paths('opencode').runtime;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(wiringPath(), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function clearOpencodeWiring(): void {
  const path = wiringPath();
  if (existsSync(path)) rmSync(path);
}
