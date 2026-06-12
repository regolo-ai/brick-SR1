import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';

const ENV_KEY = 'ANTHROPIC_BASE_URL';

/** Claude Code honors CLAUDE_CONFIG_DIR; default is ~/.claude. */
export function settingsDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
}

export function settingsPath(): string {
  return join(settingsDir(), 'settings.json');
}

type Settings = Record<string, any>;

/**
 * Read ~/.claude/settings.json. Missing file → {}.
 * Malformed JSON → throw (never clobber a file we cannot understand).
 */
export function readSettings(): Settings {
  const path = settingsPath();
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Settings;
    throw new Error('not a JSON object');
  } catch (e: any) {
    throw new Error(`${path} is not valid JSON (${e?.message ?? e}). Refusing to modify it; fix it by hand first.`);
  }
}

/** Atomic write: temp file in the same dir + rename. 2-space JSON, trailing newline. */
function writeSettings(settings: Settings): void {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.brick.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o644 });
  renameSync(tmp, path);
}

export function getBaseUrl(): string | undefined {
  const env = readSettings().env;
  const v = env && typeof env === 'object' ? env[ENV_KEY] : undefined;
  return typeof v === 'string' ? v : undefined;
}

/**
 * Set env.ANTHROPIC_BASE_URL, preserving every other key.
 * Returns whether we had to create the `env` block (so `off` can clean it up).
 */
export function setBaseUrl(url: string): { createdEnvBlock: boolean } {
  const settings = readSettings();
  const createdEnvBlock = !settings.env || typeof settings.env !== 'object';
  if (createdEnvBlock) settings.env = {};
  settings.env[ENV_KEY] = url;
  writeSettings(settings);
  return { createdEnvBlock };
}

/**
 * Restore the previous value, or delete the key when there was none.
 * If `removeEmptyEnv` and the env block ends up empty, drop it entirely.
 */
export function restoreBaseUrl(previous: string | null, removeEmptyEnv: boolean): void {
  const settings = readSettings();
  if (!settings.env || typeof settings.env !== 'object') {
    if (previous !== null) {
      settings.env = { [ENV_KEY]: previous };
      writeSettings(settings);
    }
    return;
  }
  if (previous !== null) {
    settings.env[ENV_KEY] = previous;
  } else {
    delete settings.env[ENV_KEY];
  }
  if (removeEmptyEnv && Object.keys(settings.env).length === 0) {
    delete settings.env;
  }
  writeSettings(settings);
}
