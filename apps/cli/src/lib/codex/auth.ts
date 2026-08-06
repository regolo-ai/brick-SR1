import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexHome } from './config-toml.js';

/**
 * Return Codex's cached authentication mode without reading or exposing any
 * credential values. Unknown or older auth-file formats are treated as absent
 * so Codex itself can surface the relevant login error.
 */
export function readCodexAuthMode(): string | null {
  const path = join(codexHome(), 'auth.json');
  if (!existsSync(path)) return null;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { auth_mode?: unknown };
    return typeof parsed.auth_mode === 'string' ? parsed.auth_mode : null;
  } catch {
    return null;
  }
}

export function usesChatGPTSubscriptionAuth(): boolean {
  return readCodexAuthMode() === 'chatgpt';
}
