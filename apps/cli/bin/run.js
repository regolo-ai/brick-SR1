#!/usr/bin/env node
process.env.NODE_ENV = 'production';
const { execute } = await import('@oclif/core');
await execute({ dir: import.meta.url });
