import type { CatalogProvider } from './index.js';

export const openrouterCatalog: CatalogProvider = {
  id: 'openrouter',
  label: 'OpenRouter',
  type: 'openai_compatible',
  base_url: 'https://openrouter.ai/api/v1',
  env_key: 'OPENROUTER_API_KEY',
  models: [],
  multimodal: {},
};
