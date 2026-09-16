import { randomBytes } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { paths } from '../config/paths.js';
import { readEnvValue, upsertEnvValues } from '../config/env-file.js';

export const CODEX_UPSTREAM = 'https://chatgpt.com/backend-api/codex';
const LEGACY = new Set(['http://host.docker.internal:18080/v1', 'https://api.openai.com/v1']);
export const CODEX_CAPABILITIES = ['function_tools', 'custom_tools', 'opaque_reasoning', 'images', 'audio', 'files', 'compaction', 'item:tool_search', 'item:web_search', 'item:additional_tools', 'item:namespace'];

/** Migrate a copy: conflicts leave the original configuration untouched. */
export function nativeCodexTransport(source: any): any {
  const cfg = structuredClone(source);
  cfg.codex_router = { ...cfg.codex_router, enabled: true, local_key_env: 'BRICK_CODEX_LOCAL_KEY' };
  cfg.provider_profiles ??= {};
  cfg.provider_profiles['openai-codex'] ??= { type: 'openai_compatible', base_url: CODEX_UPSTREAM };
  cfg.provider_endpoints ??= [];
  if (!cfg.provider_endpoints.some((e: any) => e.provider_profile === 'openai-codex')) {
    if (cfg.provider_endpoints.some((e: any) => e.name === 'openai-codex')) throw new Error('Conflicting openai-codex endpoint name.');
    cfg.provider_endpoints.push({ name: 'openai-codex', provider_profile: 'openai-codex', weight: 1 });
  }
  for (const [id, p] of Object.entries(cfg.provider_profiles) as Array<[string, any]>) {
    const oldUrl = p.base_url?.replace(/\/+$/, '');
    if (id === 'openai-codex') {
      if (!LEGACY.has(oldUrl) && oldUrl !== CODEX_UPSTREAM) throw new Error(`Conflicting openai-codex endpoint: configure subscription access explicitly.`);
      if ((p.protocol && p.protocol !== 'responses') || (p.auth_source && p.auth_source !== 'codex_request') || (p.api_key_env && p.api_key_env !== 'CODEX_FLAT_BRIDGE_TOKEN')) {
        throw new Error('Conflicting openai-codex protocol or authentication source. Use a separate profile for OpenAI API billing.');
      }
      Object.assign(p, { base_url: CODEX_UPSTREAM, protocol: 'responses', auth_source: 'codex_request' });
      p.responses_path ??= 'responses';
      p.capabilities ??= CODEX_CAPABILITIES;
			if (p.capabilities.includes('multimodal')) {
				p.capabilities = [...new Set(p.capabilities.filter((value: string) => value !== 'multimodal').concat(['images', 'audio', 'files']))];
			}
      delete p.api_key_env;
      if (cfg.providers?.[id] && [oldUrl, CODEX_UPSTREAM].includes(cfg.providers[id].base_url?.replace(/\/+$/, ''))) cfg.providers[id].base_url = CODEX_UPSTREAM;
    } else {
      p.protocol ??= 'chat_completions';
      p.auth_source ??= 'provider_env';
      if (id === 'regolo') p.capabilities ??= ['function_tools'];
      p.api_key_env ??= `${id.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_API_KEY`;
    }
    for (const model of cfg.skill_router?.models ?? []) {
      const endpoints = cfg.model_config?.[model.model]?.preferred_endpoints ?? [];
      if (endpoints.length !== 1) throw new Error(`Model ${model.model} needs exactly one authoritative endpoint.`);
      const endpoint = cfg.provider_endpoints?.find((e: any) => e.name === endpoints[0]);
      if (endpoint?.provider_profile !== id) continue;
      if (model.base_url && ![oldUrl, p.base_url].includes(model.base_url.replace(/\/+$/, ''))) throw new Error(`Model ${model.model} has a conflicting inline endpoint.`);
      const legacyKey = id === 'openai-codex' && model.api_key_env === 'CODEX_FLAT_BRIDGE_TOKEN';
      if (model.api_key || model.api_key_file || (model.api_key_env && !legacyKey && model.api_key_env !== p.api_key_env)) throw new Error(`Model ${model.model} has conflicting inline credentials.`);
      delete model.base_url;
      delete model.api_key_env;
    }
  }
  return cfg;
}

export async function ensureCodexLocalKey(profile: string): Promise<string> {
  const env = paths(profile).env;
  let key = await readEnvValue(env, 'BRICK_CODEX_LOCAL_KEY');
  if (!key?.trim()) {
    key = randomBytes(32).toString('hex');
    await upsertEnvValues(env, { BRICK_CODEX_LOCAL_KEY: key });
  }
  await chmod(env, 0o600);
  return key.trim();
}

/** Official catalog entries remain manually selectable without joining the routing pool. */
export function addOfficialCodexModels(cfg: any, catalog: { models: Array<{ slug: string; context_window?: number; supported_reasoning_levels?: Array<{ effort: string }> }> }): void {
  const endpoint = cfg.provider_endpoints?.find((e: any) => e.provider_profile === 'openai-codex');
  if (!endpoint) throw new Error('The Codex profile requires an openai-codex endpoint for official model selection.');
  cfg.model_config ??= {};
  for (const model of catalog.models) {
    const percent = Number((model as any).effective_context_window_percent);
    const contextWindow = Number.isInteger(model.context_window) && model.context_window! > 0 && Number.isInteger(percent) && percent > 0 && percent <= 100
      ? Math.floor(model.context_window! * percent / 100)
      : undefined;
    if (model.slug && model.slug !== 'brick' && !cfg.model_config[model.slug]) {
      cfg.model_config[model.slug] = { preferred_endpoints: [endpoint.name], reasoning_family: 'openai_reasoning', ...(contextWindow ? { context_window_size: contextWindow } : {}) };
    }
    const entry = cfg.model_config[model.slug];
		if (entry?.preferred_endpoints?.[0] === endpoint.name && !entry.context_window_size && contextWindow) entry.context_window_size = contextWindow;
    if (entry?.preferred_endpoints?.[0] === endpoint.name && !entry.allowed_thinking_modes && model.supported_reasoning_levels?.length) {
      const allowed = model.supported_reasoning_levels.map(level => level.effort).filter(effort => ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort));
      if (allowed.length) entry.allowed_thinking_modes = allowed;
    }
  }
}
