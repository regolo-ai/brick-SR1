import * as p from '@clack/prompts';

type AnyConfig = Record<string, any>;

type CodexCatalogModel = {
  value: string;
  label: string;
  hint: string;
  skill_vector: number[];
  cost_weight: number;
};

const OPENAI_MODELS: readonly CodexCatalogModel[] = [
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', hint: 'fast and affordable frontier model', skill_vector: [0.80, 0.80, 0.75, 0.82, 0.83, 0.82], cost_weight: 0.1 },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', hint: 'balanced agentic coding model', skill_vector: [0.85, 0.85, 0.80, 0.88, 0.86, 0.88], cost_weight: 0.4 },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', hint: 'most capable frontier model', skill_vector: [0.90, 0.91, 0.86, 0.94, 0.92, 0.94], cost_weight: 1.0 },
] as const;

const THINKING_MODE_OPTIONS = [
  { value: 'off', label: 'Off', hint: 'no reasoning injection' },
  { value: 'low', label: 'Low', hint: '' },
  { value: 'medium', label: 'Medium', hint: '' },
  { value: 'high', label: 'High', hint: '' },
  { value: 'xhigh', label: 'XHigh', hint: '' },
  { value: 'max', label: 'Max', hint: '' },
] as const;

export function codexModelCatalog(): Array<{ value: string; label: string; hint: string }> {
  return OPENAI_MODELS.map(({ value, label, hint }) => ({ value, label, hint }));
}

export async function runCodexModelsPoolWizard(cfg: AnyConfig): Promise<boolean> {
  if (!cfg.skill_router || typeof cfg.skill_router !== 'object') {
    p.note('This profile has no skill_router block.', 'models');
    return false;
  }

  const currentModels = Array.isArray(cfg.skill_router.models) ? cfg.skill_router.models : [];
  const currentById = new Map<string, any>();
  for (const m of currentModels) {
    if (typeof m?.model === 'string') currentById.set(m.model, m);
  }

  const selectedModels = await p.multiselect({
    message: 'Select OpenAI models in the Codex pool',
    options: OPENAI_MODELS.map((m) => ({
      value: m.value,
      label: m.label,
      hint: m.hint,
      selected: currentById.has(m.value),
    })),
    required: true,
  });
  if (p.isCancel(selectedModels)) return false;

  const selected = selectedModels as string[];
  if (selected.length === 0) return false;

  cfg.skill_router.models = selected.map((modelId) => {
    const existing = currentById.get(modelId);
    if (existing) return existing;
    const catalog = OPENAI_MODELS.find((m) => m.value === modelId)!;
    return {
      model: modelId,
      skill_vector: [...catalog.skill_vector],
      cost_weight: catalog.cost_weight,
      use_reasoning: true,
      base_url: 'https://api.openai.com/v1',
    };
  });

  cfg.model_config = cfg.model_config && typeof cfg.model_config === 'object' ? cfg.model_config : {};
  for (const modelId of selected) {
    cfg.model_config[modelId] = cfg.model_config[modelId] && typeof cfg.model_config[modelId] === 'object'
      ? cfg.model_config[modelId]
      : {};
    cfg.model_config[modelId].preferred_endpoints = Array.isArray(cfg.model_config[modelId].preferred_endpoints)
      ? cfg.model_config[modelId].preferred_endpoints
      : ['openai'];
    if (!cfg.model_config[modelId].preferred_endpoints.includes('openai')) {
      cfg.model_config[modelId].preferred_endpoints.unshift('openai');
    }
    cfg.model_config[modelId].param_size = cfg.model_config[modelId].param_size ?? 'unknown';
    cfg.model_config[modelId].reasoning_family = cfg.model_config[modelId].reasoning_family ?? 'openai_reasoning';
  }

  if (!selected.includes(cfg.default_model)) {
    cfg.default_model = selected[0];
  }

  for (const modelId of selected) {
    const label = OPENAI_MODELS.find((m) => m.value === modelId)?.label ?? modelId;
    const currentModes = cfg.model_config?.[modelId]?.allowed_thinking_modes ?? [];
    const modes = await p.multiselect({
      message: `Thinking modes for ${label}`,
      options: THINKING_MODE_OPTIONS.map((m) => ({
        value: m.value,
        label: m.label,
        hint: m.hint,
        selected: currentModes.includes(m.value),
      })),
      required: false,
    });
    if (p.isCancel(modes)) return false;

    const modeList = modes as string[];
    if (modeList.includes('off') && modeList.length > 1) {
      p.note('"Off" disables reasoning injection; setting to ["off"].', 'thinking modes');
      cfg.model_config[modelId].allowed_thinking_modes = ['off'];
    } else if (modeList.length === 0) {
      delete cfg.model_config[modelId].allowed_thinking_modes;
    } else {
      cfg.model_config[modelId].allowed_thinking_modes = modeList;
    }
  }

  return true;
}
