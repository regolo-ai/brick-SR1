import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

// Minimal, formatting-preserving editor for ~/.config/opencode/opencode.json(c).
//
// OpenCode config files are JSONC: they carry comments and user formatting that
// a parse-and-reserialize round trip would destroy. Brick owns only a single
// `provider.brick` key, marked with a fenced comment so its own writes can be
// found and removed again without touching any other byte.

const MARK_START = '/* >>> brick opencode managed block (do not edit) >>> */';
const MARK_END = '/* <<< brick opencode managed block <<< */';

/** A model Brick advertises to OpenCode through `provider.brick.models`. */
export interface OpencodeModel {
  id: string;
  label?: string;
}

export interface OpencodeWireResult {
  /** true when wiring created the config file (no file existed before). */
  createdFile: boolean;
  /** true when the config already had a top-level `provider` object. */
  providerExisted: boolean;
}

export interface OpencodeUnwireState {
  /** true if wiring created the config file (so unwiring can remove it). */
  createdFile: boolean;
  /** true if the config already had a top-level `provider` object. */
  providerExisted: boolean;
}

/** Directory of the global OpenCode configuration. */
export function opencodeConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'opencode');
}

/** Global OpenCode config path; prefers an existing `.jsonc` over `.json`. */
export function opencodeConfigPath(): string {
  const dir = opencodeConfigDir();
  const json = join(dir, 'opencode.json');
  const jsonc = join(dir, 'opencode.jsonc');
  if (!existsSync(json) && existsSync(jsonc)) return jsonc;
  return json;
}

export function readOpencodeConfig(): string {
  const path = opencodeConfigPath();
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

function writeOpencodeConfig(text: string): void {
  const path = opencodeConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.brick.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// --- JSONC scanning -------------------------------------------------------

/** Skip whitespace and comments starting at `i`. */
function skipTrivia(s: string, i: number): number {
  for (;;) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '/' && s[i + 1] === '/') { i += 2; while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    return i;
  }
}

/** End (exclusive) of the string literal starting at `s[i] === '"'`. */
function scanString(s: string, i: number): number {
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '"') return i + 1;
    i++;
  }
  throw new Error('unterminated string in OpenCode config');
}

/** End (exclusive) of the object/array starting at `s[i]` in `{[`. */
function scanComposite(s: string, i: number): number {
  const open = s[i];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') { i = scanString(s, i); continue; }
    if (c === '/' && s[i + 1] === '/') { i += 2; while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
    i++;
  }
  throw new Error('unbalanced JSON in OpenCode config');
}

