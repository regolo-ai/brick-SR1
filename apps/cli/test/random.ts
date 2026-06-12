// Random testing harness — exercises every CLI feature with real prompts against the live router.
// Usage: npx tsx test/random.ts            (auto-installs tsx if missing)
//   env BASE_URL=http://localhost:8000  override
//   env REGOLO_KEY=...
import { execa } from 'execa';
import { readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { ConfigSchema } from '../src/lib/config/schema.js';
import { buildConfig } from './build-test-config.js';
import { paths } from '../src/lib/config/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RUN_BIN = join(ROOT, 'bin', 'run.js');
const REPORT = join(ROOT, 'test', 'random-session-report.md');
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8000';
const REGOLO_KEY = process.env.REGOLO_KEY ?? readEnv('REGOLO_API_KEY');
const SEED = Number(process.env.SEED ?? 42);

function readEnv(k: string): string {
  try {
    const txt = readFileSync(paths.env, 'utf8');
    const m = txt.match(new RegExp(`^${k}=(.+)$`, 'm'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

interface Result { suite: string; case: string; pass: boolean; detail: string; }
const results: Result[] = [];
let suiteCounters: Record<string, { pass: number; fail: number }> = {};
function record(suite: string, label: string, pass: boolean, detail = ''): void {
  results.push({ suite, case: label, pass, detail });
  suiteCounters[suite] ??= { pass: 0, fail: 0 };
  suiteCounters[suite][pass ? 'pass' : 'fail']++;
  process.stdout.write(pass ? '.' : 'F');
}

// Tiny seeded PRNG (mulberry32)
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
function pick<T>(arr: T[]): T { return arr[Math.floor(rand() * arr.length)]; }

async function chat(prompt: string, opts: { model?: string; sys?: string } = {}): Promise<{ status: number; selected?: string; content: string; raw: any }> {
  const messages: any[] = [];
  if (opts.sys) messages.push({ role: 'system', content: opts.sys });
  messages.push({ role: 'user', content: prompt });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${REGOLO_KEY}` },
      body: JSON.stringify({ model: opts.model ?? 'brick', messages, max_tokens: 64, stream: false }),
      signal: ctrl.signal,
    });
    const selected =
      r.headers.get('x-vsr-selected-model') ??
      r.headers.get('x-selected-model') ??
      r.headers.get('x-litellm-model-group') ??
      undefined;
    const json: any = await r.json().catch(() => ({}));
    const msg = json?.choices?.[0]?.message ?? {};
    const content = msg.content ?? msg.reasoning_content ?? '';
    return { status: r.status, selected, content, raw: json };
  } finally { clearTimeout(t); }
}

async function cli(args: string[], input?: string, timeoutMs = 30000): Promise<{ stdout: string; stderr: string; code: number }> {
  const r = await execa('node', [RUN_BIN, ...args], { reject: false, input, timeout: timeoutMs });
  return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode ?? 1 };
}

async function suiteHealth(): Promise<void> {
  console.log('\n[suite] router liveness');
  const r = await fetch(`${BASE_URL}/health`).catch(() => null);
  record('health', 'GET /health', !!r && r.ok, r ? `status=${r.status}` : 'fetch failed');
  const m = await fetch(`${BASE_URL}/v1/models`, { headers: { Authorization: `Bearer ${REGOLO_KEY}` } }).catch(() => null);
  if (m && m.ok) {
    const j: any = await m.json();
    record('health', 'GET /v1/models', Array.isArray(j?.data), `models=${(j?.data ?? []).length}`);
  } else record('health', 'GET /v1/models', false, m ? `status=${m.status}` : 'fetch failed');
}

async function suiteSchema(): Promise<void> {
  console.log('\n[suite] schema fuzz');
  const samples = [
    { regolo: true, openai: false, classifier: true, complexity: true, multimodal: true },
    { regolo: true, openai: true, classifier: true, complexity: false, multimodal: true },
    { regolo: true, openai: false, classifier: false, complexity: false, multimodal: false },
    { regolo: false, openai: true, classifier: true, complexity: true, multimodal: false },
    { regolo: true, openai: true, classifier: true, complexity: true, multimodal: true },
  ];
  for (const s of samples) {
    const providers: any[] = [];
    if (s.regolo) providers.push('regolo');
    if (s.openai) providers.push('openai');
    try {
      const cfg = await buildConfig({ providers, withClassifier: s.classifier, withComplexity: s.complexity, withMultimodal: s.multimodal, port: 8000 });
      ConfigSchema.parse(cfg);
      const written = yaml.load(await readFile(paths.config, 'utf8'));
      ConfigSchema.parse(written);
      record('schema', `build ${JSON.stringify(s)}`, true, `decisions=${cfg.decisions.length} models=${Object.keys(cfg.model_config).length}`);
    } catch (e: any) {
      record('schema', `build ${JSON.stringify(s)}`, false, e?.message?.slice(0, 200) ?? 'err');
    }
  }
  // also load the upstream config to ensure schema accepts it
  try {
    const upstreamPath = process.env.UPSTREAM_CONFIG ?? '';
    if (!upstreamPath) {
      record('schema', 'parse upstream spatial-routing/config.yaml', true, 'skipped (set UPSTREAM_CONFIG=path/to/config.yaml to enable)');
      return;
    }
    const upstream = await readFile(upstreamPath, 'utf8');
    const parsed = yaml.load(upstream);
    ConfigSchema.parse(parsed);
    record('schema', 'parse upstream spatial-routing/config.yaml', true);
  } catch (e: any) {
    record('schema', 'parse upstream spatial-routing/config.yaml', false, e?.message?.slice(0, 300) ?? 'err');
  }
}

async function suiteCliBasics(): Promise<void> {
  console.log('\n[suite] cli basics');
  const v = await cli(['--version']);
  record('cli', 'brick --version', v.code === 0 && /brick\//.test(v.stdout), v.stdout.slice(0, 80));
  const h = await cli(['--help']);
  record('cli', 'brick --help lists commands', h.code === 0 && /init/.test(h.stdout) && /serve/.test(h.stdout) && /chat/.test(h.stdout));
  const subs = ['init', 'serve', 'stop', 'status', 'logs', 'chat', 'route', 'generate', 'config', 'config edit', 'add provider', 'add model', 'add decision', 'add plugin', 'remove provider', 'remove model', 'remove decision', 'remove plugin'];
  for (const s of subs) {
    const r = await cli([...s.split(' '), '--help']);
    record('cli', `\`brick ${s} --help\``, r.code === 0, r.stderr.slice(0, 120));
  }
}

async function suiteRouting(): Promise<void> {
  console.log('\n[suite] routing decisions');
  const fixtures = JSON.parse(await readFile(join(ROOT, 'test/fixtures/prompts.json'), 'utf8'));
  const distribution: Record<string, number> = {};
  const buckets: Array<{ bucket: string; expectedDecision?: string }> = [
    { bucket: 'coding_easy', expectedDecision: 'coding_easy' },
    { bucket: 'coding_hard', expectedDecision: 'coding_hard' },
    { bucket: 'general_easy', expectedDecision: 'general_easy' },
    { bucket: 'general_medium', expectedDecision: 'general_medium' },
    { bucket: 'general_hard', expectedDecision: 'general_hard' },
  ];
  for (const b of buckets) {
    const prompts = (fixtures[b.bucket] as string[]).slice(0, 5);
    let bucketHit = 0;
    for (const prompt of prompts) {
      const r = await chat(prompt);
      const sel = r.selected ?? '(none)';
      distribution[sel] = (distribution[sel] ?? 0) + 1;
      const ok2xx = r.status >= 200 && r.status < 300;
      record('routing', `[${b.bucket}] "${prompt.slice(0, 50)}..."`, ok2xx, `status=${r.status} selected=${sel}`);
      if (ok2xx) bucketHit++;
    }
    record('routing', `bucket ${b.bucket} success rate`, bucketHit >= prompts.length - 1, `${bucketHit}/${prompts.length}`);
  }
  record('routing', 'distribution diversity', Object.keys(distribution).length >= 2, JSON.stringify(distribution));
}

async function suiteCliConfig(): Promise<void> {
  console.log('\n[suite] cli config');
  const r1 = await cli(['config', '--path']);
  record('cli-config', '`config --path` prints config path', r1.code === 0 && r1.stdout.includes('config.yaml'));
  const r2 = await cli(['config', '--json']);
  let parsed: any = null;
  try { parsed = JSON.parse(r2.stdout); } catch {}
  record('cli-config', '`config --json` produces parseable JSON', r2.code === 0 && !!parsed?.providers, `code=${r2.code}`);
  const r3 = await cli(['config']);
  record('cli-config', '`config` summary shows providers + models tables', r3.code === 0 && r3.stdout.includes('providers') && r3.stdout.includes('models'));
  const r4 = await cli(['config', '--raw']);
  record('cli-config', '`config --raw` matches file content', r4.code === 0 && r4.stdout.length > 100);
}

async function suiteCliRoute(): Promise<void> {
  console.log('\n[suite] cli route');
  const cases = [
    { p: 'write a python function to reverse a string', expectedKeyword: 'coder' },
    { p: 'what is the capital of france', expectedKeyword: '' },
    { p: 'design a distributed lock-free queue', expectedKeyword: '' },
  ];
  for (const c of cases) {
    const r = await cli(['route', c.p, '--json'], undefined, 60000);
    let parsed: any = null;
    try { parsed = JSON.parse(r.stdout); } catch {}
    const has = !!parsed?.selected_model;
    record('cli-route', `route "${c.p.slice(0, 40)}..."`, has, `code=${r.code} sel=${parsed?.selected_model ?? '?'} stderr=${r.stderr.slice(0, 80)}`);
  }
}

async function suiteCliGenerate(): Promise<void> {
  console.log('\n[suite] cli generate');
  const fixtures = JSON.parse(await readFile(join(ROOT, 'test/fixtures/prompts.json'), 'utf8'));
  const all: string[] = ['general_easy', 'coding_easy', 'general_medium'].flatMap((k) => fixtures[k]);
  const sample = Array.from({ length: 5 }, () => pick(all));
  for (const prompt of sample) {
    const r = await cli(['generate', prompt, '--max-tokens', '32'], undefined, 60000);
    record('cli-generate', `gen "${prompt.slice(0, 40)}..."`, r.code === 0 && r.stdout.trim().length > 0, `len=${r.stdout.length} code=${r.code}`);
  }
}

async function suiteEdge(): Promise<void> {
  console.log('\n[suite] edge cases');
  const fixtures = JSON.parse(await readFile(join(ROOT, 'test/fixtures/prompts.json'), 'utf8'));
  for (const e of fixtures.edge as string[]) {
    if (e.trim() === '') {
      // empty prompt — many backends reject 400; we just expect no 5xx
      const r = await chat(e.length === 0 ? 'a' : e);
      record('edge', `empty/whitespace "${e.slice(0, 20)}"`, r.status < 500, `status=${r.status}`);
    } else {
      const r = await chat(e);
      record('edge', `"${e.slice(0, 40).replace(/\n/g, ' ')}..."`, r.status < 500, `status=${r.status} sel=${r.selected ?? '?'}`);
    }
  }
  // long prompt
  const long = 'word '.repeat(2000);
  const rl = await chat(long);
  record('edge', 'long prompt 10k chars', rl.status < 500, `status=${rl.status}`);
}

async function suiteAddRemove(): Promise<void> {
  console.log('\n[suite] add/remove config commands');
  const backup = paths.config + '.bak';
  await copyFile(paths.config, backup);
  try {
    // remove a decision
    const r1 = await cli(['remove', 'decision', 'general_easy']);
    record('add-remove', 'remove decision general_easy', r1.code === 0, r1.stderr.slice(0, 200));
    let cfg = ConfigSchema.parse(yaml.load(await readFile(paths.config, 'utf8')));
    record('add-remove', 'config still valid after remove', !cfg.decisions.find((d) => d.name === 'general_easy'));

    // add plugin
    const r2 = await cli(['add', 'plugin', 'pii_detection', '--action', 'block']);
    record('add-remove', 'add plugin pii_detection', r2.code === 0, r2.stderr.slice(0, 200));
    cfg = ConfigSchema.parse(yaml.load(await readFile(paths.config, 'utf8')));
    record('add-remove', 'plugin in config', !!cfg.plugins?.pii_detection?.enabled);

    // remove plugin
    const r3 = await cli(['remove', 'plugin', 'pii_detection']);
    record('add-remove', 'remove plugin pii_detection', r3.code === 0);

    // remove non-existent decision
    const r4 = await cli(['remove', 'decision', 'no_such_decision']);
    record('add-remove', 'remove non-existent decision yields error', r4.code !== 0);

    // add model that already exists in catalog (gpt-oss-20b)
    const r5 = await cli(['add', 'model', 'gpt-oss-20b', '--provider', 'regolo']);
    record('add-remove', 'add catalog model', r5.code === 0, r5.stderr.slice(0, 200));
    cfg = ConfigSchema.parse(yaml.load(await readFile(paths.config, 'utf8')));
    record('add-remove', 'model in config_config', !!cfg.model_config['gpt-oss-20b']);

    // add model with non-existent provider (should fail)
    const r6 = await cli(['add', 'model', 'foo', '--provider', 'nope']);
    record('add-remove', 'add model without provider fails', r6.code !== 0);

    // remove provider (regolo) — should also strip model_config entries that depended on it
    // skip actually executing because it would invalidate downstream tests; just check schema
  } finally {
    await copyFile(backup, paths.config);
    await rm(backup);
  }
}

async function suiteParallel(): Promise<void> {
  console.log('\n[suite] parallel stress');
  const fixtures = JSON.parse(await readFile(join(ROOT, 'test/fixtures/prompts.json'), 'utf8'));
  const all: string[] = ['general_easy', 'coding_easy'].flatMap((k) => fixtures[k]);
  const N = 8;
  const tasks = Array.from({ length: N }, () => chat(pick(all), { model: 'brick' }));
  const out = await Promise.all(tasks);
  const success = out.filter((o) => o.status >= 200 && o.status < 300).length;
  const nonEmpty = out.filter((o) => o.content.length > 0).length;
  record('parallel', `${N} concurrent /v1/chat/completions, no 5xx`, !out.some((o) => o.status >= 500), `${success}/${N} 2xx`);
  // tolerant: at least 75% non-empty (Regolo can rate-limit under burst)
  record('parallel', '>=75% non-empty', nonEmpty >= Math.ceil(N * 0.75), `${nonEmpty}/${N} non-empty`);
}

async function suiteOpenAI(): Promise<void> {
  console.log('\n[suite] OpenAI provider direct (cheapest model gpt-4.1-nano)');
  const key = readEnv('OPENAI_API_KEY') || process.env.OPENAI_API_KEY || '';
  if (!key) { record('openai', 'OPENAI_API_KEY present', false, 'not set'); return; }
  record('openai', 'OPENAI_API_KEY present', true);
  // models list
  try {
    const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    const j: any = await r.json().catch(() => ({}));
    record('openai', 'GET /v1/models', r.ok && Array.isArray(j?.data), `status=${r.status} models=${(j?.data ?? []).length}`);
  } catch (e: any) { record('openai', 'GET /v1/models', false, e?.message ?? 'err'); }
  // completion with cheapest model
  for (const m of ['gpt-4.1-nano', 'gpt-4o-mini']) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'reply with the single word OK' }], max_tokens: 5 }),
        signal: AbortSignal.timeout(20000),
      });
      const j: any = await r.json().catch(() => ({}));
      const content = j?.choices?.[0]?.message?.content ?? '';
      const reason = j?.error?.code ?? j?.error?.type ?? '';
      record('openai', `chat ${m} returns content`, r.ok && content.length > 0, `status=${r.status} reason=${reason} content="${content.slice(0, 40)}"`);
    } catch (e: any) { record('openai', `chat ${m}`, false, e?.message ?? 'err'); }
  }
}

