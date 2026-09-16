import type { CatalogProvider } from './index.js';

export const openaiCodexCatalog: CatalogProvider = {
  id: 'openai-codex',
  label: 'OpenAI Codex (ChatGPT subscription)',
  type: 'openai_compatible',
  base_url: 'https://chatgpt.com/backend-api/codex',
  env_key: '',
  optional: true,
  models: [
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', param_size: 'unknown', reasoning_family: 'openai_reasoning' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', param_size: 'unknown', reasoning_family: 'openai_reasoning' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', param_size: 'unknown', reasoning_family: 'openai_reasoning' },
    { id: 'gpt-5.5', label: 'GPT-5.5', param_size: 'unknown', reasoning_family: 'openai_reasoning' },
    { id: 'gpt-5.4', label: 'GPT-5.4', param_size: 'unknown', reasoning_family: 'openai_reasoning' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', param_size: 'unknown', reasoning_family: 'openai_reasoning' },
    { id: 'o3', label: 'o3', param_size: 'unknown', reasoning_family: 'openai_reasoning' },
    { id: 'o3-mini', label: 'o3-mini', param_size: 'unknown', reasoning_family: 'openai_reasoning' },
  ],
  multimodal: {},
};
