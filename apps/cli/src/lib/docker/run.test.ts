import { describe, expect, it } from 'vitest';
import { dockerComposeArgs } from './run.js';

describe('docker compose invocation', () => {
  it('uses Brick\'s managed project name by default', () => {
    expect(dockerComposeArgs('codex', '/profiles/codex/docker-compose.yml', ['down'])).toEqual([
      'compose',
      '-p',
      'brick-codex',
      '-f',
      '/profiles/codex/docker-compose.yml',
      'down',
    ]);
  });

  it('can target the Compose default project for legacy teardown', () => {
    expect(dockerComposeArgs('codex', '/profiles/codex/docker-compose.yml', ['down'], false)).toEqual([
      'compose',
      '-f',
      '/profiles/codex/docker-compose.yml',
      'down',
    ]);
  });
});
