// Loader for the public skill tables bundled under templates/skill-tables/.
// `brick init` uses this to seed skill_router.models[].skill_vector for known
// model ids instead of falling back to a heuristic, so users never re-run
// inference for a model someone already measured.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/lib/skills -> ../../../templates == apps/cli/templates (same convention
// as docker/compose.ts and claude/bootstrap.ts).
const TABLE_DIR = join(__dirname, '..', '..', '..', 'templates', 'skill-tables');

export type SkillSource = 'benchmark' | 'measured' | 'heuristic';

export interface SkillTableRecord {
  model: string;
  provider?: string;
  capabilities: string[];
  skill_vector: number[];
  source: SkillSource;
  confidence?: string[];
  imputed_capabilities?: string[];
  support?: unknown;
  subset_hash?: string | null;
  date?: string;
  notes?: string;
}

let cache: Map<string, SkillTableRecord> | null = null;

/** Load every <model>.json under templates/skill-tables/ (memoized). */
export function loadSkillTable(): Map<string, SkillTableRecord> {
  if (cache) return cache;
  const map = new Map<string, SkillTableRecord>();
  if (!existsSync(TABLE_DIR)) {
    cache = map;
    return map;
  }
  for (const f of readdirSync(TABLE_DIR)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    try {
      const rec = JSON.parse(readFileSync(join(TABLE_DIR, f), 'utf8')) as SkillTableRecord;
      if (rec && typeof rec.model === 'string' && Array.isArray(rec.skill_vector)) {
        map.set(rec.model, rec);
      }
    } catch {
      // skip malformed entries; a bad file should not break init
    }
  }
  cache = map;
  return map;
}

/**
 * Look up a model's published skill vector. Returns null if unknown so the
 * caller can fall back to a heuristic and mark skill_source accordingly.
 */
export function lookupSkillRecord(modelId: string): SkillTableRecord | null {
  return loadSkillTable().get(modelId) ?? null;
}
