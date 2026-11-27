import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ select: vi.fn(), text: vi.fn(), save: vi.fn(), write: vi.fn(), read: vi.fn() }));
vi.mock('../ui/prompts.js', () => ({ select: mocks.select, text: mocks.text, isCancel: (v: unknown) => typeof v === 'symbol', intro: vi.fn(), outro: vi.fn(), cancel: vi.fn(), note: vi.fn() }));
vi.mock('node:fs/promises', async original => ({ ...await original<any>(), readFile: mocks.read, writeFile: mocks.write }));
vi.mock('../config/schema.js', () => ({ ConfigSchema: { parse: vi.fn() } }));
vi.mock('./native-migration.js', () => ({ migrateNativeProfile: vi.fn() }));
vi.mock('../config/settings.js', () => ({ saveProfileSettings: mocks.save }));
import { editConfigProfile } from './editor.js';
const fixture = () => ({ config_version: 2, server_port: 8000, providers: {}, default_model: 'model', model_config: { model: {} }, skill_router: { knob: 0, models: [], active_models: [], enabled: false } });

describe('SystemOne editor session', () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.read.mockImplementation(async path => String(path).endsWith('.env') ? '' : JSON.stringify(fixture()));
    mocks.select.mockResolvedValueOnce('knob'); mocks.text.mockResolvedValue('.5');
  });
  it('Discard never writes a staged knob', async () => {
    mocks.select.mockResolvedValueOnce('discard'); await editConfigProfile('codex');
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  });
  it('cancelling the knob prompt leaves the profile unchanged', async () => {
    mocks.text.mockResolvedValue(Symbol('cancel')); mocks.select.mockResolvedValueOnce('discard');
    await editConfigProfile('codex'); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('Save writes the knob through the common settings commit boundary', async () => {
    mocks.select.mockResolvedValueOnce('save'); mocks.save.mockResolvedValue({ routerWasRunning: false });
    await editConfigProfile('codex'); const expected = fixture(); expected.skill_router.knob = .5;
    expect(mocks.save).toHaveBeenCalledWith('codex', expected, {}); expect(mocks.write).not.toHaveBeenCalled();
  });
});
