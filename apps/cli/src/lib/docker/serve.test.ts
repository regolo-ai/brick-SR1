import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { imageFromCompose, isBrickRouter } from './serve.js';

describe('imageFromCompose', () => {
  it('resolves the router image and compose defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'brick-compose-'));
    const file = join(dir, 'docker-compose.yml');
    await writeFile(file, 'services:\n  classifier:\n    image: classifier:old\n  router:\n    image: ${BRICK_IMAGE:-docker.io/regolo/brick:latest}\n');
    await expect(imageFromCompose(file)).resolves.toBe('docker.io/regolo/brick:latest');
  });
});

describe('isBrickRouter', () => {
  it('accepts the Brick virtual model identity', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'brick', owned_by: 'brick' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
    try {
      await expect(isBrickRouter(address.port)).resolves.toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects an unrelated OpenAI-compatible model server', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'deepseek-v4', owned_by: 'vllm' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
    try {
      await expect(isBrickRouter(address.port)).resolves.toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
