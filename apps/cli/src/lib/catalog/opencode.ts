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
  for (const provider of Object.values(catalog)) {
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

export const opencodeCatalog: CatalogProvider = opencodeCatalogForPort();