interface PropSpan {
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

/** Direct property `key` of the object at `objStart` (`s[objStart] === '{'`). */
function findProp(s: string, objStart: number, key: string): PropSpan | null {
  if (s[objStart] !== '{') return null;
  const objEnd = scanComposite(s, objStart) - 1;
  let i = skipTrivia(s, objStart + 1);
  while (i < objEnd) {
    if (s[i] !== '"') break;
    const keyEnd = scanString(s, i);
    const name = JSON.parse(s.slice(i, keyEnd)) as unknown;
    const colon = skipTrivia(s, keyEnd);
    if (s[colon] !== ':') throw new Error('malformed JSON in OpenCode config');
    const valueStart = skipTrivia(s, colon + 1);
    let valueEnd: number;
    const c = s[valueStart];
    if (c === '"') valueEnd = scanString(s, valueStart);
    else if (c === '{' || c === '[') valueEnd = scanComposite(s, valueStart);
    else {
      valueEnd = valueStart;
      while (valueEnd < s.length && !',}]'.includes(s[valueEnd]) && !' \t\r\n'.includes(s[valueEnd])) valueEnd++;
    }
    if (name === key) return { keyStart: i, valueStart, valueEnd };
    i = skipTrivia(s, valueEnd);
    if (s[i] === ',') i = skipTrivia(s, i + 1);
  }
  return null;
}

/** Whether the object body between `start` and `end` has at least one property. */
function bodyHasProps(s: string, start: number, end: number): boolean {
  let i = skipTrivia(s, start);
  while (i < end && (s[i] === ',' || s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) {
    i = skipTrivia(s, i + (s[i] === ',' ? 1 : 0));
  }
  return i < end && s[i] === '"';
}

// --- managed block --------------------------------------------------------

function stripManaged(text: string): string {
  const start = text.indexOf(MARK_START);
  if (start === -1) return text;
  const end = text.indexOf(MARK_END, start);
  if (end === -1) return text;
  return text.slice(0, start) + text.slice(end + MARK_END.length);
}

export function isWired(text: string): boolean {
  return text.includes(MARK_START);
}

function providerHasBrick(text: string): boolean {
  const rootStart = skipTrivia(text, 0);
  if (text[rootStart] !== '{') return false;
  const provider = findProp(text, rootStart, 'provider');
  if (!provider || text[provider.valueStart] !== '{') return false;
  return findProp(text, provider.valueStart, 'brick') !== null;
}

/** A `provider.brick` entry that Brick did not write (no managed marker). */
export function hasUnmanagedBrickProvider(text: string): boolean {
  return providerHasBrick(stripManaged(text));
}

function brickValue(baseUrl: string, models: OpencodeModel[]): Record<string, unknown> {
  const url = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('OpenCode router must use a loopback URL');
  }
  const root = baseUrl.replace(/\/+$/, '');
  const modelMap: Record<string, { name: string }> = {};
  for (const m of models) modelMap[m.id] = { name: m.label ?? m.id };
  if (!modelMap['brick']) modelMap['brick'] = { name: 'Brick (local router)' };
  return { npm: '@ai-sdk/openai', options: { baseURL: `${root}/v1` }, models: modelMap };
}

interface InsertResult {
  text: string;
  providerExisted: boolean;
}

function insertManaged(base: string, brickJson: string): InsertResult {
  let text = base;
  let rootStart = skipTrivia(text, 0);
  if (text[rootStart] !== '{') {
    text = '{}';
    rootStart = 0;
  }
  const provider = findProp(text, rootStart, 'provider');
  if (provider) {
    if (text[provider.valueStart] !== '{') throw new Error('the `provider` key in the OpenCode config is not an object');
    const bodyStart = provider.valueStart + 1;
    const needComma = bodyHasProps(text, bodyStart, provider.valueEnd - 1);
    const managed = MARK_START + '"brick":' + brickJson + (needComma ? ',' : '') + MARK_END;
    return {
      text: text.slice(0, bodyStart) + managed + text.slice(bodyStart),
      providerExisted: true,
    };
  }
  const needComma = bodyHasProps(text, rootStart + 1, scanComposite(text, rootStart) - 1);
  const chunk = `"provider":{${MARK_START}"brick":${brickJson}${MARK_END}}` + (needComma ? ',' : '');
  return { text: text.slice(0, rootStart + 1) + chunk + text.slice(rootStart + 1), providerExisted: false };
}

function removeRootProp(text: string, key: string): string {
  const rootStart = skipTrivia(text, 0);
  if (text[rootStart] !== '{') return text;
  const prop = findProp(text, rootStart, key);
  if (!prop) return text;
  let end = prop.valueEnd;
  let i = skipTrivia(text, end);
  if (text[i] === ',') {
    end = i + 1;
    return text.slice(0, prop.keyStart) + text.slice(end);
  }
  // Last property: drop the separator that precedes it.
  let j = prop.keyStart - 1;
  while (j >= 0 && ' \t\r\n'.includes(text[j])) j--;
  if (text[j] === ',') return text.slice(0, j) + text.slice(prop.valueEnd);
  return text.slice(0, prop.keyStart) + text.slice(end);
}

/**
 * Point OpenCode at the local Brick router by writing `provider.brick`
 * (`npm`, `options.baseURL`, `models`). Idempotent: re-running replaces only the
 * managed block. Refuses an existing unmanaged `provider.brick`.
 */
export function wireOpencode(baseUrl: string, models: OpencodeModel[]): OpencodeWireResult {
  const createdFile = !existsSync(opencodeConfigPath());
  const original = readOpencodeConfig();
  const base = stripManaged(original);
  if (providerHasBrick(base)) {
    throw new Error(
      'found an existing unmanaged provider.brick in the OpenCode config. ' +
      'rename or remove it before running `brick connect opencode`.'
    );
  }
  const brickJson = JSON.stringify(brickValue(baseUrl, models), null, 2);
  const { text, providerExisted } = insertManaged(base, brickJson);
  if (text !== original) writeOpencodeConfig(text);
  return { createdFile, providerExisted };
}

/**
 * Remove the managed `provider.brick` block, dropping the whole `provider`
 * object when wiring created it, so the config returns to its previous state.
 */
export function unwireOpencode(state: OpencodeUnwireState): void {
  const path = opencodeConfigPath();
  if (!existsSync(path)) return;
  let text = stripManaged(readOpencodeConfig());
  if (!state.providerExisted) text = removeRootProp(text, 'provider');
  const compact = text.replace(/\s+/g, '');
  if (state.createdFile && (compact === '' || compact === '{}')) {
    rmSync(path, { force: true });
    return;
  }
  writeOpencodeConfig(text);
}
