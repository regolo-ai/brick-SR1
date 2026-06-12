// Publication of measured skill records to the shared Hugging Face dataset
// regolo/brick-skill-tables. Always explicit opt-in (the caller shows the
// consent prompt). Uses the single-file NDJSON commit endpoint: batch LFS
// commits are known to fail with 403 on this org, individual uploads work.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SkillTableRecord } from './table.js';

export const HF_DATASET = 'regolo/brick-skill-tables';

function resolveToken(): string {
  const env = process.env.HF_TOKEN?.trim();
  if (env) return env;
  // local convenience fallback (developer machines)
  const f = join(homedir(), '.hf_token_regolo');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  throw new Error('no Hugging Face token: set HF_TOKEN (needs write access to regolo/brick-skill-tables)');
}

/**
 * Upsert one record as tables/<model>.json on the dataset. Returns the file URL.
 */
export async function publishSkillRecord(record: SkillTableRecord): Promise<string> {
  const token = resolveToken();
  const fname = `tables/${record.model.replace(/[/\\]/g, '_')}.json`;
  const content = Buffer.from(JSON.stringify(record, null, 2) + '\n').toString('base64');

  const ndjson =
    JSON.stringify({
      key: 'header',
      value: { summary: `skills: upsert ${record.model} (${record.source}, ${record.subset_hash ?? 'no-hash'})` },
    }) +
    '\n' +
    JSON.stringify({ key: 'file', value: { content, path: fname, encoding: 'base64' } }) +
    '\n';

  const commit = async (createPr: boolean): Promise<Response> =>
    fetch(`https://huggingface.co/api/datasets/${HF_DATASET}/commit/main${createPr ? '?create_pr=1' : ''}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-ndjson',
      },
      body: ndjson,
    });

  // Try a direct commit first; tokens without direct write access get a 403
  // asking for create_pr=1, in which case we open a Pull Request instead
  // (community contributions get maintainer review that way).
  let res = await commit(false);
  if (res.status === 403) {
    res = await commit(true);
    if (res.ok) {
      const data: any = await res.json().catch(() => ({}));
      return data?.pullRequestUrl ?? `https://huggingface.co/datasets/${HF_DATASET}/discussions`;
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HF commit failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return `https://huggingface.co/datasets/${HF_DATASET}/blob/main/${fname}`;
}
