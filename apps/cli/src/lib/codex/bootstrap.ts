import { nativeCodexTransport, ensureCodexLocalKey, addOfficialCodexModels } from './native-transport.js';
import yaml from 'js-yaml';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { paths, profileExists, readState, updateState } from '../config/paths.js';
import { migrateCodexProfile } from './migrate.js';
import { readAuthenticatedCodexCatalog } from './catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, '..', '..', '..', 'templates');

export const DEFAULT_CODEX_PROFILE = 'codex';

// Default profiles share the loopback port and run one at a time.
export const DEFAULT_CODEX_PORT = 8000;

/** Create the Codex profile with hosted complexity and native transports. */
export async function ensureDefaultCodexProfile(): Promise<string> {
  const profile = DEFAULT_CODEX_PROFILE;
  if (profileExists(profile)) {
    await migrateCodexProfile(profile);
    return profile;
  }

  const pp = paths(profile);
  mkdirSync(pp.profileDir, { recursive: true, mode: 0o700 });

  // 1. Config (verbatim copy — preserves the skill_router + dynamic_effort block).
  const configTemplate = readFileSync(join(TEMPLATE_DIR, 'codex-default.config.yaml'), 'utf8');
  writeFileSync(pp.config, yaml.dump(nativeCodexTransport(yaml.load(configTemplate))), { mode: 0o600 });

  // The classifier key is filled by the profile editor before first start.
  writeFileSync(pp.env, '# Regolo complexity classifier credential\nREGOLO_API_KEY=\n', { mode: 0o600 });

  await ensureCodexLocalKey(profile);

  const cfg = yaml.load(readFileSync(pp.config, 'utf8')) as any;
  addOfficialCodexModels(cfg, await readAuthenticatedCodexCatalog());
  writeFileSync(pp.config, yaml.dump(cfg), { mode: 0o600 });

  if (!readState().activeProfile) updateState({ activeProfile: profile });

  return profile;
}
