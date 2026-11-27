import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import {
  readOpencodeWiring,
  writeOpencodeWiring,
  clearOpencodeWiring,
  type OpencodeWiringState,
} from './wiring-state.js';

// Minimal, dependency-free JSONC editor for ~/.config/opencode/opencode.json.
//
// Brick owns exactly one provider entry, fenced by comment markers. Comments and
// third-party keys are preserved because every edit is a surgical splice: we
// parse the document only to learn source offsets, never to re-serialize it.

export const MANAGED_BEGIN = '// >>> brick opencode managed provider (do not edit) >>>';
export const MANAGED_END = '// <<< brick opencode managed provider <<<';

const INDENT = '  ';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** OpenCode's global config lives at ~/.config/opencode/opencode.json. */
export function opencodeConfigPath(): string {
  return join(homedir(), '.config', 'opencode', 'opencode.json');
}

export interface JsoncMember {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
  /** Offset just after the member's comma, or null for the last member. */
  commaEnd: number | null;
}

export interface JsoncValue {
  type: 'object' | 'array' | 'string' | 'number' | 'literal';
  start: number;
  end: number;
}

export interface JsoncObject extends JsoncValue {
  type: 'object';
  members: JsoncMember[];
}

class JsoncParser {
  private i = 0;

  constructor(private readonly src: string) {}

  private skipTrivia(): void {
    const s = this.src;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.i++;
        continue;
      }
      if (c === '/' && s[this.i + 1] === '/') {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
        continue;
      }
      if (c === '/' && s[this.i + 1] === '*') {
        const close = s.indexOf('*/', this.i + 2);
        this.i = close < 0 ? s.length : close + 2;
        continue;
      }
      break;
    }
  }

  parseDocument(): JsoncValue {
    this.skipTrivia();
    const value = this.parseValue();
    this.skipTrivia();
    if (this.i !== this.src.length) {
      throw new Error(`unexpected trailing content at offset ${this.i}`);
    }
    return value;
  }

  /** Parse a single value starting at `offset`, keeping offsets absolute. */
  parseValueAt(offset: number): JsoncValue {
    this.i = offset;
    return this.parseValue();
  }

  private parseValue(): JsoncValue {
    this.skipTrivia();
    const c = this.src[this.i];
    if (c === '{') return this.parseObject();
    if (c === '[') return this.parseArray();
    if (c === '"') {
      const start = this.i;
      this.parseString();
      return { type: 'string', start, end: this.i };
    }
    const start = this.i;
    while (this.i < this.src.length && !/[\s,\]}/]/.test(this.src[this.i])) this.i++;
    if (this.i === start) throw new Error(`unexpected token at offset ${this.i}`);
    return { type: 'literal', start, end: this.i };
  }

  private parseString(): string {
    const start = this.i;
    let j = start + 1;
    while (j < this.src.length) {
      if (this.src[j] === '\\') {
        j += 2;
        continue;
      }
      if (this.src[j] === '"') break;
      j++;
    }
    if (j >= this.src.length) throw new Error(`unterminated string at offset ${start}`);
    this.i = j + 1;
    return JSON.parse(this.src.slice(start, this.i)) as string;
  }

  private parseObject(): JsoncObject {
    const start = this.i;
    this.i++;
    const members: JsoncMember[] = [];
    this.skipTrivia();
    if (this.src[this.i] === '}') {
      this.i++;
      return { type: 'object', start, end: this.i, members };
    }
    for (;;) {
      this.skipTrivia();
      const keyStart = this.i;
      if (this.src[this.i] !== '"') throw new Error(`expected object key at offset ${this.i}`);
      const key = this.parseString();
      this.skipTrivia();
      if (this.src[this.i] !== ':') throw new Error(`expected ':' at offset ${this.i}`);
      this.i++;
      const value = this.parseValue();
      this.skipTrivia();
      let commaEnd: number | null = null;
      if (this.src[this.i] === ',') {
        this.i++;
        commaEnd = this.i;
      }
      members.push({ key, keyStart, valueStart: value.start, valueEnd: value.end, commaEnd });
      if (commaEnd === null) break;
    }
    this.skipTrivia();
    if (this.src[this.i] !== '}') throw new Error(`expected '}' at offset ${this.i}`);
    this.i++;
    return { type: 'object', start, end: this.i, members };
  }

  private parseArray(): JsoncValue {
    const start = this.i;
    this.i++;
    this.skipTrivia();
    if (this.src[this.i] === ']') {
      this.i++;
      return { type: 'array', start, end: this.i };
    }
    for (;;) {
      this.parseValue();
      this.skipTrivia();
      if (this.src[this.i] === ',') {
        this.i++;
        continue;
      }
      break;
    }
    this.skipTrivia();
    if (this.src[this.i] !== ']') throw new Error(`expected ']' at offset ${this.i}`);
    this.i++;
    return { type: 'array', start, end: this.i };
  }
}

