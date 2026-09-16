import type { CatalogProvider } from './index.js';

export const claudeApiCatalog: CatalogProvider = {
  id: 'claude-api',
  label: 'Claude (Api Key)',
  type: 'openai_compatible',
  base_url: 'https://api.anthropic.com',
  env_key: 'ANTHROPIC_API_KEY',
  models: [
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', param_size: 'unknown' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', param_size: 'unknown' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', param_size: 'unknown' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', param_size: 'unknown' },
    { id: 'claude-fable-5', label: 'Claude Fable 5', param_size: 'unknown' },
  ],
  multimodal: {
    vision: { model: 'claude-opus-4-8', endpoint: 'https://api.anthropic.com/v1/messages' },
  },
};
