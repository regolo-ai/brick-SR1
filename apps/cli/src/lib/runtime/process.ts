import { parseProfileEnv } from '../config/env-file.js';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, rename, rm, open, stat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ensureProfilePricing } from '../config/pricing.js';
import { migrateNativeProfile } from '../config/native-migration.js';
import { paths, validateProfileName } from '../config/paths.js';
const require = createRequire(import.meta.url);
const installer = require('../../../scripts/runtime-install.cjs');
export interface RuntimeState {
  pid: number; birth: string; executableDevice: number; executableInode: number; instance: string; profile: string; version: string;
  binary: string; models: string; config: string; digest: string; port: number; envFile: string;
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function statePath(profile: string): string { return join(paths(profile).runtime, 'process.json'); }
export function logPath(profile: string): string { return join(paths(profile).runtime, 'router.log'); }
async function processBirth(pid: number): Promise<string | null> {
  // Linux process start time prevents a recycled PID from being treated as Brick.
  if (process.platform !== 'linux') throw new Error('Native process management is currently verified only on Linux.');
  try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]; }
  catch (error: any) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}
async function waitForExit(state: RuntimeState): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await processBirth(state.pid) !== state.birth) return;
    try {
      const status = await readFile(`/proc/${state.pid}/stat`, 'utf8');
      // Linux may mark the leader a zombie while other Go/Rust threads still
      // own sockets. Wait for the whole thread group to release resources.
      if (['Z', 'X'].includes(status.slice(status.lastIndexOf(')') + 2).split(' ')[0]) && (await readdir(`/proc/${state.pid}/task`)).length <= 1) return;
    } catch (error: any) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return; throw error; }
    await delay(100);
  }
  throw new Error(`Previous runtime ${state.instance} has not finished exiting; state retained.`);
}
async function sameProcess(state: RuntimeState): Promise<boolean> {
  if (await processBirth(state.pid) !== state.birth) return false;
  try {
    const exe = await stat(`/proc/${state.pid}/exe`);
    if (exe.dev !== state.executableDevice || exe.ino !== state.executableInode) return false;
    const argv = (await readFile(`/proc/${state.pid}/cmdline`, 'utf8')).split('\0');
    for (const [flag, value] of [['--instance-id', state.instance], ['--profile', state.profile], ['--config', state.config]]) {
      const index = argv.indexOf(flag);
      if (index < 0 || argv[index + 1] !== value) return false;
    }
    return true;
  }
  catch { return false; }
}
async function atomicJSON(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}
async function loadState(profile: string): Promise<RuntimeState | null> {
  try {
    const state = JSON.parse(await readFile(statePath(profile), 'utf8'));
    if (state.profile !== profile || !Number.isSafeInteger(state.pid) || state.pid <= 0 || typeof state.birth !== 'string' || typeof state.instance !== 'string') throw new Error('Invalid runtime state');
    return state;
  } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}
