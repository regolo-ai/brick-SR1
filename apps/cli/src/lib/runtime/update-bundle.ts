import { cp, mkdir, readFile, rename, writeFile, lstat, symlink, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface SavedBundle {
  packageRoot: string;
  runtimeRoot: string;
  version: string;
  binLink: string;
}

/** Save complete installed trees before npm can replace executable or model files. */
export async function saveBundle(directory: string, bundle: SavedBundle): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await cp(bundle.packageRoot, join(directory, 'cli'), { recursive: true, dereference: true });
  await cp(bundle.runtimeRoot, join(directory, 'runtime'), { recursive: true, dereference: true });
  await writeFile(join(directory, 'restore.json'), JSON.stringify(bundle), { mode: 0o600, flag: 'wx' });
}

/** Restore without deleting diagnostic evidence or touching profile data. */
export async function restoreBundle(directory: string): Promise<SavedBundle> {
  const bundle: SavedBundle = JSON.parse(await readFile(join(directory, 'restore.json'), 'utf8'));
  const cli = JSON.parse(await readFile(join(directory, 'cli/package.json'), 'utf8'));
  const runtime = JSON.parse(await readFile(join(directory, 'runtime/package.json'), 'utf8'));
  if (cli.name !== '@regoloai/brick' || !runtime.name?.startsWith('@regoloai/brick-runtime-') || cli.version !== bundle.version || runtime.version !== bundle.version) throw new Error('Invalid or incomplete rollback bundle');
  for (const [target, source] of [[bundle.packageRoot, join(directory, 'cli')], [bundle.runtimeRoot, join(directory, 'runtime')]]) {
    if (!target || resolve(target) === '/' || resolve(target) === resolve(directory)) throw new Error('Invalid rollback destination');
    const staged = `${target}.restore-${randomUUID()}`;
    await mkdir(dirname(target), { recursive: true });
    await cp(source, staged, { recursive: true });
    try {
      try { await rename(target, `${target}.failed-${randomUUID()}`); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      await rename(staged, target);
    } finally { await rm(staged, { recursive: true, force: true }); }
  }
  // npm can remove the global command link before failing its lifecycle hook.
  try {
    const entry = await lstat(bundle.binLink);
    if (!entry.isSymbolicLink()) throw new Error('Refusing to replace a non-symlink Brick command');
    await rm(bundle.binLink);
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  await symlink(join(bundle.packageRoot, 'bin/run.js'), bundle.binLink);
  return bundle;
}
