const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brick-installer-'));
  const originalFetch = global.fetch;
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'assets'));
    fs.copyFileSync(path.join(__dirname, '../scripts/runtime-install.cjs'), path.join(root, 'scripts/runtime-install.cjs'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    const content = Buffer.from('test-asset');
    fs.writeFileSync(path.join(root, 'assets/modernbert.json'), JSON.stringify({ repository: 'test/model', revision: 'pinned', files: { 'config.json': { bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') } } }));
    const runtime = path.join(root, 'node_modules', '@regoloai', `brick-runtime-${process.platform}-${process.arch}`);
    fs.mkdirSync(path.join(runtime, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    fs.writeFileSync(path.join(runtime, 'bin/brick-runtime'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.0; fi\nexit 0\n', { mode: 0o755 });
    const installer = require(path.join(root, 'scripts/runtime-install.cjs'));
    await run({ installer, root, content, runtime });
  } finally {
    global.fetch = originalFetch;
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

test('mismatched runtime versions are fatal', () => fixture(async ({ installer, runtime }) => {
  fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ version: '2.0.0' }));
  assert.throws(() => installer.runtimeBundle(), /version mismatch/);
}));


test('a missing optional runtime is fatal', () => fixture(async ({ installer, runtime }) => {
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
