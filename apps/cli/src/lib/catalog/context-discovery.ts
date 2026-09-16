import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { paths } from '../config/paths.js';
import { loadConfigRaw } from '../config/load.js';
import { saveConfigText } from '../config/save.js';
import { ConfigSchema, type BrickConfig } from '../config/schema.js';
import { writeCodexModelCatalog } from '../codex/catalog.js';
import {
  assertVerifiedContextWindows,
  resolveContextWindows,
  writeContextDiscoverySnapshot,
  type ContextDiscoveryOptions,
  type ContextWindowResolution,
} from './context-windows.js';

async function profileEnvironment(profile: string): Promise<Record<string, string | undefined>> {
  const values: Record<string, string | undefined> = { ...process.env };
  try {
    const text = await readFile(paths(profile).env, 'utf8');
    for (const line of text.split('\n')) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match) values[match[1]] = match[2].trim();
    }
  } catch { /* profiles may legitimately have no credential file */ }
  return values;
}

export async function discoverAndApplyContextWindows(
  profile: string,
  config?: BrickConfig,
  options: ContextDiscoveryOptions = {},
): Promise<{ config: BrickConfig; results: ContextWindowResolution[]; changed: boolean }> {
  const raw = await loadConfigRaw(profile) as any;
  const cfg = config ?? ConfigSchema.parse(raw);
  const env = options.env ?? await profileEnvironment(profile);
  const results = await resolveContextWindows(cfg, { ...options, env });
  await writeContextDiscoverySnapshot(profile, results, options.cacheDir);
  assertVerifiedContextWindows(results);

  let changed = false;
  for (const result of results) {
    const entry = cfg.model_config[result.model];
    if (!entry || !result.maxInputTokens) continue;
    if (entry.context_window_size !== result.maxInputTokens) {
      entry.context_window_size = result.maxInputTokens;
      if (raw?.model_config?.[result.model]) raw.model_config[result.model].context_window_size = result.maxInputTokens;
      changed = true;
    }
  }
  if (changed) await saveConfigText(yaml.dump(raw, { lineWidth: 120, noRefs: true, sortKeys: false }), profile);
  if (cfg.codex_router?.enabled) await writeCodexModelCatalog(profile, undefined, cfg);
  return { config: cfg, results, changed };
}
