import { copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, root } from './paths.js';

/** Preserve custom profile/legacy prices; seed new profiles from the release. */
export async function ensureProfilePricing(profile: string): Promise<void> {
  const target = join(paths(profile).profileDir, 'pricing.yaml');
  for (const source of [join(root(), 'pricing.yaml'), fileURLToPath(new URL('../../../assets/pricing.yaml', import.meta.url))]) {
    try { await copyFile(source, target, constants.COPYFILE_EXCL); return; }
    catch (error: any) {
      if (error.code === 'EEXIST') return;
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('Packaged pricing table is missing; reinstall Brick.');
}
