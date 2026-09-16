import { createHash } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { readFile, readlink, rm } from 'node:fs/promises';
import { paths } from '../config/paths.js';
import { execa } from 'execa';

async function readPid(profile: string): Promise<number | null> {
  try {
    const pid = Number((await readFile(paths(profile).codexBridgePid, 'utf8')).trim());
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
  } catch { return null; }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function isVerifiedBridgePid(pid: number): Promise<boolean> {
  if (!processExists(pid)) return false;
  try {
    const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
    if (basename(await readlink(`/proc/${pid}/exe`)) !== 'node' || !argv[1] || !isAbsolute(argv[1]) || basename(argv[1]) !== 'codex-flat-bridge.mjs') return false;
    // Recognize the exact retired bridge implementation, not an unrelated PID.
    return createHash('sha256').update(await readFile(argv[1])).digest('hex') === 'a572c4d5892215064986c29dbe3a8dc00c6fea6b8d78c87a9971583d754e0dc5';
  } catch { return false; }
}

export async function stopCodexFlatBridge(profile = 'codex'): Promise<boolean> {
  let stoppedService = false;
  const service = 'brick-codex-flat-bridge.service';
  const active = await execa('systemctl', ['is-active', '--quiet', service], { reject: false }).catch(() => null);
  if (active?.exitCode === 0) {
    const result = await execa('systemctl', ['disable', '--now', service], { reject: false });
    if (result.exitCode !== 0) throw new Error(`Could not retire legacy ${service}.`);
    stoppedService = true;
  }
  const pp = paths(profile);
  const pid = await readPid(profile);
  if (!pid || !(await isVerifiedBridgePid(pid))) {
    await rm(pp.codexBridgePid, { force: true });
    return stoppedService;
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && processExists(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await rm(pp.codexBridgePid, { force: true });
  return true;
}
