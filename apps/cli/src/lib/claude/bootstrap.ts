import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { paths, profileExists, readState, updateState } from '../config/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, '..', '..', '..', 'templates');

export const DEFAULT_CLAUDE_PROFILE = 'claude';
export const DEFAULT_CLAUDE_PORT = 8000;

export async function ensureDefaultProfile(): Promise<string> {
  const profile = DEFAULT_CLAUDE_PROFILE;
  if (profileExists(profile)) return profile;

  const pp = paths(profile);
  mkdirSync(pp.profileDir, { recursive: true, mode: 0o700 });

  // 1. Config (verbatim copy — preserves anthropic_passthrough block).
  const configTemplate = readFileSync(join(TEMPLATE_DIR, 'claude-default.config.yaml'), 'utf8');
  writeFileSync(pp.config, configTemplate, { mode: 0o600 });

  // The classifier key is filled by the profile editor before first start.
  writeFileSync(pp.env, '# Regolo complexity classifier credential\nREGOLO_API_KEY=\n', { mode: 0o600 });


  if (!readState().activeProfile) updateState({ activeProfile: profile });

  return profile;
}
