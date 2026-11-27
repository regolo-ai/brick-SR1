// Shared upsert/read for profile .env files, so the Claude compute flow and
// the bootstrap agree on how the Regolo API key is stored. Keys already
// present are replaced in place; unrelated lines (comments, other keys) are
// preserved. The file is written 0600 since it holds secrets.

import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWrite } from './atomic-file.js';

/** Parse the same dotenv syntax for profile editing and runtime launch. */
export function parseProfileEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error('Invalid profile .env syntax');
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

/** Read a key without interpreting a permissions error as a missing credential. */
export async function readEnvValue(envPath: string, key: string): Promise<string | null> {
  try { return parseProfileEnv(await readFile(envPath, 'utf8'))[key] ?? null; }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
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
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }

  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) throw new Error('Invalid environment key or multiline credential');
  }
  const pending = new Map(Object.entries(values));
  const outLines: string[] = [];

  for (const line of existing.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && pending.has(m[1])) {
      outLines.push(`${m[1]}=${pending.get(m[1])}`);
      pending.delete(m[1]);
    } else if (!m || !(m[1] in values)) {
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

  await atomicWrite(envPath, outLines.join('\n') + '\n');
}