export function parseJsonc(text: string): JsoncValue {
  return new JsoncParser(text).parseDocument();
}

/**
 * Parse the JSONC value that starts at `offset` in `text`. Returned offsets are
 * absolute within `text`, so the result can be fed straight back to the
 * surgical splice helpers. Never re-serializes anything.
 */
export function parseJsoncAt(text: string, offset: number): JsoncValue {
  return new JsoncParser(text).parseValueAt(offset);
}

function isJsoncObject(value: JsoncValue): value is JsoncObject {
  return value.type === 'object';
}

function asObject(value: JsoncValue, what: string): JsoncObject {
  if (!isJsoncObject(value)) throw new Error(`${what} must be a JSON object`);
  return value;
}

function findMember(obj: JsoncObject, key: string): JsoncMember | undefined {
  return obj.members.find((m) => m.key === key);
}

function indentOf(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const match = /^[ \t]*/.exec(text.slice(lineStart, offset));
  return match ? match[0] : '';
}

function indentLines(lines: readonly string[], indent: string): string {
  return lines.map((line) => (line === '' ? line : indent + line)).join('\n');
}

/** Remove a member, keeping the rest of the document byte-identical. */
function removeMember(text: string, obj: JsoncObject, member: JsoncMember): string {
  const idx = obj.members.indexOf(member);
  if (idx < 0) return text;
  if (idx + 1 < obj.members.length) {
    // Not the last member: drop it together with its own trailing comma.
    const prevEnd = idx === 0 ? obj.start + 1 : obj.members[idx - 1].commaEnd ?? obj.members[idx - 1].valueEnd;
    return text.slice(0, prevEnd) + text.slice(member.commaEnd ?? member.valueEnd);
  }
  // Last member: drop it together with the comma that separated it from its predecessor.
  const start = idx === 0 ? obj.start + 1 : (obj.members[idx - 1].commaEnd ?? obj.members[idx - 1].valueEnd) - 1;
  return text.slice(0, start) + text.slice(member.valueEnd);
}

/** Insert an already-indented member as the last entry of `obj`. */
function insertMember(text: string, obj: JsoncObject, member: string): string {
  const closeIndent = indentOf(text, obj.start);
  if (obj.members.length === 0) {
    return `${text.slice(0, obj.start + 1)}\n${member}\n${closeIndent}${text.slice(obj.end - 1)}`;
  }
  const last = obj.members[obj.members.length - 1];
  const at = last.valueEnd;
  const multiline = text.slice(at, obj.end - 1).includes('\n');
  const suffix = multiline ? '' : `\n${closeIndent}`;
  return `${text.slice(0, at)},\n${member}${suffix}${text.slice(at)}`;
}

/**
 * Remove the fenced managed region, including the comma and newline Brick
 * inserted with it, so a re-wire reproduces the same bytes.
 */
export function stripManagedBlock(text: string): string {
  const begin = text.indexOf(MANAGED_BEGIN);
  if (begin < 0) return text;
  const end = text.indexOf(MANAGED_END, begin);
  if (end < 0) throw new Error('opencode.json has an unterminated brick managed block');
  const endEnd = end + MANAGED_END.length;

  let head = text.slice(0, begin);
  let tail = text.slice(endEnd);
  // Drop the indentation that introduced the BEGIN marker.
  head = head.replace(/[ \t]*$/, '');
  // Drop the comma Brick added in front of the block (the newline stays).
  head = head.replace(/,(\r?\n[ \t]*)$/, '$1');
  // Drop the newline Brick added after the END marker.
  tail = tail.replace(/^[ \t]*\r?\n/, '');
  return head + tail;
}

/** Whether the managed brick provider block is present. */
export function isWired(text: string): boolean {
  return text.includes(MANAGED_BEGIN);
}

/** A `brick` provider that Brick did not write: refuse to overwrite it. */
export function hasUnmanagedBrickProvider(text: string): boolean {
  let stripped: string;
  try {
    stripped = stripManagedBlock(text);
  } catch {
    return true;
  }
  if (stripped.trim() === '') return false;
  let doc: JsoncValue;
  try {
    doc = parseJsonc(stripped);
  } catch {
    return true;
  }
  if (!isJsoncObject(doc)) return true;
  const provider = findMember(doc, 'provider');
  if (!provider) return false;
  try {
    const value = parseJsonc(stripped.slice(provider.valueStart, provider.valueEnd));
    return isJsoncObject(value) && findMember(value, 'brick') !== undefined;
  } catch {
    return true;
  }
}

function normalizeModels(models: readonly string[]): string[] {
  const out: string[] = [];
  for (const model of models) {
    const id = model.trim();
    if (id !== '' && !out.includes(id)) out.push(id);
  }
  if (!out.includes('brick')) out.push('brick');
  return out;
}

function loopbackBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`invalid router URL '${baseUrl}'`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('OpenCode router must use a loopback URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OpenCode router must use an http(s) URL');
  }
  const root = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  return root.endsWith('/v1') ? root : `${root}/v1`;
}

