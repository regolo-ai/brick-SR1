import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @clack/prompts so the hub wizard can be driven without a TTY. Each test
// queues the answers select()/multiselect() return, in call order.
const answers: any[] = [];
vi.mock('@clack/prompts', () => ({
  select: vi.fn(async () => answers.shift()),
  multiselect: vi.fn(async () => answers.shift()),
  note: vi.fn(),
  isCancel: (v: any) => typeof v === 'symbol',
}));

import { runModelsPoolWizard } from './models-pool.js';

function baseCfg(): any {
  return {
    anthropic_passthrough: {
      enabled: true,
      model_map: { medium: 'claude-sonnet-5', hard: 'claude-opus-4-8' },
      model_map_1m: { medium: 'claude-sonnet-5', hard: 'claude-opus-4-8' },
    },
    model_config: {
      'claude-opus-4-8': { preferred_endpoints: ['regolo'], allowed_thinking_modes: ['medium', 'high', 'xhigh'] },
      'claude-sonnet-4-6': { preferred_endpoints: ['regolo'] },
    },
    skill_router: {
      enabled: true,
      active_models: ['claude-sonnet-4-6', 'claude-opus-4-8'],
      models: [
        { model: 'claude-opus-4-8', skill_vector: [0.9, 0.92, 0.86, 0.93, 0.86, 0.93], cost_weight: 1.0, use_reasoning: true },
        { model: 'claude-sonnet-4-6', skill_vector: [0.82, 0.86, 0.83, 0.88, 0.76, 0.88], cost_weight: 0.4, use_reasoning: true },
      ],
    },
  };
}

beforeEach(() => {
  answers.length = 0;
});

describe('runModelsPoolWizard no-op', () => {
  it('returns false when the user opens and immediately picks Done', async () => {
    const cfg = baseCfg();
    answers.push('done'); // main menu → Done
    const changed = await runModelsPoolWizard(cfg);
    expect(changed).toBe(false);
    expect(cfg.skill_router.active_models).toEqual(['claude-sonnet-4-6', 'claude-opus-4-8']);
  });

  it('returns false when the active pool is re-confirmed identical', async () => {
    const cfg = baseCfg();
    answers.push('pool'); // menu → Pool models
    answers.push(['claude-sonnet-4-6', 'claude-opus-4-8']); // same set, reordered-safe
    answers.push('done'); // menu → Done
    const changed = await runModelsPoolWizard(cfg);
    expect(changed).toBe(false);
  });

  it('returns false when thinking modes are re-confirmed identical', async () => {
    const cfg = baseCfg();
    answers.push('thinking'); // menu → Thinking modes
    answers.push('claude-opus-4-8'); // which model
    answers.push(['medium', 'high', 'xhigh']); // same modes
    answers.push('done'); // menu → Done
    const changed = await runModelsPoolWizard(cfg);
    expect(changed).toBe(false);
  });
});

describe('runModelsPoolWizard changes', () => {
  it('activates a new model: seeds skill_router.models + model_config, updates active_models', async () => {
    const cfg = baseCfg();
    answers.push('pool'); // menu → Pool models
    answers.push(['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5']); // add fable-5
    answers.push('done'); // menu → Done
    const changed = await runModelsPoolWizard(cfg);
    expect(changed).toBe(true);

    // active_models updated, in catalog order.
    expect(cfg.skill_router.active_models).toEqual(['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5']);
    // skill_router.models seeded with the catalog vector for fable-5.
    const fable = cfg.skill_router.models.find((m: any) => m.model === 'claude-fable-5');
    expect(fable).toBeDefined();
    expect(fable.skill_vector).toEqual([0.96, 0.94, 0.9, 0.95, 0.91, 0.96]);
    expect(fable.cost_weight).toBe(1.3);
    // model_config seeded with non-empty preferred_endpoints.
    expect(cfg.model_config['claude-fable-5'].preferred_endpoints).toEqual(['regolo']);
  });

  it('deactivating a model removes it from active_models only (keeps skill_router.models entry)', async () => {
    const cfg = baseCfg();
    answers.push('pool'); // menu → Pool models
    answers.push(['claude-opus-4-8']); // drop sonnet-4-6
    answers.push('done'); // menu → Done
    const changed = await runModelsPoolWizard(cfg);
    expect(changed).toBe(true);
    expect(cfg.skill_router.active_models).toEqual(['claude-opus-4-8']);
    // sonnet-4-6 entry is retained for cheap re-activation.
    expect(cfg.skill_router.models.some((m: any) => m.model === 'claude-sonnet-4-6')).toBe(true);
  });

  it('refuses an empty pool: keeps the current active_models', async () => {
    const cfg = baseCfg();
    answers.push('pool'); // menu → Pool models
    answers.push([]); // deselect everything
    answers.push('done'); // menu → Done
    const changed = await runModelsPoolWizard(cfg);
    expect(changed).toBe(false);
    expect(cfg.skill_router.active_models).toEqual(['claude-sonnet-4-6', 'claude-opus-4-8']);
  });

  it('changing a fallback difficulty updates model_map', async () => {
    const cfg = baseCfg();
    answers.push('difficulty'); // menu → Difficulty mapping (fallback)
    // pool = [sonnet-4-6, opus-4-8]; prompts iterate that order.
    answers.push('easy'); // sonnet-4-6 → easy (was medium via map? sonnet-4-6 not mapped → default medium)
    answers.push('hard'); // opus-4-8 stays hard
    answers.push('done'); // menu → Done
    const changed = await runModelsPoolWizard(cfg);
    expect(changed).toBe(true);
    expect(cfg.anthropic_passthrough.model_map.easy).toBe('claude-sonnet-4-6');
  });
});
