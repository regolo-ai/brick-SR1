vi.mock('../harness.js', () => ({ refreshOfficialHarness: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

const mocks = vi.hoisted(() => ({
  paths: vi.fn(), running: vi.fn(), start: vi.fn(), validate: vi.fn(), select: vi.fn(),
}));
vi.mock('./paths.js', () => ({ paths: mocks.paths }));
vi.mock('../runtime/identity.js', () => ({ profileRunning: mocks.running }));
vi.mock('../runtime/process.js', () => ({ startRuntime: mocks.start }));
vi.mock('../ui/prompts.js', () => ({ select: mocks.select, isCancel: (v: unknown) => typeof v === 'symbol' }));
vi.mock('./credentials.js', async importOriginal => ({ ...await importOriginal<any>(), validateProfileCredentials: mocks.validate }));
import { normalizeRegoloCredentials, saveProfileSettings } from './settings.js';

const config = () => ({ config_version: 1, server_port: 8000, trusted_proxy_header: "X-Existing-Header", complexity_service: {
  enabled: true, base_url: 'https://api.regolo.ai', model_name: 'classifier', bearer_token: '${COMPLEXITY_API_KEY}',
}, skill_router: { complexity_model: { base_url: 'https://api.regolo.ai', bearer_token: '${COMPLEXITY_API_KEY}' },
  models: [{ model: 'inference', base_url: 'https://api.regolo.ai/v1', api_key_env: 'REGOLO_API_KEY' }] } });

describe('Regolo migration', () => {
  it.each([undefined, 'same'])('handles missing or equal legacy credentials: %s', async legacy => {
    const cfg = config(); const values = { REGOLO_API_KEY: 'same', ...(legacy ? { COMPLEXITY_API_KEY: legacy } : {}) };
    const choose = vi.fn();
    await normalizeRegoloCredentials(cfg, values, choose);
    expect(choose).not.toHaveBeenCalled();
    expect(cfg.complexity_service.bearer_token).toBe('${REGOLO_API_KEY}');
    expect(cfg.skill_router.complexity_model.bearer_token).toBe('${REGOLO_API_KEY}');
  });
  it.each(['canonical', 'legacy'] as const)('asks which conflicting key to keep: %s', async choice => {
    const values = { REGOLO_API_KEY: 'canonical', COMPLEXITY_API_KEY: 'legacy' };
    const choose = vi.fn().mockResolvedValue(choice);
    await normalizeRegoloCredentials(config(), values, choose);
    expect(choose).toHaveBeenCalledWith(true);
    expect(values.REGOLO_API_KEY).toBe(choice);
  });
  it('offers migration when the canonical key is absent', async () => {
    const values: Record<string, string> = { COMPLEXITY_API_KEY: 'legacy' };
    const choose = vi.fn().mockResolvedValue('legacy');
    await normalizeRegoloCredentials(config(), values, choose);
    expect(choose).toHaveBeenCalledWith(false);
    expect(values.REGOLO_API_KEY).toBe('legacy');
  });
  it('leaves custom classifier credentials independent', async () => {
    const cfg = config(); cfg.complexity_service.base_url = 'https://custom.test';
    cfg.skill_router.complexity_model.base_url = 'https://custom.test';
    const original = structuredClone(cfg); const choose = vi.fn();
    await normalizeRegoloCredentials(cfg, { COMPLEXITY_API_KEY: 'custom', REGOLO_API_KEY: 'regolo' }, choose);
    expect(cfg).toEqual(original); expect(choose).not.toHaveBeenCalled();
  });
});

describe('settings commit', () => {
  let dir: string; let pp: any; let cfg: any;
  beforeEach(async () => {
    vi.resetAllMocks(); dir = await mkdtemp(join(tmpdir(), 'brick-settings-'));
    pp = { config: join(dir, 'config.yaml'), env: join(dir, '.env') };
    mocks.paths.mockReturnValue(pp); mocks.running.mockResolvedValue(true);
    mocks.start.mockResolvedValue({});
    cfg = config(); cfg.complexity_service.bearer_token = cfg.skill_router.complexity_model.bearer_token = '${REGOLO_API_KEY}';
    await writeFile(pp.config, yaml.dump(cfg)); await writeFile(pp.env, '# keep\nREGOLO_API_KEY=old\nUNRELATED=keep\n');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  it('recreates exactly once on key-only changes and preserves unrelated data', async () => {
    const result = await saveProfileSettings('codex', cfg, { REGOLO_API_KEY: 'new' });
    expect(result.restartedRouter).toBe(true); expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledWith('codex', 8000, true);
    expect(await readFile(pp.env, 'utf8')).toBe('# keep\nREGOLO_API_KEY=new\nUNRELATED=keep\n');
    expect(yaml.load(await readFile(pp.config, 'utf8'))).toEqual(cfg);
    expect(mocks.validate).toHaveBeenCalledWith('codex', cfg, expect.objectContaining({ REGOLO_API_KEY: 'new' }));
  });
  it('leaves every file untouched on failed validation', async () => {
    const before = await Promise.all(Object.values(pp).map(path => readFile(path as string, 'utf8')));
    mocks.validate.mockRejectedValue(new Error('rejected'));
    await expect(saveProfileSettings('codex', cfg, { REGOLO_API_KEY: 'bad' })).rejects.toThrow('rejected');
    expect(await Promise.all(Object.values(pp).map(path => readFile(path as string, 'utf8')))).toEqual(before);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('cancelling migration leaves files untouched', async () => {
    cfg = config(); await writeFile(pp.env, 'COMPLEXITY_API_KEY=legacy\n');
    mocks.select.mockResolvedValue('cancel');
    const before = await readFile(pp.config, 'utf8');
    await expect(saveProfileSettings('codex', cfg)).rejects.toThrow('cancelled');
    expect(await readFile(pp.env, 'utf8')).toBe('COMPLEXITY_API_KEY=legacy\n');
    expect(await readFile(pp.config, 'utf8')).toBe(before);
  });
  it('retains legacy provenance when compute already changed the reference in memory', async () => {
    await writeFile(pp.config, yaml.dump(config()));
    await writeFile(pp.env, 'COMPLEXITY_API_KEY=legacy\n');
    mocks.select.mockResolvedValue('cancel');
    await expect(saveProfileSettings('codex', cfg)).rejects.toThrow('cancelled');
    expect(mocks.select).toHaveBeenCalled();
    expect(await readFile(pp.env, 'utf8')).toBe('COMPLEXITY_API_KEY=legacy\n');
  });
  it('does not claim success when health times out', async () => {
    const before = await readFile(pp.env, 'utf8');
    mocks.start.mockRejectedValue(new Error('Runtime readiness timed out'));
    await expect(saveProfileSettings('codex', cfg, { REGOLO_API_KEY: 'new' })).rejects.toThrow('readiness');
    expect(await readFile(pp.env, 'utf8')).toBe(before);
  });
  it('does not restart another profile occupying the port', async () => {
    mocks.running.mockResolvedValue(false);
    await saveProfileSettings('codex', cfg, { REGOLO_API_KEY: 'new' });
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
