import { dockerCmd } from './run.js';

const DEFAULT_IMAGE = process.env.BRICK_IMAGE ?? 'docker.io/regolo/brick:latest';

export async function imageExists(image = DEFAULT_IMAGE): Promise<boolean> {
  const r = await dockerCmd(['image', 'inspect', image]);
  return r.exitCode === 0;
}

export async function imageId(image: string): Promise<string | null> {
  const r = await dockerCmd(['image', 'inspect', '--format', '{{.Id}}', image]);
  return r.exitCode === 0 ? r.stdout.trim() || null : null;
}

export async function pullImage(image = DEFAULT_IMAGE): Promise<{ ok: boolean; stderr: string }> {
  const r = await dockerCmd(['pull', image]);
  return { ok: r.exitCode === 0, stderr: r.stderr };
}

export function defaultImage(): string {
  return DEFAULT_IMAGE;
}
