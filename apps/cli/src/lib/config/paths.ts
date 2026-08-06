import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';

const ROOT = process.env.BRICK_HOME ?? join(homedir(), '.brick');

export interface ProfilePaths {
  root: string;
  profile: string;
  profileDir: string;
  config: string;
  compose: string;
  env: string;
  models: string;
  codexCatalog: string;
  state: string;
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
  const dir = join(ROOT, 'profiles', profile);
  return {
    root: ROOT,
    profile,
    profileDir: dir,
    config: join(dir, 'config.yaml'),
    compose: join(dir, 'docker-compose.yml'),
    env: join(dir, '.env'),
    models: join(dir, 'models'),
    codexCatalog: join(dir, 'codex-model-catalog.json'),
    state: statePath(),
  };
}

export function listProfiles(): string[] {
  try {
    return readdirSync(profilesDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
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
 * Resolve which profile to use for a command.
 * Order: explicit arg → BRICK_PROFILE env → state.activeProfile → throw with guidance.
 */
export function resolveProfile(explicit?: string): string {
  const candidate = explicit ?? process.env.BRICK_PROFILE ?? readState().activeProfile;
  if (!candidate) {
    const profs = listProfiles();
    if (profs.length === 0) {
      throw new Error('no profiles found. Run `brick config new <name>` (or `brick init`) to create one.');
    }
    throw new Error(`no active profile. Run \`brick config use <name>\` or pass --profile. Available: ${profs.join(', ')}`);
  }
  if (!profileExists(candidate)) {
    throw new Error(`profile '${candidate}' not found. Run \`brick config list\` to see available profiles.`);
  }
  return candidate;
}

/** Path to legacy single-config layout (pre multi-profile). */
export const LEGACY = {
  config: join(ROOT, 'config.yaml'),
  compose: join(ROOT, 'docker-compose.yml'),
  env: join(ROOT, '.env'),
  models: join(ROOT, 'models'),
};
