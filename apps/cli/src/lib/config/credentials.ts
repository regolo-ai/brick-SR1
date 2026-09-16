import { catalog } from '../catalog/index.js';
/** Profile-scoped storage and online validation for user supplied credentials. */
import { chmod, readFile } from 'node:fs/promises';
import { readEnvValue,upsertEnvValues,parseProfileEnv } from './env-file.js';
import { paths } from './paths.js';

export function isRegoloEndpoint(baseUrl: string): boolean {
  try { return new URL(baseUrl).origin === 'https://api.regolo.ai'; } catch { return false; }
}

export type CredentialProvider = 'openai' | 'anthropic';

function endpoint(baseUrl: string, provider: CredentialProvider): string {
  const root = baseUrl.replace(/\/+$/, '');
  if (provider === 'anthropic') return root.endsWith('/v1') ? `${root}/models` : `${root}/v1/models`;
  return root.endsWith('/v1') ? `${root}/models` : `${root}/v1/models`;
}

function safeEndpoint(url: string): string {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return 'the provider endpoint'; }
}

/** Validate a key without ever incorporating it into an error message. */
export async function validateCredential(
  baseUrl: string,
  token: string,
  provider: CredentialProvider = 'openai',
  model?: string,
): Promise<void> {
  if (!token.trim()) throw new Error('API key cannot be empty.');
  const regolo = isRegoloEndpoint(baseUrl);
  if (regolo && !model) throw new Error('Select a configured model before validating the Regolo key.');
  const url = regolo ? `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions` : endpoint(baseUrl, provider);
  const headers: Record<string, string> = provider === 'anthropic'
    ? { 'x-api-key': token, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${token}` };
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { ...headers, ...(regolo ? { 'Content-Type': 'application/json' } : {}) },
      ...(regolo ? { method: 'POST', body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false }) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error(`Could not reach ${safeEndpoint(url)} to validate the API key. Check the endpoint and network connection.`);
  }
  if (!response.ok) {
    const reason = response.status === 401 ? 'The API key was rejected.' :
      response.status === 403 ? 'Access to the configured model was denied.' :
      response.status === 404 ? 'The configured model is unavailable.' :
      response.status === 429 || response.status === 402 ? 'Provider quota or rate limit exceeded.' : `Provider returned HTTP ${response.status}.`;
    throw new Error(`${reason} Verify the key and try again.`);
  }
  let body: any;
  try { body = await response.json(); } catch { throw new Error(`Invalid response from ${safeEndpoint(url)} while validating the API key.`); }
  if (!body || typeof body !== 'object' || !Array.isArray(regolo ? body.choices : body.data)) {
    throw new Error(`Invalid response from ${safeEndpoint(url)} while validating the API key.`);
  }
}

export async function saveCredential(
  profile: string, envKey: string, token: string, baseUrl: string, provider: CredentialProvider = 'openai', model = 'brick-complexity-pro',
): Promise<void> {
  await validateCredential(baseUrl, token, provider, model);
  const env = paths(profile).env;
  await upsertEnvValues(env, { [envKey]: token });
  // writeFile's mode is affected by an existing permissive file.
  await chmod(env, 0o600);
}

const INTERNAL = new Set(['CODEX_FLAT_BRIDGE_TOKEN', 'BRICK_CLASSIFIER_TOKEN']);
function isReference(value: unknown): boolean { return typeof value === 'string' && /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value); }
function keyFor(path: string[], value: string, used: Map<string, string>): string {
  const context = path.join('_').toUpperCase();
  let base = /REGOLO/.test(value) || /REGOLO/.test(context) ? 'REGOLO_API_KEY' :
    /ANTHROPIC/.test(context) ? 'ANTHROPIC_API_KEY' : `${(context || 'PROVIDER').replace(/[^A-Z0-9_]/g, '_')}_API_KEY`;
  // Keep repeat saves stable while not merging different literal credentials.
  let candidate = base, n = 2;
  while (used.has(candidate) && used.get(candidate) !== value) candidate = `${base}_${n++}`;
  used.set(candidate, value);
  return candidate;
}

/** Prepare literal credential migration without changing profile files. */
export async function extractLiteralCredentials(profile: string, obj: any): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const used = new Map<string, string>();
  try { for (const [key, value] of Object.entries(parseProfileEnv(await readFile(paths(profile).env, 'utf8')))) used.set(key, value); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const visit = (node: any, path: string[]): void => {
    if (!node || typeof node !== 'object') return;
    for (const [name, value] of Object.entries(node)) {
      if (['api_key', 'access_key', 'bearer_token'].includes(name) && typeof value === 'string' && value.trim() && !isReference(value)) {
        const existingEnv = typeof (node as any).api_key_env === 'string' ? (node as any).api_key_env : undefined;
        if (existingEnv) throw new Error(`Conflicting literal and environment credential sources at ${path.join('.')}`);
        const envKey = keyFor([...path, name], value, used);
        values[envKey] = value;
        (node as any)[name] = '${' + envKey + '}';
      } else visit(value, [...path, name]);
    }
  };
  visit(obj, []);
  return values;
}

/** Read the active pool and hosted classifier and validate every required key. */
export async function validateProfileCredentials(profile: string, cfg: any, pending: Record<string, string> = {}): Promise<void> {
  const seen = new Set<string>();
  const check = async (baseUrl: string, envKey: string, provider: CredentialProvider = 'openai', model?: string) => {
    if (!baseUrl || !envKey || INTERNAL.has(envKey) || seen.has(`${baseUrl}\0${envKey}\0${model}`)) return;
    seen.add(`${baseUrl}\0${envKey}\0${model}`);
    const token = pending[envKey] ?? await readEnvValue(paths(profile).env, envKey);
    if (!token?.trim()) throw new Error(`Missing ${envKey} in ${paths(profile).env}.`);
    await validateCredential(baseUrl, token, provider, model);
  };
  const active = new Set<string>(cfg.skill_router?.active_models?.length ? cfg.skill_router.active_models : (cfg.skill_router?.models ?? []).map((m: any) => m.model));
  for (const model of cfg.skill_router?.models ?? []) if (active.has(model.model) && model.api_key_env) await check(model.base_url, model.api_key_env, /anthropic/i.test(model.base_url || '') ? 'anthropic' : 'openai', model.model);
  for (const cs of [cfg.complexity_service, cfg.skill_router?.complexity_model]) {
    const key = typeof cs?.bearer_token === 'string' && /^\$\{(.+)\}$/.exec(cs.bearer_token)?.[1];
    if (cs && cs.enabled !== false && key && !INTERNAL.has(key) && /^https?:/.test(cs.base_url || '')) {
      await check(cs.base_url, key, /anthropic/i.test(cs.base_url) ? 'anthropic' : 'openai', cs.model_name ?? cfg.complexity_service?.model_name);
    }
  }
  // Edited provider keys must be checked even before their models are active.
  for (const [id, provider] of Object.entries(cfg.providers ?? {}) as Array<[string, any]>) {
    const known: any = (catalog as any)[id];
    if (known?.optional) continue;
    const envKey = isRegoloEndpoint(provider.base_url ?? '') ? 'REGOLO_API_KEY' :
      known?.env_key ?? `${id.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_API_KEY`;
    if (!(envKey in pending)) continue;
    const model = (cfg.skill_router?.models ?? []).find((m: any) => m.api_key_env === envKey)?.model ??
      (isRegoloEndpoint(cfg.complexity_service?.base_url ?? '') ? cfg.complexity_service.model_name : undefined);
    await check(provider.base_url, envKey, /anthropic/i.test(provider.base_url ?? '') ? 'anthropic' : 'openai', model);
  }
}
