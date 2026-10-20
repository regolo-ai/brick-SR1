const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pythonEnv = require('../scripts/python-env.cjs');

function script(directory, name, body) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function withEnv(values, run) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return run(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('an explicit BRICK_SYSTEMONE_PYTHON is validated and reused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brick-python-'));
  try {
    const good = script(root, 'python', '#!/bin/sh\nexit 0\n');
    assert.equal(withEnv({ BRICK_SYSTEMONE_PYTHON: good }, () => pythonEnv.ensurePython()), good);
    const bad = script(root, 'broken', '#!/bin/sh\nexit 1\n');
    assert.throws(() => withEnv({ BRICK_SYSTEMONE_PYTHON: bad }, () => pythonEnv.ensurePython()), /cannot import torch and transformers/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a managed virtual environment is reused without reinstalling', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brick-home-'));
  try {
    process.env.BRICK_HOME = home;
    try {
      const python = pythonEnv.venvPython();
      fs.mkdirSync(path.dirname(python), { recursive: true });
      script(path.dirname(python), 'python', '#!/bin/sh\nexit 0\n');
      assert.equal(withEnv({ BRICK_SYSTEMONE_PYTHON: undefined }, () => pythonEnv.ensurePython()), python);
    } finally { delete process.env.BRICK_HOME; }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

const cu126 = 'https://download.pytorch.org/whl/cu126';
const cu128 = 'https://download.pytorch.org/whl/cu128';
const cpu = 'https://download.pytorch.org/whl/cpu';

test('the torch wheel index follows the installed driver version', () => {
  assert.deepEqual(pythonEnv.chooseTorchIndex(590), { cuda: true, index: cu128 });
  assert.deepEqual(pythonEnv.chooseTorchIndex(570), { cuda: true, index: cu128 });
  assert.deepEqual(pythonEnv.chooseTorchIndex(560), { cuda: true, index: cu126 });
  assert.equal(pythonEnv.chooseTorchIndex(550).cuda, false);
  assert.equal(pythonEnv.chooseTorchIndex(null).cuda, false);
  assert.equal(withEnv({ BRICK_CUDA: '0' }, () => pythonEnv.chooseTorchIndex(590)).cuda, false);
});

test('one cu128 build covers pre-Blackwell and Blackwell GPUs', () => {
  assert.deepEqual(pythonEnv.chooseTorchIndex(570, 8.9), { cuda: true, index: cu128 });
  assert.deepEqual(pythonEnv.chooseTorchIndex(570, 12.0), { cuda: true, index: cu128 });
  assert.deepEqual(pythonEnv.chooseTorchIndex(560, 8.9), { cuda: true, index: cu126 });
  assert.equal(pythonEnv.chooseTorchIndex(560, 12.0).cuda, false);
  assert.deepEqual(pythonEnv.chooseTorchIndex(550, 8.9), { cuda: false, index: cpu });
});

test('the driver version is parsed from nvidia-smi', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brick-driver-'));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${root}:${previousPath}`;
    assert.equal(pythonEnv.detectDriverVersion(), null);
    script(root, 'nvidia-smi', '#!/bin/sh\necho "570.211.01"\n');
    assert.equal(pythonEnv.detectDriverVersion(), '570');
    assert.equal(withEnv({ BRICK_CUDA: '0' }, () => pythonEnv.detectDriverVersion()), null);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CUDA detection honours the opt-out and a present GPU', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brick-cuda-'));
  const previousPath = process.env.PATH;
  try {
    assert.equal(withEnv({ BRICK_CUDA: '0' }, () => pythonEnv.detectCuda()), false);
    process.env.PATH = `${root}:${previousPath}`;
    try {
      assert.equal(pythonEnv.detectCuda(), false);
      script(root, 'nvidia-smi', '#!/bin/sh\necho "NVIDIA L4"\n');
      assert.equal(pythonEnv.detectCuda(), true);
    } finally { process.env.PATH = previousPath; }
    assert.equal(withEnv({ BRICK_CUDA: '0' }, () => pythonEnv.detectCuda()), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
