import type { CatalogProvider } from './index.js';

export const openaiCatalog: CatalogProvider = {
  id: 'openai',
  label: 'OpenAI',
  type: 'openai_compatible',
  base_url: 'https://api.openai.com/v1',
  env_key: 'OPENAI_API_KEY',
  models: [
    // Brick / Codex routable pool (reasoning models use top-level reasoning_effort).
    { id: 'gpt-5.5', label: 'GPT-5.5', param_size: 'unknown', reasoning_family: 'openai_reasoning' },
    { id: 'gpt-5.4', label: 'GPT-5.4', param_size: 'unknown', reasoning_family: 'openai_reasoning' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', param_size: 'unknown', reasoning_family: 'openai_reasoning' },
    { id: 'o3', label: 'o3', param_size: 'unknown', reasoning_family: 'openai_reasoning' },
    { id: 'o3-mini', label: 'o3-mini', param_size: 'unknown', reasoning_family: 'openai_reasoning' },
    // Legacy non-reasoning models kept for manual selection.
    { id: 'gpt-4o', label: 'GPT-4o', param_size: 'unknown' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini', param_size: 'unknown' },
    { id: 'gpt-4.1', label: 'GPT-4.1', param_size: 'unknown' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', param_size: 'unknown' },
  ],
  multimodal: {
    stt: { model: 'whisper-1', endpoint: 'https://api.openai.com/v1/audio/transcriptions' },
    vision: { model: 'gpt-4o', endpoint: 'https://api.openai.com/v1/chat/completions' },
  },
};
