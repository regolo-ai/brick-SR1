#!/usr/bin/env node
// Exercise the actual update command against an isolated global installation.
// npm's destructive failure is injected; no registry publication or paid API calls.
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const installed = resolve(process.argv[2]);
const scratch = await mkdtemp(join(tmpdir(), 'brick-update-command-'));
const prefix = join(scratch, 'global');
const modules = join(prefix, 'lib/node_modules');
const cli = join(modules, '@regoloai/brick');
const native = join(modules, '@regoloai/brick-runtime-linux-x64');
const home = join(scratch, 'profiles-home');
const profile = join(home, 'profiles', 'update-test');
let manager;
try {
  await mkdir(dirname(modules), { recursive: true });
  await cp(dirname(dirname(installed)), modules, { recursive: true });
  await mkdir(join(prefix, 'bin'), { recursive: true });
  await mkdir(profile, { recursive: true });
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  await writeFile(join(profile, 'config.yaml'), JSON.stringify({
    config_version: 1, server_port: port, brick: { enabled: true },
    default_model: 'test', model_config: { test: {} }, skill_router: {
      enabled: true,
      capabilities: ['instruction_following', 'coding', 'math_reasoning', 'world_knowledge', 'planning_agentic', 'creative_synthesis'],
      capability_model: { model_id: 'installed' },
      models: [{ model: 'test', skill_vector: [.5, .5, .5, .5, .5, .5], base_url: 'http://127.0.0.1:1' }],
      complexity_model: { base_url: 'http://127.0.0.1:1', timeout_seconds: 1 },
    },
  }));
  process.env.BRICK_HOME = home;
  manager = await import(pathToFileURL(join(cli, 'dist/lib/runtime/process.js')));
  const before = await manager.startRuntime('update-test', port);
  const shim = join(scratch, 'shim');
  await mkdir(shim);
  await writeFile(join(shim, 'npm'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'root') console.log(${JSON.stringify(modules)});
else if (args[0] === 'prefix') console.log(${JSON.stringify(prefix)});
else if (args[0] === 'install') {
  fs.rmSync(${JSON.stringify(cli)}, { recursive: true });
  fs.rmSync(${JSON.stringify(native)}, { recursive: true });
  process.exit(17);
} else process.exit(99);
`, { mode: 0o755 });
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(cli, 'bin/run.js'), ...args], {
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => output += data);
    child.stderr.on('data', data => output += data);
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
  const failed = await run(['update', '--to', 'failure-test']);
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /previous bundle restored/, failed.output);
  assert.equal(JSON.parse(await readFile(join(cli, 'package.json'))).version, before.version);
  assert.equal(JSON.parse(await readFile(join(native, 'package.json'))).version, before.version);
  assert.equal((await manager.runtimeStatus('update-test')).instance, before.instance);
  assert.equal((await manager.runtimeStatus('update-test')).routingReady, true);
  // A fresh CLI process can consume the restored installation and rollback command.
  const backups = await readdir(join(home, 'bundles'));
  assert.equal(backups.length, 1);
  const restored = await run(['update', '--rollback', join(home, 'bundles', backups[0])]);
  assert.equal(restored.code, 0, restored.output);
  assert.equal((await manager.runtimeStatus('update-test')).instance, before.instance);
  const replacement = await manager.startRuntime('update-test', port, true);
  assert.notEqual(replacement.instance, before.instance);
  assert.equal((await manager.runtimeStatus('update-test')).routingReady, true);
  console.log('PASS: actual update failure restores the complete bundle, preserves the active runtime, and explicit rollback supports restart');
} finally {
  if (manager) await manager.clearRuntime('update-test');
  await rm(scratch, { recursive: true, force: true });
}
