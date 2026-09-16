import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveBundle, restoreBundle } from './update-bundle.js';

describe('npm bundle recovery', () => {
  it('restores CLI dependencies, runtime, assets and command link after a partial installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'brick-update-'));
    const cli = join(root, 'global/cli');
    const runtime = join(cli, 'node_modules/@regoloai/brick-runtime-linux-x64');
    const backup = join(root, 'saved');
    const binLink = join(root, 'brick');
    try {
      for (const dir of [runtime, join(cli, 'assets/models'), join(cli, 'node_modules/dependency'), join(cli, 'bin')]) await mkdir(dir, { recursive: true });
      await writeFile(join(cli, 'package.json'), JSON.stringify({ name: '@regoloai/brick', version: '3.0.0' }));
      await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: '@regoloai/brick-runtime-linux-x64', version: '3.0.0' }));
      await writeFile(join(runtime, 'binary'), 'old runtime');
      await writeFile(join(cli, 'assets/models/weights'), 'old verified weights');
      await writeFile(join(cli, 'node_modules/dependency/index.js'), 'old dependency');
      await writeFile(join(cli, 'bin/run.js'), 'old CLI');
      await saveBundle(backup, { packageRoot: cli, runtimeRoot: runtime, version: '3.0.0', binLink });
      await rm(cli, { recursive: true });
      await mkdir(cli, { recursive: true });
      await writeFile(join(cli, 'package.json'), 'interrupted npm write');
      await restoreBundle(backup);
      expect(await readFile(join(runtime, 'binary'), 'utf8')).toBe('old runtime');
      expect(await readFile(join(cli, 'assets/models/weights'), 'utf8')).toBe('old verified weights');
      expect(await readFile(join(cli, 'node_modules/dependency/index.js'), 'utf8')).toBe('old dependency');
      expect(await readlink(binLink)).toBe(join(cli, 'bin/run.js'));
      // Repeat restore is safe and preserves the immutable saved bundle.
      await restoreBundle(backup);
      expect(await readFile(join(cli, 'bin/run.js'), 'utf8')).toBe('old CLI');
      await writeFile(join(backup, 'runtime/package.json'), JSON.stringify({ name: '@regoloai/brick-runtime-linux-x64', version: '4.0.0' }));
      await expect(restoreBundle(backup)).rejects.toThrow('Invalid or incomplete');
      expect(await readFile(join(runtime, 'binary'), 'utf8')).toBe('old runtime');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
