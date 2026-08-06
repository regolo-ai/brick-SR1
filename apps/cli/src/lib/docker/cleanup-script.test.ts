import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { cleanup } = require('../../../scripts/docker-cleanup.cjs') as {
  cleanup: (options: { pull?: boolean; strict?: boolean }) => number;
};
const originalHome = process.env.BRICK_HOME;
const originalDocker = process.env.BRICK_DOCKER_BIN;

afterEach(() => {
  if (originalHome === undefined) delete process.env.BRICK_HOME;
  else process.env.BRICK_HOME = originalHome;
  if (originalDocker === undefined) delete process.env.BRICK_DOCKER_BIN;
  else process.env.BRICK_DOCKER_BIN = originalDocker;
});

describe('published Docker cleanup script', () => {
  it('downs and pulls every preserved profile without deleting volumes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'brick-cleanup-'));
    const profileDir = join(dir, 'profiles', 'codex-default');
    const calls = join(dir, 'docker-calls.txt');
    const fakeDocker = join(dir, 'docker');
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, 'docker-compose.yml'), 'services:\n  router:\n    image: docker.io/regolo/brick:latest\n');
    await writeFile(fakeDocker, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\n`);
    await chmod(fakeDocker, 0o755);
    process.env.BRICK_HOME = dir;
    process.env.BRICK_DOCKER_BIN = fakeDocker;

    expect(cleanup({ pull: true, strict: true })).toBe(0);
    const invoked = await readFile(calls, 'utf8');
    expect(invoked).toContain('compose -p brick-codex-default');
    expect(invoked).toContain('down --remove-orphans');
    expect(invoked).toContain(' pull');
    expect(invoked).not.toContain('down -v');
  });
});
