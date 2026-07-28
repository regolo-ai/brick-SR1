import { load as parseYaml, dump as dumpYaml } from 'js-yaml';
import { loadConfigText } from '../config/load.js';
import { saveConfigText } from '../config/save.js';

export interface EnsureAnthropicPassthroughResult {
  changed: boolean;
  created: boolean;
}

/**
 * Ensure a Claude profile contains the Anthropic pass-through contract required
 * by Claude Code. Existing user values are preserved; only missing/default
 * transport fields are added.
 */
export async function ensureAnthropicPassthrough(profile: string): Promise<EnsureAnthropicPassthroughResult> {
  const source = await loadConfigText(profile);
  const config: any = parseYaml(source) ?? {};
  const before = JSON.stringify(config.anthropic_passthrough ?? null);
  const existing = config.anthropic_passthrough;

  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    config.anthropic_passthrough = {
      enabled: true,
      use_skill_router: true,
      upstream_url: 'https://api.anthropic.com',
      extra_usage_enabled: false,
      context_1m_threshold_bytes: 600000,
      model_map: {
        easy: 'claude-haiku-4-5',
        medium: 'claude-sonnet-4-6',
        hard: 'claude-opus-4-8',
      },
      model_map_1m: {
        easy: 'claude-sonnet-4-6',
        medium: 'claude-sonnet-4-6',
        hard: 'claude-opus-4-8',
      },
    };
  } else {
    existing.enabled = true;
    if (existing.use_skill_router === undefined) existing.use_skill_router = true;
    if (existing.upstream_url === undefined) existing.upstream_url = 'https://api.anthropic.com';
  }

  const after = JSON.stringify(config.anthropic_passthrough);
  if (before === after) return { changed: false, created: false };
  await saveConfigText(dumpYaml(config, { lineWidth: 120, noRefs: true, sortKeys: false }), profile);
  return { changed: true, created: !existing || typeof existing !== 'object' || Array.isArray(existing) };
}
