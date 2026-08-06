import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { imageFromCompose } from './serve.js';

describe('imageFromCompose', () => {
  it('resolves the router image and compose defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'brick-compose-'));
    const file = join(dir, 'docker-compose.yml');
    await writeFile(file, 'services:\n  classifier:\n    image: classifier:old\n  router:\n    image: ${BRICK_IMAGE:-docker.io/regolo/brick:latest}\n');
    await expect(imageFromCompose(file)).resolves.toBe('docker.io/regolo/brick:latest');
  });
});
