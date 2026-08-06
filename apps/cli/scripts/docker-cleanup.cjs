#!/usr/bin/env node
/*
 * Stop every Brick Compose project without deleting configuration or volumes.
 * npm >= 7 does not run uninstall lifecycle scripts, so cleanup must happen
 * while the CLI still exists or when the replacement package is installed.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

function cleanup(options = {}) {
  const root = process.env.BRICK_HOME || path.join(os.homedir(), '.brick');
  const docker = process.env.BRICK_DOCKER_BIN || 'docker';
  const profilesDir = path.join(root, 'profiles');
  const composeFiles = [];
  let stopFailed = false;

  function addCompose(file, project) {
    if (fs.existsSync(file)) composeFiles.push({ file, project });
  }

  try {
    for (const name of fs.existsSync(profilesDir) ? fs.readdirSync(profilesDir) : []) {
      const dir = path.join(profilesDir, name);
      if (fs.statSync(dir).isDirectory()) addCompose(path.join(dir, 'docker-compose.yml'), `brick-${name}`);
    }
    addCompose(path.join(root, 'docker-compose.yml'), 'brick');
  } catch (error) {
    console.warn(`[brick] could not enumerate profiles: ${error.message}`);
    stopFailed = true;
  }

  function run(args, required = false) {
    const result = cp.spawnSync(docker, args, { stdio: 'pipe', encoding: 'utf8' });
    if (result.error && result.error.code === 'ENOENT') {
      console.warn('[brick] Docker is not installed; no local stack could be stopped or refreshed.');
      return false;
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.error?.message || '').trim().split('\n')[0];
      console.warn(`[brick] docker ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
      if (required) stopFailed = true;
      return false;
    }
    return true;
  }

  for (const { file, project } of composeFiles) {
    run(['compose', '-p', project, '-f', file, 'down', '--remove-orphans'], true);
  }

  const listed = cp.spawnSync(
    docker,
    ['ps', '-a', '--format', '{{.ID}}\t{{.Label "com.docker.compose.project"}}'],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  if (!listed.error && listed.status === 0) {
    for (const line of listed.stdout.split('\n')) {
      const [id, project] = line.trim().split('\t');
      if (id && (project === 'brick' || project?.startsWith('brick-'))) run(['rm', '-f', id], true);
    }
  }

  const networks = cp.spawnSync(
    docker,
    ['network', 'ls', '--format', '{{.ID}}\t{{.Label "com.docker.compose.project"}}'],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  if (!networks.error && networks.status === 0) {
    for (const line of networks.stdout.split('\n')) {
      const [id, project] = line.trim().split('\t');
      if (id && (project === 'brick' || project?.startsWith('brick-'))) run(['network', 'rm', id], true);
    }
  }

  if (options.pull) {
    for (const { file, project } of composeFiles) {
      run(['compose', '-p', project, '-f', file, 'pull']);
    }
  }

  if (stopFailed && options.strict) {
    console.error('[brick] cleanup was incomplete; package removal aborted so the running installation remains manageable.');
    return 1;
  }
  console.log(`[brick] Brick stacks stopped; configuration and volumes under ${root} preserved.${options.pull ? ' Images refreshed.' : ''}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = cleanup({
    pull: process.argv.includes('--pull'),
    strict: process.argv.includes('--strict'),
  });
}

module.exports = { cleanup };
