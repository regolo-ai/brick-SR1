import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { paths, profileExists, readState, updateState } from '../config/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, '..', '..', '..', 'templates');

export const DEFAULT_OPENCODE_PROFILE = 'opencode';

// The reserved official profiles share the loopback port and run one at a time.
export const DEFAULT_OPENCODE_PORT = 8000;

/**
 * Create the reserved `opencode` profile from its template, mirroring the
 * Claude and Codex default profiles. `brick start opencode` calls this through
 * `ensureServing`, so the wiring step always finds a profile to attach to.
 */
export async function ensureDefaultOpencodeProfile(): Promise<string> {
  const profile = DEFAULT_OPENCODE_PROFILE;
  if (profileExists(profile)) return profile;

  const pp = paths(profile);
  mkdirSync(pp.profileDir, { recursive: true, mode: 0o700 });

  const configTemplate = readFileSync(join(TEMPLATE_DIR, 'opencode-default.config.yaml'), 'utf8');
  writeFileSync(pp.config, configTemplate, { mode: 0o600 });

  // Generation provider credentials are optional until those providers are selected.
  writeFileSync(pp.env, '# Generation provider credentials\nREGOLO_API_KEY=\n', { mode: 0o600 });

  if (!readState().activeProfile) updateState({ activeProfile: profile });

  return profile;
}
