import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';

// Minimal, dependency-free editor for ~/.codex/config.toml. We only need to:
//  - read/set the top-level `profile` key (Codex's active-profile selector), and
//  - append/remove a single clearly-delimited managed block that defines the
//    `[model_providers.brick]` (base_url + wire_api=chat) and `[profiles.brick]`
//    (model=brick, model_provider=brick) tables.
// This avoids a full TOML parser while staying robust: the managed block is
// fenced by markers so `off` removes exactly what `on` added, and the top-level
// `profile` edit only touches lines before the first `[table]` header.

const BEGIN = '# >>> brick codex managed block (do not edit) >>>';
const END = '# <<< brick codex managed block <<<';

/** Codex honors CODEX_HOME; default is ~/.codex. */
export function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

export function codexConfigPath(): string {
  return join(codexHome(), 'config.toml');
}

export function readCodexConfig(): string {
  const path = codexConfigPath();
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

function writeCodexConfig(text: string): void {
  const path = codexConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.brick.tmp`;
  const out = text.endsWith('\n') ? text : text + '\n';
  writeFileSync(tmp, out, { mode: 0o644 });
  renameSync(tmp, path);
}

/** Index of the first TOML table header line (`[...]`), or lines.length. */
function firstTableIndex(lines: string[]): number {
  const i = lines.findIndex((l) => /^\s*\[/.test(l));
  return i < 0 ? lines.length : i;
}

/** Read the top-level `profile = "..."` value, or null if absent. */
export function getTopLevelProfile(text: string): string | null {
  const lines = text.split('\n');
  const end = firstTableIndex(lines);
  for (let i = 0; i < end; i++) {
    const m = lines[i].match(/^\s*profile\s*=\s*["']([^"']*)["']\s*$/);
    if (m) return m[1];
  }
  return null;
}

/** Set the top-level `profile` key, replacing an existing one or inserting it. */
function setTopLevelProfile(text: string, value: string): string {
  const lines = text === '' ? [] : text.split('\n');
  const end = firstTableIndex(lines);
  const newLine = `profile = "${value}"`;
  for (let i = 0; i < end; i++) {
    if (/^\s*profile\s*=/.test(lines[i])) {
      lines[i] = newLine;
      return lines.join('\n');
    }
  }
  lines.splice(0, 0, newLine);
  return lines.join('\n');
}

/** Remove the top-level `profile` line if it equals `value`; restore otherwise. */
function restoreTopLevelProfile(text: string, previous: string | null): string {
  const lines = text === '' ? [] : text.split('\n');
  const end = firstTableIndex(lines);
  for (let i = 0; i < end; i++) {
    if (/^\s*profile\s*=/.test(lines[i])) {
      if (previous === null) {
        lines.splice(i, 1);
      } else {
        lines[i] = `profile = "${previous}"`;
      }
      return lines.join('\n');
    }
  }
  if (previous !== null) {
    lines.splice(0, 0, `profile = "${previous}"`);
  }
  return lines.join('\n');
}

function stripManagedBlock(text: string): string {
  const re = new RegExp(`\\n*${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n*`, 'g');
  return text.replace(re, '\n');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function managedBlock(baseUrl: string): string {
  // baseUrl is e.g. http://localhost:8010; Codex expects the OpenAI-compatible
  // root, so append /v1. wire_api=chat forces /v1/chat/completions.
  return [
    BEGIN,
    '[model_providers.brick]',
    'name = "Brick (local router)"',
    `base_url = "${baseUrl}/v1"`,
    'wire_api = "chat"',
    '',
    '[profiles.brick]',
    'model = "brick"',
    'model_provider = "brick"',
    END,
  ].join('\n');
}

export interface CodexWireResult {
  previousProfile: string | null;
  createdFile: boolean;
}

/**
 * Point Codex at the local Brick router: set top-level `profile = "brick"` and
 * append the managed `[model_providers.brick]` + `[profiles.brick]` block.
 * Idempotent — re-running replaces the managed block in place.
 */
export function wireCodex(baseUrl: string): CodexWireResult {
  const createdFile = !existsSync(codexConfigPath());
  const original = readCodexConfig();
  const previousProfile = getTopLevelProfile(original);

  let text = stripManagedBlock(original);
  text = setTopLevelProfile(text, 'brick');
  text = text.replace(/\n+$/, '\n');
  text = (text.endsWith('\n') ? text : text + '\n') + managedBlock(baseUrl) + '\n';
  writeCodexConfig(text);

  return { previousProfile, createdFile };
}

/** Remove the managed block and restore the prior top-level `profile`. */
export function unwireCodex(previousProfile: string | null): void {
  const original = readCodexConfig();
  if (original === '') return;
  let text = stripManagedBlock(original);
  text = restoreTopLevelProfile(text, previousProfile);
  writeCodexConfig(text);
}

/** Whether the managed block is currently present. */
export function isWired(text: string): boolean {
  return text.includes(BEGIN);
}
