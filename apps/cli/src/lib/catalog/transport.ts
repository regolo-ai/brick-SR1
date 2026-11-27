import { catalog } from './index.js';

export interface ProviderTransport {
  baseUrl: string;
  apiKeyEnv?: string;
  protocol?: 'responses' | 'chat_completions';
  authSource?: 'codex_request' | 'provider_env';
  responsesPath?: string;
  chatPath?: string;
  compactPath?: string;
}

interface ProviderLike {
  base_url?: string;
  protocol?: 'responses' | 'chat_completions';
  auth_source?: 'codex_request' | 'provider_env';
  api_key_env?: string;
  responses_path?: string;
  chat_path?: string;
  compact_path?: string;
}

function normalized(url: unknown): string {
  return typeof url === 'string' ? url.replace(/\/+$/, '') : '';
}

/** Resolve provider-owned URL and credentials without crossing providers. */
export function resolveProviderTransport(providerId: string, provider?: ProviderLike): ProviderTransport | null {
  const configuredBaseUrl = normalized(provider?.base_url);
  if (providerId === 'openai-codex') return { baseUrl: configuredBaseUrl || 'https://chatgpt.com/backend-api/codex', protocol: 'responses', authSource: 'codex_request', responsesPath: 'responses', compactPath: 'responses/compact' };
  const direct = catalog[providerId];
  const known = direct ?? Object.values(catalog).find((entry) =>
    configuredBaseUrl !== '' && normalized(entry.base_url) === configuredBaseUrl
  );
  const baseUrl = configuredBaseUrl || normalized(known?.base_url);
  if (!baseUrl) return null;
  return {
    baseUrl,
    protocol: provider?.protocol,
    authSource: provider?.auth_source ?? 'provider_env',
    responsesPath: provider?.responses_path,
    chatPath: provider?.chat_path,
    compactPath: provider?.compact_path,
    apiKeyEnv: provider?.api_key_env ?? known?.env_key ?? `${providerId.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_API_KEY`,
  };
}

export function resolveModelTransport(
  model: string,
  modelConfig: Record<string, any> | undefined,
  providerProfiles: Record<string, any> | undefined,
  providerEndpoints: Array<{ name: string; provider_profile: string }> | undefined,
): ProviderTransport | null {
  const endpointName = modelConfig?.[model]?.preferred_endpoints?.[0];
  if (typeof endpointName !== 'string') return null;
  const endpoint = providerEndpoints?.find((entry) => entry.name === endpointName);
  const providerId = endpoint?.provider_profile ?? endpointName;
  return resolveProviderTransport(providerId, providerProfiles?.[providerId]);
}

/** Fill only absent fields so user-supplied transport overrides remain intact. */
export function applyModelTransport(entry: Record<string, any>, transport: ProviderTransport | null): boolean {
  if (!transport) return false;
  let changed = false;
  if (!entry.base_url) { entry.base_url = transport.baseUrl; changed = true; }
  if (!entry.api_key && !entry.api_key_env && !entry.api_key_file && transport.apiKeyEnv) {
    entry.api_key_env = transport.apiKeyEnv;
    changed = true;
  }
  return changed;
}
