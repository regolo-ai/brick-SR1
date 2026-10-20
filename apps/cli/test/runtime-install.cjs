const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brick-installer-'));
  const originalFetch = global.fetch;
  const previousPython = process.env.BRICK_SYSTEMONE_PYTHON;
  process.env.BRICK_SYSTEMONE_PYTHON = path.join(root, 'fake-python');
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'assets'));
    fs.copyFileSync(path.join(__dirname, '../scripts/runtime-install.cjs'), path.join(root, 'scripts/runtime-install.cjs'));
    fs.copyFileSync(path.join(__dirname, '../scripts/python-env.cjs'), path.join(root, 'scripts/python-env.cjs'));
    fs.writeFileSync(path.join(root, 'fake-python'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    const content = Buffer.from('test-asset');
    fs.writeFileSync(path.join(root, 'assets/systemone.json'), JSON.stringify({ repository: 'test/model', revision: 'pinned', files: { 'config.json': { bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') } } }));
    const runtime = path.join(root, 'runtimes', `${process.platform}-${process.arch}`);
    fs.mkdirSync(path.join(runtime, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    fs.writeFileSync(path.join(runtime, 'bin/brick-runtime'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.0; fi\nexit 0\n', { mode: 0o755 });
    const installer = require(path.join(root, 'scripts/runtime-install.cjs'));
    await run({ installer, root, content, runtime });
  } finally {
    global.fetch = originalFetch;
    if (previousPython === undefined) delete process.env.BRICK_SYSTEMONE_PYTHON;
    else process.env.BRICK_SYSTEMONE_PYTHON = previousPython;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('installation validates checksums, completes atomically, and is repeatable', () => fixture(async ({ installer, root, content }) => {
  let calls = 0;
  global.fetch = async () => { calls++; return new Response(content); };
  await assert.rejects(async () => installer.installedRuntime(), /incomplete/);
  await installer.install();
  const state = installer.installedRuntime();
  assert.equal(fs.readFileSync(path.join(state.models, 'config.json'), 'utf8'), content.toString());
  await installer.install();
  assert.equal(calls, 1);
  assert.deepEqual(fs.readdirSync(path.join(root, 'assets/models')), ['pinned']);
}));

for (const failure of ['checksum', 'http', 'interrupted', 'permissions', 'disk-full']) {
  test(`installation fails explicitly on ${failure} and leaves no complete assets`, () => fixture(async ({ installer, root, content }) => {
    const originalWrite = fs.createWriteStream;
    global.fetch = async () => {
      if (failure === 'http') return new Response('', { status: 503 });
      if (failure === 'interrupted') return new Response(new ReadableStream({ start(controller) { controller.enqueue(content.subarray(0, 2)); controller.error(new Error('download interrupted')); } }));
      return new Response(failure === 'checksum' ? Buffer.alloc(content.length) : content);
    };
    if (failure === 'permissions' || failure === 'disk-full') fs.createWriteStream = () => { throw Object.assign(new Error(failure), { code: failure === 'permissions' ? 'EACCES' : 'ENOSPC' }); };
    try { await assert.rejects(installer.install()); }
    finally { fs.createWriteStream = originalWrite; }
    assert.deepEqual(fs.readdirSync(path.join(root, 'assets/models')), []);
    assert.throws(() => installer.installedRuntime(), /incomplete/);
  }));
}

test('--python-only prints the interpreter and leaves model assets untouched', () => fixture(async ({ root }) => {
  const fakePython = path.join(root, 'fake-python');
  const probe = spawnSync(process.execPath, [path.join(root, 'scripts/runtime-install.cjs'), '--python-only'], {
    encoding: 'utf8',
    env: { ...process.env, BRICK_SYSTEMONE_PYTHON: fakePython },
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, `${fakePython}\n`);
  assert.equal(fs.existsSync(path.join(root, 'assets/models')), false);
}));

test('mismatched runtime versions are fatal', () => fixture(async ({ installer, runtime }) => {
  fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ version: '2.0.0' }));
  assert.throws(() => installer.runtimeBundle(), /version mismatch/);
}));


test('a missing bundled runtime is fatal', () => fixture(async ({ installer, runtime }) => {
  fs.rmSync(runtime, { recursive: true });
  assert.throws(() => installer.runtimeBundle(), /Missing.*runtime/);
}));

test('failed real-model loading cannot mark assets complete', () => fixture(async ({ installer, content, runtime, root }) => {
  global.fetch = async () => new Response(content);
  fs.writeFileSync(path.join(runtime, 'bin/brick-runtime'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.0; exit 0; fi\nexit 1\n', { mode: 0o755 });
  await assert.rejects(installer.install(), /could not load/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'assets/models')), []);
}));

test('an incompatible executable fails before downloading any assets', () => fixture(async ({ installer, runtime }) => {
  let downloads = 0;
  global.fetch = async () => { downloads++; throw new Error('must not download'); };
  fs.writeFileSync(path.join(runtime, 'bin/brick-runtime'), '#!/bin/sh\necho incompatible >&2\nexit 1\n', { mode: 0o755 });
  await assert.rejects(installer.install(), /cannot execute/);
  assert.equal(downloads, 0);
}));

test('optional checkpoint authentication is sent without persisting the token', () => fixture(async ({ installer, content }) => {
  const previous = process.env.HF_TOKEN;
  process.env.HF_TOKEN = 'test-private-token';
  try {
    global.fetch = async (url, options) => {
      assert.match(url, /\/resolve\/pinned\/config.json$/);
      assert.equal(options.headers.Authorization, 'Bearer test-private-token');
      return new Response(content);
    };
    await installer.install();
    const marker = fs.readFileSync(path.join(installer.installedRuntime().models, '.complete.json'), 'utf8');
    assert.equal(marker.includes(process.env.HF_TOKEN), false);
  } finally {
    if (previous === undefined) delete process.env.HF_TOKEN;
    else process.env.HF_TOKEN = previous;
  }
}));

test('local checkpoint assets are verified without downloading', () => fixture(async ({ installer, root, content }) => {
  const previous = process.env.BRICK_MODEL_ASSETS;
  const local = path.join(root, 'local-assets');
  fs.mkdirSync(local);
  fs.writeFileSync(path.join(local, 'config.json'), content);
  process.env.BRICK_MODEL_ASSETS = local;
  try {
    global.fetch = async () => { throw new Error('unexpected network call'); };
    await installer.install();
    assert.equal(fs.readFileSync(path.join(installer.installedRuntime().models, 'config.json'), 'utf8'), content.toString());
  } finally {
    if (previous === undefined) delete process.env.BRICK_MODEL_ASSETS;
    else process.env.BRICK_MODEL_ASSETS = previous;
  }
}));
