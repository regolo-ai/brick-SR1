import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectories: string[] = [];

const fakeOclif = `
import { performance } from 'node:perf_hooks';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';

export async function execute(options) {
  const App = ({ value }) => React.createElement(Text, null, String(value));
  const view = render(React.createElement(App, { value: 0 }));

  for (let value = 1; value <= 100; value += 1) {
    view.rerender(React.createElement(App, { value }));
    await new Promise((resolve) => setImmediate(resolve));
  }

  view.unmount();
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({
    development: options.development === true,
    nodeEnv: process.env.NODE_ENV,
    performanceMeasures: performance.getEntriesByType('measure').length,
  }));
}
`;

type EntrypointResult = {
  development: boolean;
  nodeEnv?: string;
  performanceMeasures: number;
};

async function runEntrypoint(
  entrypoint: 'run.js' | 'dev.js',
  inheritedNodeEnv?: string,
): Promise<EntrypointResult> {
  const directory = await mkdtemp(join(cliRoot, '.entrypoint-test-'));
  temporaryDirectories.push(directory);

  const packageDirectory = join(directory, 'node_modules', '@oclif', 'core');
  await mkdir(packageDirectory, { recursive: true });
  await copyFile(join(cliRoot, 'bin', entrypoint), join(directory, entrypoint));
  await writeFile(
    join(packageDirectory, 'package.json'),
    JSON.stringify({ name: '@oclif/core', type: 'module', exports: './index.js' }),
  );
  await writeFile(join(packageDirectory, 'index.js'), fakeOclif);

  const env = { ...process.env };
  delete env.NODE_ENV;
  if (inheritedNodeEnv !== undefined) env.NODE_ENV = inheritedNodeEnv;

  const { stdout } = await execFileAsync(process.execPath, [join(directory, entrypoint)], {
    env,
  });
  return JSON.parse(stdout.trim()) as EntrypointResult;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('CLI entrypoints', () => {
  it.each([undefined, 'development'])(
    'loads production dependencies when inherited NODE_ENV is %s',
    async (inheritedNodeEnv) => {
      const result = await runEntrypoint('run.js', inheritedNodeEnv);

      expect(result.nodeEnv).toBe('production');
      expect(result.development).toBe(false);
      expect(result.performanceMeasures).toBe(0);
    },
  );

  it('keeps the development entrypoint in development mode', async () => {
    const result = await runEntrypoint('dev.js');

    expect(result.nodeEnv).toBe('development');
    expect(result.development).toBe(true);
    expect(result.performanceMeasures).toBeGreaterThan(0);
  });
});
