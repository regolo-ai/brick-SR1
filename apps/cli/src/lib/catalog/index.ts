import { regoloCatalog } from './regolo.js';
import { openaiCatalog } from './openai.js';
import { openaiCodexCatalog } from './openai-codex.js';
import { anthropicCatalog } from './anthropic.js';
import { claudeApiCatalog } from './claude-api.js';
import { claudeCodeCatalog } from './claude-code.js';
import { openrouterCatalog } from './openrouter.js';

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
  optional?: boolean;
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
  'openai-codex': openaiCodexCatalog,
  anthropic: anthropicCatalog,
  'claude-api': claudeApiCatalog,
  'claude-code': claudeCodeCatalog,
  openrouter: openrouterCatalog,
};

export const reasoningFamiliesDefault = {
  qwen3: { parameter: 'enable_thinking' },
  minimax: { parameter: 'reasoning_effort' },
  openai_reasoning: { parameter: 'reasoning_effort' },
};
