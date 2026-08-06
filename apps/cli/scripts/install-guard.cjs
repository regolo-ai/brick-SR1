#!/usr/bin/env node
const { cleanup } = require('./docker-cleanup.cjs');

const globalInstall =
  process.env.npm_config_global === 'true' ||
  process.env.npm_config_location === 'global';

if (globalInstall) process.exitCode = cleanup({ pull: true, strict: false });