function brickMemberLines(baseUrl: string, models: readonly string[]): string[] {
  const lines = [
    MANAGED_BEGIN,
    '"brick": {',
    `${INDENT}"npm": "@ai-sdk/openai",`,
    `${INDENT}"name": "Brick (local router)",`,
    `${INDENT}"options": {`,
    `${INDENT}${INDENT}"baseURL": ${JSON.stringify(loopbackBaseUrl(baseUrl))}`,
    `${INDENT}},`,
    `${INDENT}"models": {`,
  ];
  models.forEach((model, i) => {
    lines.push(`${INDENT}${INDENT}${JSON.stringify(model)}: {}${i === models.length - 1 ? '' : ','}`);
  });
  lines.push(`${INDENT}}`, '}', MANAGED_END);
  return lines;
}

function providerLines(baseUrl: string, models: readonly string[]): string[] {
  return ['"provider": {', ...brickMemberLines(baseUrl, models).map((line) => INDENT + line), '}'];
}

function readConfig(): string {
  const path = opencodeConfigPath();
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

function writeConfig(text: string): void {
  const path = opencodeConfigPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.brick.tmp`;
  const out = text.endsWith('\n') ? text : `${text}\n`;
  writeFileSync(tmp, out, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export interface OpencodeWireResult extends OpencodeWiringState {}

/**
 * Point OpenCode's global config at the local Brick router by writing a managed
 * `provider.brick` entry. Idempotent: re-running produces the same bytes and
 * keeps the originally captured `provider` value for `disconnect`.
 */
export function wireOpencode(baseUrl: string, models: readonly string[] = ['brick']): OpencodeWireResult {
  const baseURL = loopbackBaseUrl(baseUrl);
  const routerRoot = baseURL.slice(0, -'/v1'.length);
  const ids = normalizeModels(models);
  const path = opencodeConfigPath();
  const original = readConfig();
  const existing = readOpencodeWiring();

  const stripped = stripManagedBlock(original);
  if (hasUnmanagedBrickProvider(original)) {
    throw new Error(
      'found an existing unmanaged provider.brick in opencode.json. ' +
        'rename or remove it before running `brick start opencode`.',
    );
  }

  const base = stripped.trim() === '' ? '{}' : stripped;
  const root = asObject(parseJsonc(base), 'opencode.json');

  const provider = findMember(root, 'provider');
  const previousProviderRaw = existing
    ? existing.previousProviderRaw
    : provider
      ? base.slice(provider.valueStart, provider.valueEnd)
      : null;
  const createdFile = existing ? existing.createdFile : !existsSync(path);

  let text: string;
  if (!provider) {
    text = insertMember(base, root, indentLines(providerLines(baseUrl, ids), indentOf(base, root.start) + INDENT));
  } else {
    const providerObj = asObject(
      parseJsoncAt(base, provider.valueStart),
      'provider',
    );
    text = insertMember(
      base,
      providerObj,
      indentLines(brickMemberLines(baseUrl, ids), indentOf(base, providerObj.start) + INDENT),
    );
  }

  writeConfig(text);

  const state: OpencodeWiringState = {
    wired: true,
    baseUrl: routerRoot,
    configPath: path,
    previousProviderRaw,
    createdFile,
    models: ids,
  };
  writeOpencodeWiring(state);
  return state;
}

/**
 * Remove the managed provider and restore the previous `provider` value.
 * When Brick created opencode.json and nothing else is left, the file is removed.
 */
export function unwireOpencode(state: OpencodeWiringState | null = readOpencodeWiring()): void {
  const path = opencodeConfigPath();
  const current = readConfig();
  if (current.trim() === '') {
    clearOpencodeWiring();
    return;
  }

  let text = stripManagedBlock(current);
  const root = asObject(parseJsonc(text), 'opencode.json');
  const provider = findMember(root, 'provider');
  const previous = state?.previousProviderRaw ?? null;

  if (previous === null) {
    if (provider) {
      const value = parseJsonc(text.slice(provider.valueStart, provider.valueEnd));
      if (isJsoncObject(value) && value.members.length === 0) {
        text = removeMember(text, root, provider);
      }
    }
  } else if (provider) {
    text = text.slice(0, provider.valueStart) + previous + text.slice(provider.valueEnd);
  } else {
    text = insertMember(
      text,
      root,
      indentLines([`"provider": ${previous}`], indentOf(text, root.start) + INDENT),
    );
  }

  const after = asObject(parseJsonc(text), 'opencode.json');
  if (state?.createdFile && after.members.length === 0) {
    if (existsSync(path)) rmSync(path);
  } else {
    writeConfig(text);
  }
  // Keep a `wired: false` tombstone instead of deleting the state file, so the
  // runtime directory survives a disconnect and `readOpencodeWiring` still
  // reports null (a tombstone is not a live wiring).
  if (state) writeOpencodeWiring({ ...state, wired: false });
  else clearOpencodeWiring();
}
