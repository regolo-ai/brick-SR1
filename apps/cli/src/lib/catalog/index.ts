import { regoloCatalog } from './regolo.js';
import { openaiCatalog } from './openai.js';
import { anthropicCatalog } from './anthropic.js';
import { localCatalog } from './local.js';

export interface CatalogModel {
  id: string;
  label: string;
  param_size: string;
  reasoning_family?: string;
}

export interface MultimodalEndpoint {
  model: string;
  endpoint: string;
}

export interface CatalogProvider {
  id: string;
  label: string;
  type: string;
  base_url: string;
  env_key: string;
  models: CatalogModel[];
  multimodal: {
    stt?: MultimodalEndpoint;
    ocr?: MultimodalEndpoint;
    vision?: MultimodalEndpoint;
  };
}

export const catalog: Record<string, CatalogProvider> = {
  regolo: regoloCatalog,
  openai: openaiCatalog,
  anthropic: anthropicCatalog,
  local: localCatalog,
};

export const reasoningFamiliesDefault = {
  qwen3: { type: 'chat_template_kwargs', parameter: 'enable_thinking' },
  minimax: { type: 'reasoning_effort', parameter: 'reasoning_effort' },
  openai_reasoning: { type: 'reasoning_effort', parameter: 'reasoning_effort' },
};
