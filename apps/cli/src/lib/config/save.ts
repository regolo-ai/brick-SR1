import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { atomicWrite } from './atomic-file.js';
import { nativeConfig } from './native-migration.js';
import { paths, resolveProfile } from './paths.js';
import type { BrickConfig } from './schema.js';
import { extractLiteralCredentials } from './credentials.js';
import { upsertEnvValues } from './env-file.js';

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; return null; }
}

async function persist(profile: string, input: any): Promise<string> {
  const pp = paths(profile);
  const cfg = nativeConfig(input);
  const values = await extractLiteralCredentials(profile, cfg);
  const oldEnv = await readOptional(pp.env);
  const oldConfig = await readOptional(pp.config);
  if (Object.keys(values).length) {
    const backup = join(pp.profileDir, 'backups', `credentials-${randomUUID()}`);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    if (oldEnv !== null) await writeFile(join(backup, '.env'), oldEnv, { flag: 'wx', mode: 0o600 });
    if (oldConfig !== null) await writeFile(join(backup, 'config.yaml'), oldConfig, { flag: 'wx', mode: 0o600 });
    await upsertEnvValues(pp.env, values);
  }
  try {
    await atomicWrite(pp.config, yaml.dump(cfg, { lineWidth: 120, noRefs: true, sortKeys: false }));
  } catch (error) {
    if (Object.keys(values).length) {
      if (oldEnv === null) await rm(pp.env, { force: true });
      else await atomicWrite(pp.env, oldEnv);
    }
    throw error;
  }
  return pp.config;
}

export async function saveConfig(cfg: BrickConfig, profile?: string): Promise<string> {
  return persist(profile ?? resolveProfile(), cfg);
}

export async function saveConfigText(content: string, profile?: string): Promise<string> {
  let parsed: any;
  try { parsed = yaml.load(content); }
  catch { throw new Error('Invalid YAML; profile files were not changed.'); }
  return persist(profile ?? resolveProfile(), parsed);
}
