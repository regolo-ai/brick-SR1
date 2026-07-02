import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';

// Minimal, dependency-free editor for ~/.codex/config.toml.
//
// Codex 0.134+ selects the active provider with top-level `model` and
// `model_provider`. Brick owns only a fenced `[model_providers.brick]` block;
// it deliberately does not create a legacy `[profiles.brick]` table.

const BEGIN = '# >>> brick codex managed block (do not edit) >>>';
const END = '# <<< brick codex managed block <<<';
const BRICK_PROVIDER_TABLE = 'model_providers.brick';

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

function rootStringRe(key: string): RegExp {
  return new RegExp(`^\\s*${escapeRe(key)}\\s*=\\s*["']([^"']*)["']\\s*(?:#.*)?$`);
}

/** Read a top-level string key before the first TOML table, or null if absent. */
export function getTopLevelString(text: string, key: string): string | null {
  const lines = text.split('\n');
  const end = firstTableIndex(lines);
  const re = rootStringRe(key);
  for (let i = 0; i < end; i++) {
    const m = lines[i].match(re);
    if (m) return m[1];
  }
  return null;
}

export function getTopLevelModel(text: string): string | null {
  return getTopLevelString(text, 'model');
}

export function getTopLevelModelProvider(text: string): string | null {
  return getTopLevelString(text, 'model_provider');
}

/** Kept for migration/status display of old Codex configs. */
export function getTopLevelProfile(text: string): string | null {
  return getTopLevelString(text, 'profile');
}

function setTopLevelString(text: string, key: string, value: string): string {
  const lines = text === '' ? [] : text.split('\n');
  const end = firstTableIndex(lines);
  const re = new RegExp(`^\\s*${escapeRe(key)}\\s*=`);
  const newLine = `${key} = "${value}"`;
  for (let i = 0; i < end; i++) {
    if (re.test(lines[i])) {
      lines[i] = newLine;
      return lines.join('\n');
    }
  }
  lines.splice(0, 0, newLine);
  return lines.join('\n');
}

function removeTopLevelStringIfValue(text: string, key: string, value: string): string {
  const lines = text === '' ? [] : text.split('\n');
  const end = firstTableIndex(lines);
  const re = rootStringRe(key);
  for (let i = 0; i < end; i++) {
    const m = lines[i].match(re);
    if (m && m[1] === value) {
      lines.splice(i, 1);
      return lines.join('\n');
    }
  }
  return text;
}

function restoreTopLevelString(text: string, key: string, previous: string | null, managedValue: string): string {
  const lines = text === '' ? [] : text.split('\n');
  const end = firstTableIndex(lines);
  const re = rootStringRe(key);
  for (let i = 0; i < end; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    if (m[1] !== managedValue) return text;
    if (previous === null) lines.splice(i, 1);
    else lines[i] = `${key} = "${previous}"`;
    return lines.join('\n');
  }
  if (previous !== null) {
    lines.splice(0, 0, `${key} = "${previous}"`);
  }
  return lines.join('\n');
}

function restoreLegacyProfile(text: string, previousProfile: string | null | undefined): string {
  const previous = previousProfile && previousProfile !== 'brick' ? previousProfile : null;
  const lines = text === '' ? [] : text.split('\n');
  const end = firstTableIndex(lines);
  const re = rootStringRe('profile');
  for (let i = 0; i < end; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    if (m[1] !== 'brick') return text;
    if (previous === null) lines.splice(i, 1);
    else lines[i] = `profile = "${previous}"`;
    return lines.join('\n');
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

function hasTable(text: string, table: string): boolean {
  const re = new RegExp(`^\\s*\\[${escapeRe(table)}\\]\\s*(?:#.*)?$`, 'm');
  return re.test(text);
}

export function hasUnmanagedBrickProvider(text: string): boolean {
  return hasTable(stripManagedBlock(text), BRICK_PROVIDER_TABLE);
}

function managedBlock(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '');
  return [
    BEGIN,
    '[model_providers.brick]',
    'name = "Brick (local router)"',
    `base_url = "${root}/v1"`,
    'wire_api = "chat"',
    'requires_openai_auth = true',
    END,
  ].join('\n');
}

export interface CodexWireResult {
  previousModel: string | null;
  previousModelProvider: string | null;
  previousProfile: string | null;
  createdFile: boolean;
}

export interface CodexUnwireState {
  previousModel: string | null;
  previousModelProvider: string | null;
  previousProfile?: string | null;
}

/**
 * Point Codex at the local Brick router: set top-level `model = "brick"` and
 * `model_provider = "brick"`, then append the managed provider block.
 * Idempotent: re-running replaces the managed block in place.
 */
export function wireCodex(baseUrl: string): CodexWireResult {
  const createdFile = !existsSync(codexConfigPath());
  const original = readCodexConfig();
  const previousModel = getTopLevelModel(original);
  const previousModelProvider = getTopLevelModelProvider(original);
  const previousProfile = getTopLevelProfile(original);

  let text = stripManagedBlock(original);
  if (hasUnmanagedBrickProvider(text)) {
    throw new Error(
      'found an existing unmanaged [model_providers.brick] table in Codex config. ' +
      'rename or remove it before running `brick codex on`.'
    );
  }

  text = removeTopLevelStringIfValue(text, 'profile', 'brick');
  text = setTopLevelString(text, 'model_provider', 'brick');
  text = setTopLevelString(text, 'model', 'brick');
  text = text.replace(/\n+$/, '\n');
  text = (text.endsWith('\n') ? text : text + '\n') + managedBlock(baseUrl) + '\n';
  writeCodexConfig(text);

  return { previousModel, previousModelProvider, previousProfile, createdFile };
}

/** Remove the managed block and restore prior top-level model/provider values. */
export function unwireCodex(state: CodexUnwireState): void {
  const original = readCodexConfig();
  if (original === '') return;
  let text = stripManagedBlock(original);
  text = restoreTopLevelString(text, 'model', state.previousModel, 'brick');
  text = restoreTopLevelString(text, 'model_provider', state.previousModelProvider, 'brick');
  text = restoreLegacyProfile(text, state.previousProfile);
  writeCodexConfig(text);
}

/** Whether the managed block is currently present. */
export function isWired(text: string): boolean {
  return text.includes(BEGIN);
}
