import type { CatalogProvider } from './index.js';

// Anthropic Claude pool. On the Claude Code (/v1/messages) front-end the router
// forwards via anthropic_passthrough.upstream_url, so these entries are used for
// `brick init` skill-vector seeding and documentation rather than per-model
// base_url forwarding. Haiku 4.5 does not support reasoning effort.
export const anthropicCatalog: CatalogProvider = {
  id: 'anthropic',
  label: 'Anthropic',
  type: 'openai_compatible',
  base_url: 'https://api.anthropic.com',
  env_key: 'ANTHROPIC_API_KEY',
  models: [
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', param_size: 'unknown' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', param_size: 'unknown' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', param_size: 'unknown' },
  ],
  multimodal: {
    vision: { model: 'claude-opus-4-8', endpoint: 'https://api.anthropic.com/v1/messages' },
  },
};