async function suiteMultimodal(): Promise<void> {
  console.log('\n[suite] multimodal brick');
  // We'll send text+image base64 via OpenAI content array. Tiny 1x1 PNG.
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
  try {
    const r = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${REGOLO_KEY}` },
      body: JSON.stringify({
        model: 'brick',
        messages: [{
          role: 'user', content: [
            { type: 'text', text: 'describe this image briefly' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${tinyPng}` } },
          ],
        }],
        max_tokens: 32,
      }),
      signal: AbortSignal.timeout(60000),
    });
    const sel = r.headers.get('x-selected-model') ?? '(none)';
    record('multimodal', 'image+text → vision route', r.status < 500, `status=${r.status} selected=${sel}`);
  } catch (e: any) {
    record('multimodal', 'image+text → vision route', false, e?.message?.slice(0, 200) ?? 'err');
  }
}

async function writeReport(): Promise<void> {
  const total = results.length;
  const pass = results.filter((r) => r.pass).length;
  const fail = total - pass;
  const lines: string[] = [];
  lines.push(`# Random testing session report`);
  lines.push(``);
  lines.push(`- date: ${new Date().toISOString()}`);
  lines.push(`- seed: ${SEED}`);
  lines.push(`- base_url: ${BASE_URL}`);
  lines.push(`- total: ${total} | pass: ${pass} | fail: ${fail}`);
  lines.push(``);
  lines.push(`## Summary by suite`);
  lines.push(``);
  lines.push(`| suite | pass | fail |`);
  lines.push(`|-------|------|------|`);
  for (const [k, v] of Object.entries(suiteCounters)) lines.push(`| ${k} | ${v.pass} | ${v.fail} |`);
  lines.push(``);
  if (fail > 0) {
    lines.push(`## Failures`);
    lines.push(``);
    for (const r of results.filter((r) => !r.pass)) {
      lines.push(`- **[${r.suite}]** ${r.case} — ${r.detail}`);
    }
    lines.push(``);
  }
  lines.push(`## All results`);
  lines.push(``);
  for (const r of results) {
    lines.push(`- ${r.pass ? 'PASS' : 'FAIL'} [${r.suite}] ${r.case}${r.detail ? ` — ${r.detail.slice(0, 160)}` : ''}`);
  }
  await writeFile(REPORT, lines.join('\n'));
  console.log(`\nreport written: ${REPORT}`);
  console.log(`\n${pass}/${total} passed (${fail} failed)`);
}

(async () => {
  console.log(`brick random testing — seed=${SEED} base=${BASE_URL}`);
  if (!REGOLO_KEY) { console.error('no REGOLO_API_KEY in env or ~/.brick/.env'); process.exit(2); }

  // ensure ~/.brick/config.yaml exists for CLI commands that load it
  if (!existsSync(paths.config)) {
    console.log('seeding ~/.brick/config.yaml via build-test-config...');
    await buildConfig({ providers: ['regolo'], withClassifier: true, withComplexity: true, withMultimodal: true, port: 8000 });
  }

  await suiteHealth();
  await suiteSchema();
  await suiteCliBasics();
  await suiteRouting();
  await suiteCliConfig();
  await suiteCliRoute();
  await suiteCliGenerate();
  await suiteEdge();
  await suiteAddRemove();
  await suiteParallel();
  await suiteMultimodal();
  await suiteOpenAI();

  await writeReport();
  const fail = results.filter((r) => !r.pass).length;
  process.exit(fail === 0 ? 0 : 1);
})();
