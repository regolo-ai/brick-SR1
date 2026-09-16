import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { paths } from '../config/paths.js';
import { codexHome, getTopLevelString, readCodexConfig } from './config-toml.js';

type Model = Record<string, any> & { slug: string };

interface CodexCatalog {
  models: Model[];
  [key: string]: any;
}

export async function readAuthenticatedCodexCatalog(): Promise<CodexCatalog> {
  const cache = getTopLevelString(readCodexConfig(), 'model_catalog_json') || join(codexHome(), 'models_cache.json');
  try {
    return JSON.parse(await readFile(cache, 'utf8')) as CodexCatalog;
  } catch (error: any) {
    throw new Error(`cannot read Codex's authenticated model catalog at ${cache}: ${error?.message ?? error}`);
  }
}

/**
 * Preserve the authenticated Codex catalog verbatim and append Brick as a
 * virtual model. The first official entry supplies version-specific schema
 * fields, so this stays compatible when Codex evolves its catalog format.
 */
export function withBrickModel(source: CodexCatalog, contextWindow: number): CodexCatalog {
  if (!Array.isArray(source?.models) || source.models.length === 0) {
    throw new Error('Codex model cache contains no models');
  }
  const official = source.models.filter((model) => model?.slug && model.slug !== 'brick');
  if (official.length === 0) throw new Error('Codex model cache contains no official models');
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new Error('Every active Brick model requires an explicit context_window_size');
  }

  const brick: Model = structuredClone(official[0]);
  Object.assign(brick, {
    slug: 'brick',
    display_name: 'Brick Router',
    description: 'Brick auto-routing across the active private model pool',
    visibility: 'list',
    priority: Math.max(0, ...official.map((model) => Number(model.priority) || 0)) + 1,
    upgrade: null,
    context_window: contextWindow,
    max_context_window: contextWindow,
    effective_context_window_percent: 100,
  });

  return { ...source, models: [...official, brick] };
}

export function activeBrickContextWindow(config: any): number {
  const configured = Array.isArray(config?.skill_router?.models) ? config.skill_router.models.map((entry: any) => entry?.model) : [];
  const active = Array.isArray(config?.skill_router?.active_models) && config.skill_router.active_models.length
    ? config.skill_router.active_models
    : configured;
  if (!active.length) throw new Error('The active Codex routing pool is empty');
  const windows = active.map((id: string) => Number(config?.model_config?.[id]?.context_window_size));
  if (windows.some((value: number) => !Number.isInteger(value) || value <= 0)) {
    throw new Error('Every active Brick model requires an explicit context_window_size');
  }
  return Math.min(...windows);
}

export async function writeCodexModelCatalog(profile: string, _modelIds?: string[], configOverride?: any): Promise<string> {
  const target = paths(profile).codexCatalog;
  const source = await readAuthenticatedCodexCatalog();

  const config = configOverride ?? yaml.load(await readFile(paths(profile).config, 'utf8')) as any;
  const catalog = withBrickModel(source, activeBrickContextWindow(config));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.brick.tmp`;
  await writeFile(temporary, JSON.stringify(catalog, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, target);
  return target;
}
