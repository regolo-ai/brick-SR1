import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';

const ENV_KEY = 'ANTHROPIC_BASE_URL';

// Custom model option env vars: make Brick appear as a selectable entry at the
// bottom of Claude Code's `/model` picker, alongside the built-in opus/sonnet/
// haiku aliases (which it does NOT replace). The _SUPPORTED_CAPABILITIES var is
// essential: the "brick-claude" id does not match Claude Code's known model
// patterns, so without it the effort slider would be hidden — and the effort
// level IS the Brick routing-mode control (low=eco … max=max).
const CUSTOM_MODEL_ENV: Record<string, string> = {
  ANTHROPIC_CUSTOM_MODEL_OPTION: 'brick-claude',
  ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'Brick (auto-routing)',
  ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION:
    'Effort sets routing mode: low eco, medium lite, high mid, xhigh pro, max max',
  ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES:
    'effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking',
};

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
 * Whether the Brick custom-model-option env vars are present in settings.json.
 * Used by `claude on` to detect a wiring written before this feature existed,
 * so it re-runs setBaseUrl to add the picker entry instead of short-circuiting.
 */
export function hasBrickModelOption(): boolean {
  const env = readSettings().env;
  if (!env || typeof env !== 'object') return false;
  return env.ANTHROPIC_CUSTOM_MODEL_OPTION === CUSTOM_MODEL_ENV.ANTHROPIC_CUSTOM_MODEL_OPTION;
}

/**
 * Set env.ANTHROPIC_BASE_URL plus the Brick custom-model-option env vars,
 * preserving every other key. The custom-model vars register "brick-claude" in
 * the `/model` picker with the effort slider enabled.
 * Returns whether we had to create the `env` block (so `off` can clean it up).
 */
export function setBaseUrl(url: string): { createdEnvBlock: boolean } {
  const settings = readSettings();
  const createdEnvBlock = !settings.env || typeof settings.env !== 'object';
  if (createdEnvBlock) settings.env = {};
  settings.env[ENV_KEY] = url;
  for (const [k, v] of Object.entries(CUSTOM_MODEL_ENV)) {
    settings.env[k] = v;
  }
  writeSettings(settings);
  return { createdEnvBlock };
}

/**
 * Restore the previous base URL (or delete the key when there was none) and
 * remove the Brick custom-model-option env vars we added in `setBaseUrl`.
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
  // Always strip the custom-model vars Brick added.
  for (const k of Object.keys(CUSTOM_MODEL_ENV)) {
    delete settings.env[k];
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
