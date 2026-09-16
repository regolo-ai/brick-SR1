#!/usr/bin/env node
process.env.NODE_ENV = 'production';
const removed = new Set(['init', 'config', 'profiles', 'serve', 'down', 'settings', 'skills', 'add', 'remove', 'claude']);
if (removed.has(process.argv[2])) {
  console.error(`'brick ${process.argv[2]}' was removed in Brick 3.0. Use the profile-based commands; run 'brick --help'.`);
  process.exitCode = 1;
} else {
const { execute } = await import('@oclif/core');
await execute({ dir: import.meta.url });
}
