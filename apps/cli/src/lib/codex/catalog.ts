import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { paths } from '../config/paths.js';
import { codexHome, getTopLevelString, readCodexConfig } from './config-toml.js';
import { execa } from 'execa';

type Model = Record<string, any> & { slug: string };

interface CodexCatalog {
  models: Model[];
  [key: string]: any;
}

/**
 * Path of the account's authenticated Codex catalog.
 *
 * While a Brick profile is wired, Brick points Codex's `model_catalog_json` at
 * its own generated catalog. That file is derived output, not the account's
 * catalog: reading it back would make every later setup run blind to Codex
 * adding or retiring a model (and to the models the account cannot use). When
 * the configured path is Brick's managed file, fall back to Codex's own cache.
 */
export function authenticatedCatalogPath(): string {
  const configured = getTopLevelString(readCodexConfig(), 'model_catalog_json');
  const managed = paths('codex').codexCatalog;
  if (configured && configured !== managed) return configured;
  return join(codexHome(), 'models_cache.json');
}

export async function readAuthenticatedCodexCatalog(): Promise<CodexCatalog> {
  const cache = authenticatedCatalogPath();
  try {
    return JSON.parse(await readFile(cache, 'utf8')) as CodexCatalog;
  } catch (error: any) {
    throw new Error(
      `Codex is not initialized: cannot read the authenticated model catalog at ${cache}. ` +
      `Install Codex, run \`codex login\` once, then retry \`brick start codex\` (${error?.message ?? error}).`
    );
  }
}

/**
 * Active pool models that the authenticated Codex catalog does not advertise.
 * An empty catalog is treated as unknown (returns no names) so a stale or
 * partially written cache never blocks a working setup.
 */
export function missingCatalogModels(config: any, catalog: CodexCatalog): string[] {
  if (!Array.isArray(catalog?.models) || catalog.models.length === 0) return [];
  const available = new Set<string>();
  for (const model of catalog.models) if (typeof model?.slug === 'string' && model.slug) available.add(model.slug);
  if (available.size === 0) return [];
  const declared = Array.isArray(config?.skill_router?.models)
    ? config.skill_router.models.map((entry: any) => entry?.model).filter((id: any) => typeof id === 'string')
    : [];
  const active = Array.isArray(config?.skill_router?.active_models) && config.skill_router.active_models.length
    ? config.skill_router.active_models
    : declared;
  return [...new Set<string>(active)].filter((id) => !available.has(id));
}

/**
 * Catalog for profile creation and migration. The cache file is the normal
 * source, but it can be readable yet stale: the Codex client writes a subset
 * of the full catalog (e.g. only 5.6 models) while `codex debug models` still
 * advertises the active pool. When any `required` slug is missing from the
 * cache, merge in the client's full catalog so we neither warn about nor prune
 * models that are actually available. A fresh `codex login` may not have
 * written the cache yet; then ask the client directly so `brick start codex`
 * works on a clean machine.
 */
export async function readCodexCatalogForSetup(required: string[] = []): Promise<CodexCatalog> {
  let cached: CodexCatalog | undefined;
  try {
    cached = await readAuthenticatedCodexCatalog();
  } catch (cacheError) {
    // Cache unreadable — fall through to the client below.
    if (required.length === 0) {
      // Preserve the actionable error when no client is available either.
      try {
        const stdout = (await execa('codex', ['debug', 'models'], { reject: true, timeout: 15_000 })).stdout;
        const catalog = JSON.parse(stdout) as CodexCatalog;
        if (Array.isArray(catalog?.models) && catalog.models.length > 0) return catalog;
      } catch { /* keep the actionable cache error below */ }
      throw cacheError;
    }
  }

  const missing = required.filter((id) => !cached?.models?.some((model) => model?.slug === id));
  if (cached && missing.length === 0) return cached;

  let live: CodexCatalog | undefined;
  try {
    const stdout = (await execa('codex', ['debug', 'models'], { reject: true, timeout: 15_000 })).stdout;
    const parsed = JSON.parse(stdout) as CodexCatalog;
    if (Array.isArray(parsed?.models) && parsed.models.length > 0) live = parsed;
  } catch { /* use the cache as-is if the client is unavailable */ }

  if (!live) {
    if (cached) return cached;
    throw new Error('Codex is not initialized: no authenticated model catalog and `codex debug models` is unavailable. Run `codex login`, then retry `brick start codex`.');
  }
  if (!cached) return live;
  // Union: client catalog first (fuller), then cache-only entries.
  const seen = new Set<string>();
  const models: Model[] = [];
  for (const model of [...live.models, ...cached.models]) {
    if (!model?.slug || seen.has(model.slug)) continue;
    seen.add(model.slug);
    models.push(model);
  }
  return { ...live, models };
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

export function activePoolModels(config: any): string[] {
  const declared = Array.isArray(config?.skill_router?.models)
    ? config.skill_router.models.map((entry: any) => entry?.model).filter((id: any) => typeof id === 'string')
    : [];
  const active = Array.isArray(config?.skill_router?.active_models) && config.skill_router.active_models.length
    ? config.skill_router.active_models
    : declared;
  return [...new Set<string>(active)];
}

async function readCatalogFile(target: string): Promise<CodexCatalog | null> {
  try { return JSON.parse(await readFile(target, 'utf8')) as CodexCatalog; }
  catch { return null; }
}

/**
 * Keep the models this profile actively routes to in the generated catalog
 * even when the authenticated cache momentarily omits them. A stale or
 * partially written cache must never remove a working pool model from Codex's
 * own catalog (that would also break context discovery on the next start).
 */
export function preserveRequiredModels(source: CodexCatalog, previous: CodexCatalog | null, required: string[]): CodexCatalog {
  if (!previous || !Array.isArray(previous.models) || required.length === 0) return source;
  const available = new Set(source.models.map((model) => model?.slug).filter(Boolean));
  const keep = previous.models.filter((model) => typeof model?.slug === 'string' && required.includes(model.slug) && !available.has(model.slug));
  if (keep.length === 0) return source;
  return { ...source, models: [...source.models, ...keep] };
}

export async function writeCodexModelCatalog(profile: string, _modelIds?: string[], configOverride?: any): Promise<string> {
  const target = paths(profile).codexCatalog;
  const config = configOverride ?? yaml.load(await readFile(paths(profile).config, 'utf8')) as any;
  const required = activePoolModels(config);
  const source = preserveRequiredModels(await readCodexCatalogForSetup(), await readCatalogFile(target), required);

  const catalog = withBrickModel(source, activeBrickContextWindow(config));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.brick.tmp`;
  await writeFile(temporary, JSON.stringify(catalog, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, target);
  return target;
}
