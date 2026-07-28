import type { CatalogProvider } from './index.js';

export const regoloCatalog: CatalogProvider = {
  id: 'regolo',
  label: 'Regolo AI',
  type: 'openai_compatible',
  base_url: 'https://api.regolo.ai/v1',
  env_key: 'REGOLO_API_KEY',
  models: [],
  multimodal: {
    stt: { model: 'faster-whisper-large-v3', endpoint: 'https://api.regolo.ai/v1/audio/transcriptions' },
    ocr: { model: 'deepseek-ocr-2', endpoint: 'https://api.regolo.ai/v1/chat/completions' },
    vision: { model: 'qwen3.5-122b', endpoint: 'https://api.regolo.ai/v1/chat/completions' },
  },
};
