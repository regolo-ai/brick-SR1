import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from '../config/atomic-file.js';
import { paths } from '../config/paths.js';
import { syncProfilePricing, type SyncOptions } from './sync.js';

export const PRICING_WATCH_INTERVAL_MS = 60 * 60 * 1000;

export interface PricingWatchState {
  pid: number;
  instance: string;
  profile: string;
  started_at: string;
  /** Linux process start time, so a recycled PID is never mistaken for us. */
  birth?: string;
}

export interface PricingWatchOptions {
  intervalMs?: number;
  /** Stop after the first sync (used by tests and `--once`). */
  once?: boolean;
  sync?: SyncOptions;
  log?: (message: string) => void;
}

export function watcherStatePath(profile: string): string {
  return join(paths(profile).runtime, 'pricing-watch.json');
}

export function watcherLogPath(profile: string): string {
  return join(paths(profile).runtime, 'pricing.log');
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}


async function processBirth(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return null; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

/** The watcher for this profile, when one is actually running. */
export async function pricingWatcherStatus(profile: string): Promise<PricingWatchState | null> {
  let state: PricingWatchState;
  try { state = JSON.parse(await readFile(watcherStatePath(profile), 'utf8')) as PricingWatchState; }
  catch { return null; }
  if (!Number.isSafeInteger(state.pid) || state.pid <= 0 || !alive(state.pid)) return null;
  if (state.birth) {
    const birth = await processBirth(state.pid);
    if (birth !== state.birth) return null;
  }
  return state;
}

/** Single-instance guard: an abstract socket is released by the kernel on exit. */
function acquireLock(profile: string): Promise<ReturnType<typeof createServer>> {
  const address = '\0brick-pricing-' + createHash('sha256').update(resolve(paths(profile).runtime)).digest('hex');
  const server = createServer((socket) => socket.destroy());
  return new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(address, () => accept(server));
  });
}

/** True when some watcher already owns the profile, even without a state file. */
async function lockHeld(profile: string): Promise<boolean> {
  try {
    const server = await acquireLock(profile);
    await new Promise<void>((done) => server.close(() => done()));
    return false;
  } catch (error: any) {
    return error?.code === 'EADDRINUSE';
  }
}

/**
 * Hourly price sync loop. Runs as its own detached process (spawned by
 * `brick start`) so the CLI can exit while prices keep refreshing.
 */
export async function runPricingWatch(profile: string, options: PricingWatchOptions = {}): Promise<void> {
  const log = options.log ?? ((message: string) => console.log(`[pricing ${new Date().toISOString()}] ${message}`));
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try { lock = await acquireLock(profile); }
  catch (error: any) {
    if (error?.code === 'EADDRINUSE') { log(`another pricing watcher owns profile '${profile}'; exiting`); return; }
    throw error;
  }

  const state: PricingWatchState = {
    pid: process.pid,
    instance: randomUUID(),
    profile,
    started_at: new Date().toISOString(),
    birth: (await processBirth(process.pid)) ?? undefined,
  };
  const writeState = async () => { await atomicWrite(watcherStatePath(profile), JSON.stringify(state), 0o600); };
  // A deleted state file must not leave a running watcher invisible to
  // `brick profile pricing` / `brick stop`, so it is rewritten when missing.
  const ensureState = async () => {
    try { await stat(watcherStatePath(profile)); return; }
    catch { /* missing: rewrite below */ }
    try { await writeState(); } catch { /* best effort */ }
  };
  await writeState();

  let stopping = false;
  // The hourly sleep must end as soon as a stop signal arrives, otherwise a
  // SIGTERM lingers for up to the whole slice while the loop is awaiting.
  let wake: (() => void) | undefined;
  const sleep = (ms: number) => new Promise<void>((done) => {
    const timer = setTimeout(() => { wake = undefined; done(); }, ms);
    wake = () => { clearTimeout(timer); wake = undefined; done(); };
  });
  const stop = () => { stopping = true; wake?.(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  const interval = Math.max(1000, options.intervalMs ?? PRICING_WATCH_INTERVAL_MS);
  try {
    while (!stopping) {
      const started = Date.now();
      try {
        const result = await syncProfilePricing(profile, { ...options.sync, warn: options.sync?.warn ?? log });
        log(`sync ${result.written ? 'updated' : 'unchanged'} (${result.sources.join('+') || 'no sources'}); `
          + `${result.added.length} added, ${result.updated.length} updated, ${result.kept.length} kept, ${result.unpriced.length} unpriced`);
      } catch (error: any) {
        log(`sync failed: ${error?.message ?? error}`);
      }
      await ensureState();
      if (options.once) break;
      // Sleep in slices so a SIGTERM is handled promptly.
      const deadline = started + interval;
      while (!stopping && Date.now() < deadline) {
        await sleep(Math.min(30_000, deadline - Date.now()));
        await ensureState();
      }
    }
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await rm(watcherStatePath(profile), { force: true }).catch(() => undefined);
    await new Promise<void>((done) => lock.close(() => done())).catch(() => undefined);
    log('pricing watcher stopped');
  }
}

function runPath(): string {
  return fileURLToPath(new URL('../../../bin/run.js', import.meta.url));
}

/** Start the detached hourly watcher; no-op when one is already running. */
export async function startPricingWatcher(profile: string): Promise<{ started: boolean; pid?: number }> {
  const current = await pricingWatcherStatus(profile);
  if (current) return { started: false, pid: current.pid };
  // The lock outlives a lost state file, so probing it avoids spawning a child
  // that would immediately exit with "another pricing watcher owns profile".
  if (await lockHeld(profile)) return { started: false };
  const logFile = await open(watcherLogPath(profile), 'a', 0o600);
  let exited = false;
  try {
    const child = spawn(process.execPath, [runPath(), 'pricing:watch', '--profile', profile], {
      detached: true,
      stdio: ['ignore', logFile.fd, logFile.fd],
      env: process.env,
    });
    child.once('exit', () => { exited = true; });
    child.unref();
  } finally {
    await logFile.close();
  }
  // Give the child a moment to write its state file.
  for (let attempt = 0; attempt < 30; attempt++) {
    const state = await pricingWatcherStatus(profile);
    if (state) return { started: true, pid: state.pid };
    if (exited) return { started: false };
    await delay(100);
  }
  return { started: false };
}

/** Terminate the watcher, if any. Returns true when a process was stopped. */
export async function stopPricingWatcher(profile: string): Promise<boolean> {
  const state = await pricingWatcherStatus(profile);
  if (!state) {
    await rm(watcherStatePath(profile), { force: true }).catch(() => undefined);
    return false;
  }
  try { process.kill(state.pid, 'SIGTERM'); }
  catch { return false; }
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!alive(state.pid)) break;
    await delay(100);
  }
  // A watcher holds no state beyond its lock, so it is safe to force-kill if a
  // stop signal was ignored (for example while blocked in a sync download).
  if (alive(state.pid)) {
    try { process.kill(state.pid, 'SIGKILL'); } catch { /* already gone */ }
    await delay(100);
  }
  await rm(watcherStatePath(profile), { force: true }).catch(() => undefined);
  return true;
}
