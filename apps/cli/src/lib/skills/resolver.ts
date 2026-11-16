import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseSkillTableCsv, skillVectorInOrder, type SkillTableRecord } from './table.js';
import { resolveSkillRecord } from './aliases.js';

export const SKILL_TABLE_URL = 'https://huggingface.co/datasets/regolo/brick-skill-tables/resolve/main/skill_vectors.csv';
const RETRY_STATUSES = new Set([500, 502, 503, 504]);
let processLoad: Promise<Map<string, SkillTableRecord>> | undefined;
export interface SkillResolveOptions { cacheDir?: string; fetchImpl?: typeof fetch; refresh?: boolean; timeoutMs?: number; warn?: (message: string) => void; offline?: boolean; }
export class InvalidRemoteSkillTableError extends Error {}
export function skillTableCachePath(cacheDir?: string): string {
  const base = cacheDir ?? join(process.env.BRICK_HOME ?? join(homedir(), '.brick'), 'cache');
  return join(base, 'skill_vectors.csv');
}

async function download(fetchImpl: typeof fetch, timeoutMs: number): Promise<string> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(SKILL_TABLE_URL, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return await response.text();
      const error = new Error(`skill table download failed: HTTP ${response.status}`);
      if (!RETRY_STATUSES.has(response.status)) throw Object.assign(error, { noRetry: true });
      last = error;
    } catch (error: any) { if (error?.noRetry) throw error; last = error; }
  }
  throw last instanceof Error ? last : new Error('skill table download failed');
}

async function saveCacheAtomically(path: string, csv: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(csv, 'utf8'); await file.sync(); } finally { await file.close(); }
    await rename(temp, path); await chmod(path, 0o600);
  } finally { await rm(temp, { force: true }).catch(() => undefined); }
}

async function readValidCache(path: string): Promise<{ records: Map<string, SkillTableRecord>; date: Date } | null> {
  try { const [csv, metadata] = await Promise.all([readFile(path, 'utf8'), stat(path)]); return { records: parseSkillTableCsv(csv), date: metadata.mtime }; }
  catch { return null; }
}

async function load(options: SkillResolveOptions): Promise<Map<string, SkillTableRecord>> {
  const path = skillTableCachePath(options.cacheDir);
  if (options.offline || process.env.BRICK_SKILLS_OFFLINE === '1') {
    const cached = await readValidCache(path);
    if (!cached) throw new Error('skill table cache is empty and offline mode is enabled');
    return cached.records;
  }
  let csv: string;
  try { csv = await download(options.fetchImpl ?? fetch, options.timeoutMs ?? 5000); }
  catch (error) {
    const cached = await readValidCache(path);
    if (!cached) throw error;
    options.warn?.(`Using cached skill table from ${cached.date.toISOString()} because Hugging Face is unavailable.`);
    return cached.records;
  }
  let records: Map<string, SkillTableRecord>;
  try { records = parseSkillTableCsv(csv); }
  catch (error: any) { throw new InvalidRemoteSkillTableError(`remote skill table is invalid: ${error?.message ?? error}`); }
  await saveCacheAtomically(path, csv);
  return records;
}

export function loadSkillTable(options: SkillResolveOptions = {}): Promise<Map<string, SkillTableRecord>> {
  if (options.refresh || options.fetchImpl || options.cacheDir) return load(options);
  return processLoad ??= load(options);
}
export async function resolveSkillCards(models: string[], options: SkillResolveOptions = {}): Promise<Map<string, SkillTableRecord>> {
  const table = await loadSkillTable(options); const result = new Map<string, SkillTableRecord>();
  for (const model of new Set(models)) { const record = resolveSkillRecord(table, model); if (record) result.set(model, record); }
  return result;
}

/**
 * Replace the config's provisional vectors with the published HF table.
 * Profile creation and the first start call this before the router reads the
 * config, so no skill vector is authored by the package when HF is reachable.
 * A download failure keeps the schema-valid fallback already in the config.
 */
export async function applyRemoteSkillVectors(config: any, options: SkillResolveOptions = {}): Promise<number> {
  const router = config?.skill_router;
  const models = Array.isArray(router?.models) ? router.models : [];
  const capabilities = Array.isArray(router?.capabilities) ? router.capabilities : [];
  if (!models.length || capabilities.length !== 6) return 0;
  let table: Map<string, SkillTableRecord>;
  try { table = await loadSkillTable(options); } catch { return 0; }
  let updated = 0;
  for (const model of models) {
    if (typeof model?.model !== 'string') continue;
    const record = resolveSkillRecord(table, model.model);
    if (!record) continue;
    model.skill_vector = skillVectorInOrder(record, capabilities);
    updated += 1;
  }
  return updated;
}
