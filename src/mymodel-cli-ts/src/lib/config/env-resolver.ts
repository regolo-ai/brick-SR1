/**
 * Environment variable resolution and secret masking.
 * Ported from Python loader.py helpers.
 */

const ENV_VAR_RE = /\$\{([^}]+)\}/g

/**
 * Replace ${VAR} placeholders with environment values.
 * Leaves unresolved if the env var is not set.
 */
export function resolveEnvVars(s: string): string {
  return s.replace(ENV_VAR_RE, (match, varName: string) => {
    return process.env[varName] ?? match
  })
}

/**
 * Mask a secret string, showing only the last 4 chars.
 * Leaves ${VAR} references unmasked.
 */
export function maskSecret(s: string): string {
  if (!s || s.length <= 4 || s.startsWith('${')) {
    return s
  }
  return '****' + s.slice(-4)
}

/**
 * Resolve a single api_key value — handles ${VAR} syntax.
 */
export function resolveApiKey(apiKey: string): string {
  if (apiKey.startsWith('${') && apiKey.endsWith('}')) {
    const varName = apiKey.slice(2, -1)
    return process.env[varName] ?? ''
  }
  return resolveEnvVars(apiKey)
}
