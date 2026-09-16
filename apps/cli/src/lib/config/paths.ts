import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';

const ROOT = resolve(process.env.BRICK_HOME ?? join(homedir(), '.brick'));

export interface ProfilePaths {
  root: string;
  profile: string;
  profileDir: string;
  config: string;
  env: string;
  codexCatalog: string;
  codexBridgePid: string;
  state: string;
  runtime: string;
  harness: string;
}

export interface State {
  activeProfile: string | null;
  runningProfile: string | null;
}

const DEFAULT_STATE: State = { activeProfile: null, runningProfile: null };

export function root(): string { return ROOT; }
export function profilesDir(): string { return join(ROOT, 'profiles'); }
export function statePath(): string { return join(ROOT, 'state.json'); }

export function paths(profile: string): ProfilePaths {
  validateProfileName(profile, { allowReserved: true });
  const dir = join(ROOT, 'profiles', profile);
  return {
    root: ROOT,
    profile,
    profileDir: dir,
    config: join(dir, 'config.yaml'),
    env: join(dir, '.env'),
    codexCatalog: join(dir, 'codex-model-catalog.json'),
    codexBridgePid: join(dir, 'codex-flat-bridge.pid'),
    state: statePath(),
    runtime: join(dir, 'runtime'),
    harness: join(dir, 'runtime', 'harness.json'),
  };
}

export function listProfiles(): string[] {
  try {
    return readdirSync(profilesDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && PROFILE_NAME_RE.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export function profileExists(name: string): boolean {
  try {
    const s = statSync(paths(name).config);
    return s.isFile();
  } catch {
    return false;
  }
}

export const RESERVED_PROFILES = new Set(['claude', 'codex']);
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateProfileName(name: string, options: { allowReserved?: boolean } = {}): string {
  if (!PROFILE_NAME_RE.test(name)) throw new Error(`invalid profile name '${name}' (use 1–64 lowercase letters, digits, - or _)`);
  if (!options.allowReserved && RESERVED_PROFILES.has(name)) throw new Error(`'${name}' is reserved for the official Brick harness and cannot be managed as a custom profile`);
  return name;
}

export function readState(): State {
  try {
    const raw = readFileSync(statePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      activeProfile: typeof parsed.activeProfile === 'string' ? parsed.activeProfile : null,
      runningProfile: typeof parsed.runningProfile === 'string' ? parsed.runningProfile : null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeState(s: State): void {
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  writeFileSync(statePath(), JSON.stringify(s, null, 2), { mode: 0o600 });
}

export function updateState(patch: Partial<State>): State {
  const next = { ...readState(), ...patch };
  writeState(next);
  return next;
}

/**
 * Resolve a profile. 3.0 deliberately has no active profile fallback: callers
 * must name the resource explicitly, except for the running-profile helper.
 */
export function resolveProfile(explicit?: string): string {
  const candidate = explicit;
  if (!candidate) {
    const profs = listProfiles();
    if (profs.length === 0) {
      throw new Error('no profiles found. Run `brick profile create <name>` to create one.');
    }
    throw new Error(`a profile is required. Available: ${profs.join(', ')}`);
  }
  if (!profileExists(candidate)) {
    throw new Error(`profile '${candidate}' not found. Run \`brick profile list\` to see available profiles.`);
  }
  return candidate;
}

/** Path to legacy single-config layout (pre multi-profile). */
export const LEGACY = {
  config: join(ROOT, 'config.yaml'),
  env: join(ROOT, '.env'),
};
