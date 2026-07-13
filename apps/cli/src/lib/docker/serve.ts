import { stat } from 'node:fs/promises';
import { dockerCompose } from './run.js';
import { defaultImage, imageExists, pullImage } from './image.js';
import { paths, updateState } from '../config/paths.js';
import { loadConfig } from '../config/load.js';
import { err, info, ok, warn } from '../ui/banners.js';
import { localBaseUrl } from '../net/local.js';

export async function waitHealth(port: number, timeoutMs = 90000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${localBaseUrl(port)}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

export async function isHealthy(port: number): Promise<boolean> {
  try {
    const r = await fetch(`${localBaseUrl(port)}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

export interface EnsureServingResult {
  port: number;
  healthy: boolean;
}

/**
 * Bring a profile's router container up (idempotent) and wait for /health.
 * Shared by `brick serve` and `brick claude on`.
 * Throws (string message) on unrecoverable setup errors (missing config/compose, image, compose up).
 */
export async function ensureServing(
  profile: string,
  opts: { pull?: boolean } = {}
): Promise<EnsureServingResult> {
  const pp = paths(profile);
  try { await stat(pp.config); } catch { throw new Error(`no config at ${pp.config}. run \`brick config new ${profile}\` first.`); }
  try { await stat(pp.compose); } catch { throw new Error(`no compose at ${pp.compose}. run \`brick config new ${profile}\` first.`); }

  const cfg = await loadConfig(profile);
  const port = cfg.server_port;

  const img = defaultImage();
  if (opts.pull || !(await imageExists(img))) {
    info(`pulling ${img} ...`);
    const r = await pullImage(img);
    if (!r.ok) {
      warn(`pull failed (${r.stderr.split('\n')[0]}). falling back to existing local image if any.`);
      if (!(await imageExists(img))) throw new Error(`image ${img} not found locally and pull failed.`);
    } else ok('pulled');
  } else {
    ok(`image ${img} already present`);
  }

  info(`docker compose up -d (profile: ${profile})`);
  const r = await dockerCompose(profile, ['up', '-d']);
  if (r.exitCode !== 0) throw new Error(r.stderr.slice(0, 800));

  info(`waiting for health on ${localBaseUrl(port)}/health ...`);
  const healthy = await waitHealth(port);
  if (!healthy) warn('health check did not become OK in 90s — container may still be starting; check `brick logs`');
  else ok(`router ready at ${localBaseUrl(port)}/v1/chat/completions (model: brick · profile: ${profile})`);

  updateState({ runningProfile: profile });
  return { port, healthy };
}
