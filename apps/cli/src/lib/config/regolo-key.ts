// Shared "ensure a Regolo API key exists before starting the router" flow,
// used by both `brick claude on` and `brick codex on`. When the profile's
// complexity classifier points at the hosted Regolo endpoint (the default),
// a REGOLO_API_KEY must be present in the profile .env for the router to
// authenticate; this prompts for it (with a signup link) when missing.

import * as p from '@clack/prompts';
import { paths } from './paths.js';
import { loadConfigRaw } from './load.js';
import { readEnvValue, upsertEnvValues } from './env-file.js';
import {
  REGOLO_API_KEY_ENV,
  REGOLO_CLASSIFIER_URL,
  REGOLO_API_KEY_HELP,
} from '../claude/settings-apply.js';
import { info, ok, warn } from '../ui/banners.js';

/**
 * Ensure a REGOLO_API_KEY is present when the profile uses the hosted Regolo
 * classifier. Prompts for it (interactive TTY only) when missing; a blank
 * answer is allowed (the router falls back to "medium" until a key is set).
 * Never throws: a non-Regolo/local classifier, an unreadable config, or an
 * already-present key are all silent no-ops.
 *
 * `announce` (an optional intro line) is printed once before prompting on a
 * freshly-created profile, so first-run users understand why they are asked.
 */
export async function ensureRegoloClassifierKey(profile: string, announce?: string): Promise<void> {
  let usesRegoloClassifier = false;
  try {
    const raw = (await loadConfigRaw(profile)) as any;
    const csUrl: string = raw?.complexity_service?.base_url ?? '';
    const cmUrl: string = raw?.skill_router?.complexity_model?.base_url ?? '';
    usesRegoloClassifier =
      csUrl.startsWith(REGOLO_CLASSIFIER_URL) || cmUrl.startsWith(REGOLO_CLASSIFIER_URL);
  } catch {
    return; // can't read config: don't block startup
  }
  if (!usesRegoloClassifier) return;

  const pp = paths(profile);
  const existing = (await readEnvValue(pp.env, REGOLO_API_KEY_ENV)) ?? process.env[REGOLO_API_KEY_ENV] ?? '';
  if (existing.trim() !== '') return; // already have a key

  // Non-interactive (piped/CI): warn instead of hanging on a prompt.
  if (!process.stdin.isTTY) {
    warn(`${REGOLO_API_KEY_ENV} is not set; the hosted classifier falls back to "medium" until you set it.`);
    return;
  }

  if (announce) info(announce);
  p.note(REGOLO_API_KEY_HELP, 'Regolo API key');
  const token = await p.password({ message: 'Regolo API key (leave blank to skip for now)' });
  if (p.isCancel(token)) return;
  const key = String(token ?? '').trim();
  if (key === '') {
    warn(`No key entered; routing falls back to "medium" until you set one.`);
    return;
  }
  await upsertEnvValues(pp.env, { [REGOLO_API_KEY_ENV]: key });
  ok('Regolo API key saved to the profile .env.');
}
