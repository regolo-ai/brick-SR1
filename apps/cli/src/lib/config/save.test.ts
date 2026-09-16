import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
const faults = vi.hoisted(() => ({ configWrite: false }));
vi.mock('./atomic-file.js', async original => {
  const actual = await original<any>();
  return { atomicWrite: async (path: string, ...args: any[]) => {
    if (faults.configWrite && path.endsWith('/config.yaml')) throw new Error('injected config write failure');
    return actual.atomicWrite(path, ...args);
  } };
});
afterEach(() => { faults.configWrite = false; delete process.env.BRICK_HOME; vi.resetModules(); });
describe('credential migration transaction', () => {
  it('preserves existing classifier credentials and rolls back env when saving fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'brick-profile-save-'));
    process.env.BRICK_HOME = home;
    vi.resetModules();
    const { saveConfigText } = await import('./save.js');
    const dir = join(home, 'profiles/work');
    await mkdir(dir, { recursive: true });
    const oldConfig = 'default_model: old\n';
    const oldEnv = '# preserved\nREGOLO_API_KEY=classifier-secret\n';
    await writeFile(join(dir, 'config.yaml'), oldConfig);
    await writeFile(join(dir, '.env'), oldEnv);
    const candidate = { providers: { regolo: { base_url: 'https://api.regolo.ai', api_key: 'independent-provider-key' } } };
    try {
      faults.configWrite = true;
      await expect(saveConfigText(yaml.dump(candidate), 'work')).rejects.toThrow('injected');
      expect(await readFile(join(dir, '.env'), 'utf8')).toBe(oldEnv);
      expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toBe(oldConfig);
      faults.configWrite = false;
      await saveConfigText(yaml.dump(candidate), 'work');
      const saved = yaml.load(await readFile(join(dir, 'config.yaml'), 'utf8')) as any;
      expect(saved.providers.regolo.api_key).toBe('${REGOLO_API_KEY_2}');
      expect(await readFile(join(dir, '.env'), 'utf8')).toContain('REGOLO_API_KEY=classifier-secret\nREGOLO_API_KEY_2=independent-provider-key');
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
