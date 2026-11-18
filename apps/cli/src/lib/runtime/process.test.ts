import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { processBirth, terminate, type RuntimeState } from './process.js';

const linux = process.platform === 'linux' ? describe : describe.skip;

function stubState(pid: number, birth: string): RuntimeState {
  const exe = statSync(`/proc/${pid}/exe`);
  return {
    pid,
    birth,
    executableDevice: exe.dev,
    executableInode: exe.ino,
    instance: 'test-instance',
    profile: 'test-profile',
    version: '0.0.0-test',
    binary: process.execPath,
    models: '',
    config: 'cfg',
    digest: '',
    port: 0,
    envFile: '',
  };
}

async function stubRuntime(script: string) {
  const child = spawn(
    process.execPath,
    // The `--` separator puts the mock argv in the child's command line the
    // same way the Go runtime declares --instance-id/--profile/--config.
    ['-e', script, '--', '--instance-id', 'test-instance', '--profile', 'test-profile', '--config', 'cfg'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  // Wait until the stub has installed its signal handlers: killing before the
  // process is ready races the default SIGTERM disposition.
  const [ready] = await once(child.stdout!, 'data');
  expect(String(ready)).toContain('ready');
  return child;
}

async function birthOf(pid: number): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const birth = await processBirth(pid);
    if (birth) return birth;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('stub runtime did not appear in /proc');
}

// A replaced runtime that keeps serving an in-flight stream can ignore
// SIGTERM for a long time. The restart must still complete: after the grace
// window the old process is killed instead of abandoning the profile with no
// router at all (the failure mode observed with a live Codex stream).
linux('runtime process termination', () => {
  it('kills a runtime that ignores SIGTERM after the grace window', async () => {
    const child = await stubRuntime('process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);');
    const signal = new Promise<string | null>(resolve => child.once('exit', (_code, sig) => resolve(sig)));
    const state = stubState(child.pid!, await birthOf(child.pid!));

    const started = Date.now();
    await terminate(state, { graceMs: 200 });

    expect(await signal).toBe('SIGKILL');
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('lets a cooperative runtime exit on SIGTERM within the grace window', async () => {
    const child = await stubRuntime('console.log("ready"); setInterval(() => {}, 1000);');
    const signal = new Promise<string | null>(resolve => child.once('exit', (_code, sig) => resolve(sig)));
    const state = stubState(child.pid!, await birthOf(child.pid!));

    await terminate(state, { graceMs: 5_000 });

    expect(await signal).toBe('SIGTERM');
  }, 20_000);
});
