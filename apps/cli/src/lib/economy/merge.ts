import {
  isSyncedRow,
  sameSnapshot,
  snapshotOf,
  type PricingEntry,
  type SyncedSnapshot,
} from './table.js';

export interface MergeResult {
  rows: PricingEntry[];
  added: string[];
  updated: string[];
  /** Rows we refused to touch because the local price differs from our last write. */
  kept: string[];
}

/**
 * Merge freshly downloaded prices into a profile table.
 *
 * The user always wins: a row is rewritten only when we wrote it last time and
 * its values still match that write, or when it is still an untouched copy of
 * the shipped seed table (`adopt`). Anything edited by hand is preserved
 * untouched, with no prompts and no "did you mean" questions.
 */
export function mergePricing(
  existing: PricingEntry[],
  incoming: PricingEntry[],
  lastSynced: Record<string, SyncedSnapshot> = {},
  adopt: ReadonlySet<string> = new Set(),
): MergeResult {
  const rows = [...existing];
  const index = new Map(rows.map((row, i) => [row.model, i]));
  const added: string[] = [];
  const updated: string[] = [];
  const kept: string[] = [];

  for (const next of incoming) {
    const at = index.get(next.model);
    if (at === undefined) {
      index.set(next.model, rows.length);
      rows.push(next);
      added.push(next.model);
      continue;
    }
    const current = rows[at];
    const previous = lastSynced[next.model];
    const ours = isSyncedRow(current) && previous !== undefined && sameSnapshot(snapshotOf(current), previous);
    if (!ours && !adopt.has(next.model)) { kept.push(next.model); continue; }
    if (sameSnapshot(snapshotOf(current), snapshotOf(next))) continue;
    rows[at] = { ...current, ...next };
    updated.push(next.model);
  }

  return { rows, added, updated, kept };
}
