import type { CatalogModel, CatalogProvider } from './index.js';
import { regoloCatalog } from './regolo.js';
import { openaiCatalog } from './openai.js';
import { openaiCodexCatalog } from './openai-codex.js';
import { anthropicCatalog } from './anthropic.js';
import { claudeApiCatalog } from './claude-api.js';
import { claudeCodeCatalog } from './claude-code.js';
import { openrouterCatalog } from './openrouter.js';
import { localBaseUrl } from '../net/local.js';

// The reserved `opencode` profile talks to the local Brick router, not to an
// upstream provider, so this entry advertises no credential and points at the
// default loopback port. The served model list is the whole public Brick catalog
// plus the `brick` router model: OpenCode picks `brick` and Brick decides the
// upstream model.

/** Every model already published by the Brick catalog, deduplicated by id. */
function upstreamCatalogModels(): CatalogModel[] {
  const providers: CatalogProvider[] = [
    regoloCatalog,
    openaiCatalog,
    openaiCodexCatalog,
    anthropicCatalog,
    claudeApiCatalog,
    claudeCodeCatalog,
    openrouterCatalog,
  ];
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
  }
  return models;
}

export const opencodeCatalog: CatalogProvider = {
  id: 'opencode',
  label: 'Brick (OpenCode)',
  type: 'openai_compatible',
  base_url: `${localBaseUrl(8000)}/v1`,
  env_key: '',
  optional: true,
  models: [
    ...upstreamCatalogModels(),
    { id: 'brick', label: 'Brick (local router)', param_size: 'unknown' },
  ],
  multimodal: {},
};
