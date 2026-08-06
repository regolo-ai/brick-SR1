import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../config/paths.js';

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'templates');
const STARTER_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);

export async function writeCodexModelCatalog(profile: string, modelIds?: string[]): Promise<string> {
  const target = paths(profile).codexCatalog;
  const template = JSON.parse(await readFile(join(TEMPLATE_DIR, 'codex-model-catalog.json'), 'utf8')) as any;
  const ids = modelIds?.length ? modelIds : [...STARTER_MODELS];
  const bySlug = new Map((template.models ?? []).map((m: any) => [m.slug, m]));
  const brick = bySlug.get('brick');
  template.models = [brick, ...ids].filter(Boolean).map((slugOrModel: any) => {
    const slug = typeof slugOrModel === 'string' ? slugOrModel : slugOrModel.slug;
    return bySlug.get(slug) ?? {
    slug,
    display_name: slug,
    description: `Codex model exposed by Brick (${slug}).`,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ effort, description: `${effort} reasoning` })),
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    };
  });
  template.client_version = 'brick';
  await writeFile(target, JSON.stringify(template, null, 2) + '\n', { mode: 0o600 });
  return target;
}
