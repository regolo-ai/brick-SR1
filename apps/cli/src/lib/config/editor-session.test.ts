import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ select: vi.fn(), text: vi.fn(), password: vi.fn(), save: vi.fn(), write: vi.fn(), read: vi.fn() }));
vi.mock('../ui/prompts.js', () => ({ select: m.select, text: m.text, password: m.password,
  isCancel: (v: unknown) => typeof v === 'symbol', intro: vi.fn(), outro: vi.fn(), cancel: vi.fn(), note: vi.fn() }));
vi.mock('node:fs/promises', async orig => ({ ...await orig<any>(), readFile: m.read, writeFile: m.write }));
vi.mock('../config/schema.js', () => ({ ConfigSchema: { parse: vi.fn() } }));
vi.mock('../config/settings.js', () => ({ saveProfileSettings: m.save }));
vi.mock('../config/credentials.js', async orig => ({ ...await orig<any>(), validateCredential: vi.fn() }));
import { editConfigProfile } from '../config/editor.js';
import { applyComputeToConfig } from '../config/classifier.js';
const fixture = () => ({ server_port: 8000, providers: {}, default_model: 'model', model_config: { model: {} }, decisions: [],
  complexity_service: { enabled: true, base_url: 'https://api.regolo.ai', protocol: 'openai', model_name: 'old-model' },
  skill_router: { models: [], active_models: [], enabled: false, complexity_model: { base_url: 'https://api.regolo.ai' } },
});
describe('unified settings session', () => {
  beforeEach(() => {
    vi.resetAllMocks(); m.read.mockImplementation(async path => String(path).endsWith('.env') ? '' : JSON.stringify(fixture()));
    m.text.mockResolvedValueOnce('https://api.regolo.ai').mockResolvedValueOnce('new-model');
    m.password.mockResolvedValue('new-key');
    m.select.mockResolvedValueOnce('advanced').mockResolvedValueOnce('complexity').mockResolvedValueOnce('remote');
  });
  it('Discard never writes a staged classifier key or YAML', async () => {
    m.select.mockResolvedValueOnce('discard');
    await editConfigProfile('codex');
    expect(m.save).not.toHaveBeenCalled(); expect(m.write).not.toHaveBeenCalled();
  });
  it('cancelling the password prompt never writes files', async () => {
    m.password.mockResolvedValue(Symbol('cancel'));
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('cancelled'); });
    try { await expect(editConfigProfile('codex')).rejects.toThrow('cancelled'); }
    finally { exit.mockRestore(); }
    expect(m.save).not.toHaveBeenCalled(); expect(m.write).not.toHaveBeenCalled();
  });
  it('Save uses the same classifier mutation as the compute subcommand', async () => {
    m.select.mockResolvedValueOnce('save'); m.save.mockResolvedValue({ routerWasRunning: false });
    await editConfigProfile('codex');
    const expected = fixture(); applyComputeToConfig(expected, 'api', { baseUrl: 'https://api.regolo.ai', model: 'new-model' });
    expect(m.save).toHaveBeenCalledWith('codex', expected, { REGOLO_API_KEY: 'new-key' });
    expect(m.write).not.toHaveBeenCalled();
  });
});
