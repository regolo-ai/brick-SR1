import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { lookupSkillRecord, type SkillTableRecord } from './table.js';

export interface SkillResolveOptions {
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  refresh?: boolean;
}

function fileName(model: string): string { return `${model.replace(/[\/\\]/g, '_')}.json`; }
function cachePath(model: string, dir?: string): string {
  return join(dir ?? join(homedir(), '.brick', 'cache', 'skill-tables'), fileName(model));
}

async function readRecord(path: string): Promise<SkillTableRecord | null> {
  try {
    const rec = JSON.parse(await readFile(path, 'utf8'));
    return rec?.model && Array.isArray(rec.skill_vector) ? rec : null;
  } catch { return null; }
}

export async function resolveSkillCard(model: string, options: SkillResolveOptions = {}): Promise<SkillTableRecord | null> {
  const bundled = lookupSkillRecord(model);
  if (bundled && !options.refresh) return bundled;
  const local = await readRecord(cachePath(model, options.cacheDir));
  if (local && !options.refresh) return local;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `https://huggingface.co/datasets/regolo/brick-skill-tables/resolve/main/tables/${fileName(model)}`;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const remote = await response.json() as SkillTableRecord;
    if (!remote?.model || !Array.isArray(remote.skill_vector)) return bundled ?? local;
    const path = cachePath(model, options.cacheDir);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(remote, null, 2));
    return remote;
  } catch {
    return bundled ?? local;
  }
}

export async function resolveSkillCards(models: string[], options: SkillResolveOptions = {}): Promise<Map<string, SkillTableRecord>> {
  const out = new Map<string, SkillTableRecord>();
  for (const model of [...new Set(models)]) {
    const card = await resolveSkillCard(model, options);
    if (card) out.set(model, card);
  }
  return out;
}
