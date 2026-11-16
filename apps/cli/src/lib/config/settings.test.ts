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
import { saveProfileSettings } from './settings.js';

const config = () => ({ config_version: 2, server_port: 8000, trusted_proxy_header: "X-Existing-Header",
  skill_router: { capabilities: ['coding', 'creative_synthesis', 'instruction_following', 'math_reasoning', 'planning_agentic', 'world_knowledge'],
    systemone: { local_path: 'models/systemone' }, knob: 0,
    models: [{ model: 'inference', skill_vector: [0.1,0.2,0.3,0.4,0.5,0.6], base_url: 'https://api.regolo.ai/v1', api_key_env: 'REGOLO_API_KEY' }] } });

describe('settings commit', () => {
  let dir: string; let pp: any; let cfg: any;
  beforeEach(async () => {
    vi.resetAllMocks(); dir = await mkdtemp(join(tmpdir(), 'brick-settings-'));
    pp = { config: join(dir, 'config.yaml'), env: join(dir, '.env') };
    mocks.paths.mockReturnValue(pp); mocks.running.mockResolvedValue(true);
    mocks.start.mockResolvedValue({});
    cfg = config();
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
