#!/usr/bin/env node
// Test the real runtime with missing assets and a local Responses upstream.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const binary = resolve(process.argv[2]);
const directory = await mkdtemp(join(tmpdir(), 'brick-unavailable-'));
const upstream = createServer((req, res) => {
  assert.equal(req.headers.authorization, 'Bearer provider-key');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ id: 'response-test', object: 'response', status: 'completed', output: [], usage: { input_tokens: 2, output_tokens: 1 } }));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const config = { config_version: 1, server_port: port, brick: { enabled: true }, codex_router: { enabled: true, local_key_env: 'BRICK_TEST_LOCAL_KEY' },
  model_config: { test: { context_window_size: 32000, preferred_endpoints: ['test'] } }, default_model: 'test',
  provider_profiles: { test: { type: 'openai_compatible', base_url: `http://127.0.0.1:${upstream.address().port}`, protocol: 'responses', auth_source: 'provider_env', api_key_env: 'BRICK_TEST_PROVIDER_KEY', responses_path: 'responses' } },
  provider_endpoints: [{ name: 'test', provider_profile: 'test' }],
  skill_router: { enabled: true, complexity_model: { base_url: `http://127.0.0.1:${upstream.address().port}`, protocol: 'openai', model_name: 'classifier-test' }, capabilities: ['instruction_following', 'coding', 'math_reasoning', 'world_knowledge', 'planning_agentic', 'creative_synthesis'], capability_model: { model_id: 'missing' }, models: [{ model: 'test', skill_vector: [.5,.5,.5,.5,.5,.5] }] },
};
await writeFile(join(directory, 'config.yaml'), JSON.stringify(config));
const child = spawn(binary, ['--config', join(directory, 'config.yaml'), '--model-dir', join(directory, 'missing'), '--data-dir', directory, '--metrics-port', '0'], { env: { ...process.env, BRICK_TEST_LOCAL_KEY: 'local-key', BRICK_TEST_PROVIDER_KEY: 'provider-key' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', value => { log += value; });
child.stderr.on('data', value => { log += value; });
const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
try {
  let health;
  for (let i = 0; i < 60; i++) {
    try { health = await (await fetch(`http://127.0.0.1:${port}/health`)).json(); if (health.routing_checked) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(health?.routing_checked, true, log);
  assert.equal(health.routing_ready, false);
  const send = model => fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Brick-Key': 'local-key', Authorization: 'Bearer session-key' }, body: JSON.stringify({ model, input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] }) });
  const routed = await send('brick');
  assert.equal(routed.status, 503, await routed.text());
  const direct = await send('test');
  assert.equal(direct.status, 200, await direct.clone().text());
  assert.equal((await direct.json()).id, 'response-test');
  assert.equal(log.includes('session-key'), false);
  assert.equal(log.includes('local-key'), false);
  console.log('PASS: missing BERT reports unready, routing returns 503, direct Responses forwarding remains available');
} finally {
  child.kill('SIGTERM');
  await exited;
  await new Promise(resolve => upstream.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
