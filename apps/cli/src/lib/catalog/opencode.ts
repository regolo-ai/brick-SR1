import type { CatalogModel, CatalogProvider } from './index.js';
import { catalog } from './index.js';
import { localBaseUrl } from '../net/local.js';

/** Default local router port, matching the profile config default. */
export const OPENCODE_DEFAULT_PORT = 8000;

/** Router model the user selects in OpenCode; Brick picks the upstream model. */
export const BRICK_ROUTER_MODEL: CatalogModel = {
  id: 'brick',
  label: 'Brick router',
  param_size: 'unknown',
};

/**
 * Every model exposed by the public repo catalog, deduplicated by id, with the
 * `brick` router model first. No model id is invented here.
 */
export function opencodeModels(): CatalogModel[] {
  const models: CatalogModel[] = [BRICK_ROUTER_MODEL];
  const seen = new Set([BRICK_ROUTER_MODEL.id]);
  // Skip our own catalog entry: the barrel (./index.js) registers it, and
  // reading `models` here again would recurse through the lazy getter below.
  for (const [id, provider] of Object.entries(catalog)) {
    if (id === 'opencode') continue;
    for (const model of provider.models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      models.push({ ...model });
    }
  }
  return models;
}

/** Catalog entry for the `opencode` profile, pointing at the local router. */
export function opencodeCatalogForPort(port: number | string = OPENCODE_DEFAULT_PORT): CatalogProvider {
  return {
    id: 'opencode',
    label: 'OpenCode (Brick router)',
    type: 'openai_compatible',
    base_url: `${localBaseUrl(port)}/v1`,
    env_key: '',
    optional: true,
    models: opencodeModels(),
    multimodal: {},
  };
}

/**
 * The entry registered in the catalog barrel. `models` is a lazy getter because
 * `./index.js` imports this module while building the catalog, so the catalog
 * import is still in its temporal dead zone when this module is evaluated.
 */
export const opencodeCatalog: CatalogProvider = {
  id: 'opencode',
  label: 'OpenCode (Brick router)',
  type: 'openai_compatible',
  base_url: `${localBaseUrl(OPENCODE_DEFAULT_PORT)}/v1`,
  env_key: '',
  optional: true,
  get models(): CatalogModel[] {
    return opencodeModels();
  },
  multimodal: {},
};
