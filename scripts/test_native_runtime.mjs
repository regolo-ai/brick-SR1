#!/usr/bin/env node
// Run against an installed tarball and real model assets. No provider calls.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
const packageRoot = resolve(process.argv[2]);
const home = await mkdtemp(join(tmpdir(), 'brick-native-'));
process.env.BRICK_HOME = home;
const manager = await import(pathToFileURL(join(packageRoot, 'dist/lib/runtime/process.js')));
const profile = 'acceptance';
const dir = join(home, 'profiles', profile);
await mkdir(dir, { recursive: true });
const listener = createServer(socket => socket.destroy());
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const upstream = httpServer((request, response) => {
  request.resume();
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ id: 'acceptance', object: 'chat.completion', model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: 'offline response' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
const config = { server_port: port, brick: { enabled: true }, model_config: { test: {} }, default_model: 'test', skill_router: {
  enabled: true, capabilities: ['instruction_following', 'coding', 'math_reasoning', 'world_knowledge', 'planning_agentic', 'creative_synthesis'],
  capability_model: { model_id: 'installed' }, models: [{ model: 'test', skill_vector: [.5,.5,.5,.5,.5,.5], base_url: upstreamURL }],
  complexity_model: { base_url: 'http://127.0.0.1:1', timeout_seconds: 1 },
} };
await writeFile(join(dir, 'config.yaml'), JSON.stringify(config));
await writeFile(join(dir, '.env'), 'PERSISTENT_CREDENTIAL=preserve-me\n');
await writeFile(join(dir, 'history-fixture.jsonl'), '{"persistent":true}\n');
try {
  const began = performance.now();
  const starts = await Promise.all([manager.startRuntime(profile, port), manager.startRuntime(profile, port)]);
  assert.equal(starts[0].instance, starts[1].instance, 'concurrent starts must share one runtime');
  assert.equal((await manager.runtimeStatus(profile)).routingReady, true);
  console.log(JSON.stringify({ startupMilliseconds: performance.now() - began, pid: starts[0].pid }));
  const rss = (await readFile(`/proc/${starts[0].pid}/status`, 'utf8')).match(/^VmRSS:\s+(.+)$/m)?.[1];
  console.log(JSON.stringify({ readyResidentMemory: rss }));
  const reply = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-caller-key', 'x-selected-model': 'test' }, body: JSON.stringify({ model: 'brick', messages: [{ role: 'user', content: 'offline request' }] }) });
  assert.equal(reply.status, 200, await reply.text());
  const economics = await (await fetch(`http://127.0.0.1:${port}/api/v1/economics`)).json();
  assert.equal(economics.models[0].input_tokens, 9);
  assert.equal(economics.models[0].output_tokens, 3);
  const first = starts[0];
  await writeFile(join(dir, 'config.yaml'), 'skill_router: [malformed');
  await assert.rejects(manager.startRuntime(profile, port, true), /validation|YAML|flow collection/);
  assert.equal((await manager.runtimeStatus(profile)).instance, first.instance, 'bad config must preserve serving process');
  await writeFile(join(dir, 'config.yaml'), JSON.stringify(config));
  const restarted = await manager.startRuntime(profile, port, true);
  assert.notEqual(restarted.instance, first.instance);
  const restoredEconomics = await (await fetch(`http://127.0.0.1:${port}/api/v1/economics`)).json();
  assert.deepEqual(restoredEconomics.models, economics.models);
  const history = await readFile(join(dir, 'call_history.jsonl'), 'utf8');
  assert.ok(history.trim(), 'real request history must persist');
  // Replacement binds a deliberately occupied port: restore the old process,
  // configuration and credentials after the replacement has failed.
  const blocked = createServer(socket => socket.destroy());
  await new Promise(resolve => blocked.listen(0, '127.0.0.1', resolve));
  await writeFile(join(dir, '.env'), 'PERSISTENT_CREDENTIAL=replacement-only\n');
  try { await assert.rejects(manager.startRuntime(profile, blocked.address().port, true), /exited/); }
  finally { await new Promise(resolve => blocked.close(resolve)); }
  const rolledBack = await manager.runtimeStatus(profile);
  assert.equal(rolledBack.routingReady, true);
  assert.equal(rolledBack.port, port);
  const restoredEnvironment = await readFile(`/proc/${rolledBack.pid}/environ`, 'utf8');
  assert.ok(restoredEnvironment.split('\0').includes('PERSISTENT_CREDENTIAL=preserve-me'));
  await writeFile(join(dir, '.env'), 'PERSISTENT_CREDENTIAL=preserve-me\n');
  // An abrupt death must not leave a live lock or a falsely healthy process.
  process.kill(rolledBack.pid, 'SIGKILL');
  for (let i = 0; i < 100 && await manager.runtimeStatus(profile); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await manager.runtimeStatus(profile), null);
  const recovered = await manager.startRuntime(profile, port);
  assert.notEqual(recovered.instance, rolledBack.instance);
  await manager.stopRuntime(profile);
  assert.equal(await manager.runtimeStatus(profile), null);
  // A stale state pointing at this test process must never signal it.
  await writeFile(join(dir, 'runtime/process.json'), JSON.stringify({ ...restarted, pid: process.pid, birth: 'stale' }));
  await manager.stopRuntime(profile);
  assert.equal(await manager.runtimeStatus(profile), null);
  await new Promise(resolve => listener.listen(port, '127.0.0.1', resolve));
  await assert.rejects(manager.startRuntime(profile, port), /exited/);
  await new Promise(resolve => listener.close(resolve));
  await Promise.all([manager.clearRuntime(profile), manager.startRuntime(profile, port)]);
  await manager.clearRuntime(profile);
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'PERSISTENT_CREDENTIAL=preserve-me\n');
  assert.equal(await readFile(join(dir, 'history-fixture.jsonl'), 'utf8'), '{"persistent":true}\n');
  assert.equal(await readFile(join(dir, 'call_history.jsonl'), 'utf8'), history);
  assert.ok(JSON.parse(await readFile(join(dir, 'economics_snapshot.json'), 'utf8')));
  console.log('PASS: real inference readiness, concurrent start, restart, rollback with original credentials, crash recovery, invalid config, stale PID, occupied port, persistence');
} catch (error) {
  console.error(await readFile(join(dir, 'runtime/router.log'), 'utf8').catch(() => 'No log'));
  throw error;
} finally {
  await manager.stopRuntime(profile);
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  if (listener.listening) await new Promise(resolve => listener.close(resolve));
  await rm(home, { recursive: true, force: true });
}