async function health(state: RuntimeState): Promise<any | null> {
  if (!await sameProcess(state)) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!response.ok) return null;
    const value: any = await response.json();
    if (value.instance_id !== state.instance || value.pid !== state.pid || value.profile !== state.profile || value.config !== state.config || value.version !== state.version) return null;
    return value;
  } catch { return null; }
}
export async function runtimeStatus(profile: string): Promise<(RuntimeState & { healthy: boolean; routingReady: boolean }) | null> {
  validateProfileName(profile, { allowReserved: true });
  const state = await loadState(profile);
  if (!state || !await sameProcess(state)) return null;
  const status = await health(state);
  return { ...state, healthy: Boolean(status), routingReady: status?.routing_ready === true };
}
async function withLock<T>(profile: string, fn: () => Promise<T>): Promise<T> {
  validateProfileName(profile, { allowReserved: true });
  const directory = paths(profile).runtime;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Linux abstract sockets are atomic locks released by the kernel on exit,
  // including SIGKILL. There is no stale file to unlink or PID to reclaim.
  const address = '\0brick-operation-' + createHash('sha256').update(resolve(directory)).digest('hex');
  const server = createServer(socket => socket.destroy());
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((accept, reject) => {
        const failed = (error: Error) => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', failed); accept(); };
        server.once('error', failed);
        server.once('listening', ready);
        server.listen(address);
      });
      break;
    } catch (error: any) {
      if (error.code !== 'EADDRINUSE') throw error;
      if (attempt >= 1200) throw new Error(`Another runtime operation owns profile '${profile}'.`);
      await delay(100);
    }
  }
  try {
    // A preceding clear may have removed the directory while we waited.
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return await fn();
  }
  finally { await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); }
}
async function environment(profile: string): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };
  let content = '';
  try { content = await readFile(paths(profile).env, 'utf8'); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  Object.assign(env, parseProfileEnv(content));
  return env;
}
async function terminate(state: RuntimeState): Promise<void> {
  if (!await sameProcess(state)) return;
  try { process.kill(state.pid, 'SIGTERM'); }
  catch (error: any) { if (error.code === 'ESRCH') return; throw error; }
  await waitForExit(state);
}
async function launch(profile: string, bundle: any, config: string, digest: string, port: number, env: NodeJS.ProcessEnv, requireRouting = false): Promise<RuntimeState> {
  const instance = randomUUID();
  const envFile = resolve(paths(profile).runtime, `environment-${instance}.json`);
  await atomicJSON(envFile, env);
  const log = await open(logPath(profile), 'a', 0o600);
  const args = ['--config', config, '--data-dir', resolve(paths(profile).profileDir), '--port', String(port), '--metrics-port', '0', '--model-dir', bundle.models, '--instance-id', instance, '--profile', profile];
  const child = spawn(bundle.binary, args, { env, detached: true, stdio: ['ignore', log.fd, log.fd], cwd: paths(profile).profileDir });
  const spawned = new Promise<void>((accept, reject) => { child.once('spawn', accept); child.once('error', reject); });
  try { await spawned; } finally { await log.close(); }
  child.unref();
  const birth = await processBirth(child.pid!);
  if (!birth) throw new Error(`Runtime exited during startup; inspect ${logPath(profile)}`);
  const exe = await stat(`/proc/${child.pid!}/exe`);
  const state: RuntimeState = { pid: child.pid!, birth, executableDevice: exe.dev, executableInode: exe.ino, instance, profile, version: bundle.version, binary: bundle.binary, models: bundle.models, config, digest, port, envFile };
  try {
    await atomicJSON(statePath(profile), state);
    for (let i = 0; i < 180; i++) {
      const status = await health(state);
      if (status?.routing_ready) return state;
      if (status?.routing_checked && !status.routing_ready) {
        if (requireRouting) throw new Error('Replacement runtime cannot initialize classification');
        return state;
      }
      if (!await sameProcess(state)) throw new Error('Runtime exited before readiness');
      await delay(500);
    }
    throw new Error('Runtime readiness timed out');
  } catch (error) { await terminate(state); throw error; }
}
export async function startRuntime(profile: string, port: number, restart = false): Promise<RuntimeState> {
  return withLock(profile, async () => {
    const bundle = installer.installedRuntime();
    await migrateNativeProfile(profile);
    await ensureProfilePricing(profile);
    const env = await environment(profile);
    const content = await readFile(paths(profile).config);
    const digest = createHash('sha256').update(content).digest('hex');
    const snapshot = resolve(paths(profile).runtime, `config-${digest}.yaml`);
    await writeFile(snapshot, content, { mode: 0o600 });
    const validated = spawnSync(bundle.binary, ['--config', snapshot, '--validate-config', '--model-dir', bundle.models], { env, encoding: 'utf8', timeout: 30000 });
    if (validated.error || validated.status !== 0) throw new Error(`Configuration validation failed; running instance preserved. ${validated.error?.message || validated.stderr || ''}`);
    const previous = await loadState(profile);
    const wasRunning = previous && await sameProcess(previous);
    if (previous && !wasRunning) await waitForExit(previous);
    if (wasRunning) {
      if (!restart) {
        if (previous.digest !== digest || previous.version !== bundle.version) throw new Error('Running configuration/version differs; use brick restart.');
        if (!(await health(previous))?.routing_ready) throw new Error('Existing runtime is not ready; inspect its logs.');
        return previous;
      }
      await terminate(previous);
    }
    try { return await launch(profile, bundle, snapshot, digest, port, env, restart); }
    catch (error) {
      if (previous && wasRunning && restart) {
        try {
          let rollback = previous;
          try {
            const saved = JSON.parse(await readFile(join(paths(profile).runtime, 'rollback.json'), 'utf8'));
            if (saved.instance === previous.instance && saved.version === previous.version) rollback = saved;
          }
          catch (error: any) { if (error.code !== 'ENOENT') throw error; }
          const previousEnv = JSON.parse(await readFile(previous.envFile, 'utf8'));
          await launch(profile, rollback, previous.config, previous.digest, previous.port, previousEnv, true);
        }
        catch { throw new Error(`Restart and rollback failed; inspect ${logPath(profile)}`); }
      }
      throw error;
    }
  });
}
export async function stopRuntime(profile: string): Promise<void> {
  await withLock(profile, async () => {
    const state = await loadState(profile);
    if (state) await terminate(state);
    await rm(statePath(profile), { force: true });
  });
}

export async function clearRuntime(profile: string): Promise<void> {
  await withLock(profile, async () => {
    const state = await loadState(profile);
    if (state) await terminate(state);
    await rm(paths(profile).runtime, { recursive: true, force: true });
  });
}
