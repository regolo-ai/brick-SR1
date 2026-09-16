#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = require('../assets/modernbert.json');
const version = require('../package.json').version;
function runtimeBundle() {
  if (!['linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
  const target = `${process.platform}-${process.arch}`;
  const file = path.join(root, 'runtimes', target, 'package.json');
  if (!fs.existsSync(file)) throw new Error(`Missing bundled ${target} runtime; reinstall @regoloai/brick@${version}.`);
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (pkg.version !== version) throw new Error(`CLI/runtime version mismatch: ${version}/${pkg.version}`);
  const binary = path.join(path.dirname(file), 'bin', 'brick-runtime');
  fs.accessSync(binary, fs.constants.X_OK);
  return { binary, version, packageRoot: path.dirname(file) };
}
function assetDirectory() { return path.join(root, 'assets', 'models', manifest.revision); }
function installedRuntime() {
  const bundle = runtimeBundle();
  const models = assetDirectory();
  let marker;
  try { marker = JSON.parse(fs.readFileSync(path.join(models, '.complete.json'), 'utf8')); }
  catch { throw new Error('Brick installation is incomplete. Reinstall with npm lifecycle scripts enabled; start does not download models.'); }
  if (marker.revision !== manifest.revision || marker.version !== version) throw new Error('Brick model installation does not match this runtime. Reinstall Brick.');
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (fs.statSync(path.join(models, name)).size !== expected.bytes) throw new Error(`Incomplete model asset: ${name}`);
  }
  return { ...bundle, models };
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function verify(directory) {
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = path.join(directory, name);
    if ((await fsp.stat(file)).size !== expected.bytes || await hashFile(file) !== expected.sha256) throw new Error(`Model checksum verification failed: ${name}`);
  }
}
async function install() {
  const bundle = runtimeBundle();
  const binaryVersion = spawnSync(bundle.binary, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (binaryVersion.error || binaryVersion.status !== 0 || binaryVersion.stdout.trim() !== version) throw new Error(`Installed runtime cannot execute or has the wrong version: ${binaryVersion.error?.message || binaryVersion.stderr || binaryVersion.stdout || binaryVersion.status}`);
  const destination = assetDirectory();
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  const lock = destination + '.lock';
  try { await fsp.mkdir(lock); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Model installation is already running or was interrupted: ${lock}. Remove the stale lock only after the installer exits.`); throw error; }
  let temporary;
  try {
    if (fs.existsSync(destination)) {
      await verify(destination);
    } else {
      temporary = await fsp.mkdtemp(destination + '.tmp-');
      await fsp.chmod(temporary, 0o755);
      for (const [name, expected] of Object.entries(manifest.files)) {
        const url = `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${name}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
        if (!response.ok || !response.body) throw new Error(`Model download failed: ${name} (HTTP ${response.status})`);
        let bytes = 0;
        const limit = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; callback(bytes > expected.bytes ? new Error(`Oversized model asset: ${name}`) : null, chunk); } });
        await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(path.join(temporary, name), { flags: 'wx', mode: 0o644 }));
      }
      await verify(temporary);
    }
    const directory = temporary || destination;
    const checked = spawnSync(bundle.binary, ['--check-model', directory], { encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 });
    if (checked.error || checked.status !== 0) throw new Error(`Runtime could not load the installed model: ${checked.error?.message || checked.stderr || checked.status}`);
    await fsp.writeFile(path.join(directory, '.complete.json'), JSON.stringify({ revision: manifest.revision, version }), { mode: 0o644 });
    if (temporary) { await fsp.rename(temporary, destination); temporary = undefined; }
  } finally {
    if (temporary) await fsp.rm(temporary, { recursive: true, force: true });
    await fsp.rmdir(lock);
  }
}
module.exports = { install, installedRuntime, runtimeBundle, verify, manifest };
if (require.main === module) install().catch(error => { console.error(`[brick] installation failed: ${error.message}`); process.exitCode = 1; });
