// Shared upsert/read for profile .env files, so the Claude compute flow and
// the bootstrap agree on how the Regolo API key is stored. Keys already
// present are replaced in place; unrelated lines (comments, other keys) are
// preserved. The file is written 0600 since it holds secrets.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Read a single KEY=value from a .env file, or null if absent/unreadable. */
export async function readEnvValue(envPath: string, key: string): Promise<string | null> {
  try {
    const txt = await readFile(envPath, 'utf8');
    const m = txt.match(new RegExp(`^${key}=(.*)$`, 'm'));
    if (m) return m[1].trim();
  } catch {
    // missing file / unreadable: treat as absent
  }
  return null;
}

/**
 * Upsert KEY=value pairs into a .env file, preserving comments and any other
 * keys. Existing occurrences of a given key are replaced in place (first hit);
 * new keys are appended. Creates the file (and parent dir) if missing.
 */
export async function upsertEnvValues(envPath: string, values: Record<string, string>): Promise<void> {
  await mkdir(dirname(envPath), { recursive: true, mode: 0o700 });
  let existing = '';
  try {
    existing = await readFile(envPath, 'utf8');
  } catch {
    // new file
  }

  const pending = new Map(Object.entries(values));
  const outLines: string[] = [];

  for (const line of existing.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (m && pending.has(m[1])) {
      outLines.push(`${m[1]}=${pending.get(m[1])}`);
      pending.delete(m[1]);
    } else {
      outLines.push(line);
    }
  }

  // Drop a single trailing empty line so we can re-add exactly one below.
  while (outLines.length > 0 && outLines[outLines.length - 1] === '') {
    outLines.pop();
  }

  for (const [k, v] of pending) {
    outLines.push(`${k}=${v}`);
  }

  await writeFile(envPath, outLines.join('\n') + '\n', { mode: 0o600 });
}
