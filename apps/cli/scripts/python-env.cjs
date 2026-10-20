#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const requirements = path.join(root, 'assets', 'requirements-systemone.txt');
const torchVersion = '2.11.0';
const cpuIndex = 'https://download.pytorch.org/whl/cpu';
const cu126Index = 'https://download.pytorch.org/whl/cu126';
const cu128Index = 'https://download.pytorch.org/whl/cu128';

function brickHome() {
  return process.env.BRICK_HOME || path.join(os.homedir(), '.brick');
}

function venvDir() {
  return path.join(brickHome(), 'runtime', version, 'venv');
}

function venvPython() {
  return process.platform === 'win32'
    ? path.join(venvDir(), 'Scripts', 'python.exe')
    : path.join(venvDir(), 'bin', 'python');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || String(result.status)).trim();
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
  return result;
}

function hasStack(python) {
  const probe = spawnSync(python, ['-c', 'import torch, transformers'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

function hasCudaRuntime(python) {
  const probe = spawnSync(python, ['-c', 'import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

function detectCuda() {
  if (process.env.BRICK_CUDA === '0') return false;
  const probe = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0 && probe.stdout.trim() !== '';
}

function detectDriverVersion() {
  if (process.env.BRICK_CUDA === '0') return null;
  const probe = spawnSync('nvidia-smi', ['--query-gpu=driver_version', '--format=csv,noheader'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return null;
  const match = probe.stdout.trim().match(/^(\d+)\./);
  return match ? match[1] : null;
}

function detectComputeCapability() {
  if (process.env.BRICK_CUDA === '0') return null;
  const probe = spawnSync('nvidia-smi', ['--query-gpu=compute_cap', '--format=csv,noheader'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return null;
  const value = Number.parseFloat(probe.stdout.trim().split('\n')[0]);
  return Number.isFinite(value) ? value : null;
}

// chooseTorchIndex maps a driver major version and GPU compute capability to the
// PyTorch wheel index whose bundled CUDA runtime the driver can load. The cu128
// build (CUDA 12.8, driver 570+) covers both pre-Blackwell and Blackwell GPUs;
// drivers 560-569 only reach cu126, which predates Blackwell (compute capability
// 12.0). Drivers below 560 fall back to CPU wheels.
function chooseTorchIndex(driverMajor, computeCapability = null) {
  if (process.env.BRICK_CUDA === '0' || driverMajor == null) return { cuda: false, index: cpuIndex };
  if (driverMajor >= 570) return { cuda: true, index: cu128Index };
  if (driverMajor >= 560 && (computeCapability == null || computeCapability < 12)) return { cuda: true, index: cu126Index };
  return { cuda: false, index: cpuIndex };
}

// ensurePython returns a Python interpreter that can import torch and
// transformers. It reuses BRICK_SYSTEMONE_PYTHON, an existing managed venv, or
// creates one, installing CUDA wheels when a GPU is detected and CPU wheels
// otherwise.
function ensurePython(log = () => {}) {
  const override = (process.env.BRICK_SYSTEMONE_PYTHON || '').trim();
  if (override) {
    if (!hasStack(override)) throw new Error(`BRICK_SYSTEMONE_PYTHON=${override} cannot import torch and transformers`);
    return override;
  }
  if (process.env.BRICK_SKIP_PYTHON_INSTALL === '1') {
    const system = (process.env.BRICK_PYTHON || 'python3').trim();
    if (!hasStack(system)) throw new Error('BRICK_SKIP_PYTHON_INSTALL is set but the chosen Python cannot import torch and transformers');
    return system;
  }

  const target = venvPython();
  if (fs.existsSync(target) && hasStack(target)) return target;

  const base = (process.env.BRICK_PYTHON || 'python3').trim();
  const baseProbe = spawnSync(base, ['--version'], { encoding: 'utf8' });
  if (baseProbe.error || baseProbe.status !== 0) {
    throw new Error(`Python 3 is required to run SystemOne; install it or set BRICK_PYTHON (tried ${base})`);
  }
  fs.mkdirSync(venvDir(), { recursive: true });
  if (!fs.existsSync(target)) {
    log(`creating the SystemOne Python environment at ${venvDir()}`);
    try {
      run(base, ['-m', 'venv', venvDir()]);
    } catch (error) {
      throw new Error(`could not create a Python virtual environment (install python3-venv): ${error.message}`);
    }
  }

  const gpu = detectCuda();
  const driver = gpu ? detectDriverVersion() : null;
  const capability = gpu ? detectComputeCapability() : null;
  const plan = gpu ? chooseTorchIndex(driver, capability) : { cuda: false, index: cpuIndex };
  if (gpu && !plan.cuda) log(`GPU driver ${driver ?? 'unknown'} (compute capability ${capability ?? 'unknown'}) cannot load a pinned torch ${torchVersion} CUDA wheel; installing CPU wheels`);
  log(`installing SystemOne dependencies (${plan.cuda ? 'CUDA' : 'CPU'} torch ${torchVersion})`);
  try {
    run(target, ['-m', 'pip', 'install', '--upgrade', 'pip', '--disable-pip-version-check']);
  } catch {
    // A stale or offline pip is not fatal: the pinned install below still runs.
  }
  const torchArgs = ['-m', 'pip', 'install', '--disable-pip-version-check', `torch==${torchVersion}`];
  if (plan.index) torchArgs.push('--index-url', plan.index);
  run(target, torchArgs);
  run(target, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements]);
  if (!hasStack(target)) throw new Error('SystemOne dependencies installed but torch/transformers are not importable');
  const cuda = plan.cuda && hasCudaRuntime(target);
  if (plan.cuda && !cuda) log('CUDA wheels installed but torch cannot use the GPU; SystemOne will run on CPU');
  fs.writeFileSync(path.join(venvDir(), 'venv.json'), JSON.stringify({ version, torch: torchVersion, cuda, driver, python: target }), { mode: 0o644 });
  return target;
}

module.exports = { ensurePython, venvDir, venvPython, detectCuda, detectDriverVersion, detectComputeCapability, chooseTorchIndex };
