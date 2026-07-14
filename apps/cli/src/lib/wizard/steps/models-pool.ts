// Configurazione del pool di modelli Claude per lo skill router.
//
// Il "pool" e l'insieme dei vettori-modello candidati nello spazio di
// proiezione della query: attivare/disattivare un modello lo include/esclude dal
// calcolo della distanza (skill_router.active_models). Questo pilota il routing
// skill-vector REALE, non anthropic_passthrough.model_map (che resta solo
// fallback quando lo skill router e off/non disponibile).
//
// Il wizard e un menu "hub": riaprendolo vedi lo stato corrente e entri solo
// nella sezione che vuoi cambiare. Se non tocchi nulla (o riconfermi valori
// identici) ritorna `false` e il chiamante non salva ne riavvia il router.

import * as p from '@clack/prompts';
import { type BrickConfig } from '../../../lib/config/schema.js';

/**
 * Catalogo modelli Claude con skill vector calibrato (ordine capabilities:
 * coding, creative_synthesis, instruction_following, math_reasoning,
 * planning_agentic, world_knowledge; valori in (0,1)). Usato per SEEDARE una
 * voce skill_router.models quando un modello viene attivato per la prima volta.
 */
const CLAUDE_MODELS = [
  {
    value: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    hint: 'fastest, cheapest',
    skill_vector: [0.45, 0.45, 0.4, 0.35, 0.32, 0.45],
    cost_weight: 0.1,
    use_reasoning: false,
  },
  {
    value: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    hint: 'balanced',
    skill_vector: [0.68, 0.66, 0.72, 0.62, 0.62, 0.7],
    cost_weight: 0.4,
    use_reasoning: true,
  },
  {
    value: 'claude-opus-4-8',
    label: 'Opus 4.8',
    hint: 'most capable (prev gen)',
    skill_vector: [0.9, 0.9, 0.89, 0.95, 0.85, 0.93],
    cost_weight: 1.0,
    use_reasoning: true,
  },
  {
    value: 'claude-sonnet-5',
    label: 'Sonnet 5',
    hint: 'between Sonnet 4.6 and Opus',
    skill_vector: [0.82, 0.8, 0.83, 0.76, 0.8, 0.82],
    cost_weight: 0.6,
    use_reasoning: true,
  },
  {
    value: 'claude-fable-5',
    label: 'Fable 5',
    hint: 'flagship, beats Opus (costliest)',
    skill_vector: [0.97, 0.95, 0.94, 0.98, 0.93, 0.92],
    cost_weight: 1.3,
    use_reasoning: true,
  },
] as const;

type ClaudeModelID = (typeof CLAUDE_MODELS)[number]['value'];

const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
type Difficulty = (typeof DIFFICULTIES)[number];

const DIFFICULTY_OPTIONS = [
  { value: 'easy', label: 'Easy', hint: 'lightweight queries' },
  { value: 'medium', label: 'Medium', hint: 'balanced' },
  { value: 'hard', label: 'Hard', hint: 'complex/reasoning heavy' },
] as const;

const THINKING_MODE_OPTIONS = [
  { value: 'off', label: 'Off', hint: 'no reasoning at all' },
  { value: 'low', label: 'Low', hint: '' },
  { value: 'medium', label: 'Medium', hint: '' },
  { value: 'high', label: 'High', hint: '' },
  { value: 'xhigh', label: 'XHigh', hint: 'Opus/Fable only' },
  { value: 'max', label: 'Max', hint: 'Opus/Fable only' },
] as const;

function modelLabel(modelId: string): string {
  return CLAUDE_MODELS.find((m) => m.value === modelId)?.label ?? modelId;
}

export async function runModelsPoolWizard(cfg: BrickConfig): Promise<boolean> {
  ensureBlocks(cfg);

  // Snapshot dello stato rilevante all'ingresso: a fine wizard confrontiamo per
  // decidere se qualcosa e realmente cambiato (no-op detection).
  const before = snapshot(cfg);

  for (;;) {
    const pool = currentPool(cfg);
    const section = await p.select({
      message: 'Models configuration',
      options: [
        { value: 'pool', label: 'Pool models', hint: pool.length ? pool.map(modelLabel).join(', ') : 'none' },
        { value: 'difficulty', label: 'Difficulty mapping (fallback)', hint: difficultyHint(cfg) },
        { value: 'thinking', label: 'Thinking modes', hint: thinkingHint(cfg) },
        { value: 'done', label: 'Done' },
      ],
    });
    if (p.isCancel(section) || section === 'done') break;

    if (section === 'pool') await editPool(cfg);
    else if (section === 'difficulty') await editDifficulty(cfg);
    else if (section === 'thinking') await editThinking(cfg);
  }

  return snapshot(cfg) !== before;
}

// --- Sezioni ---------------------------------------------------------------

/**
 * Multiselect dei modelli attivi. Attivare un modello lo aggiunge ad
 * active_models e ne garantisce la voce in skill_router.models + model_config.
 * Disattivarlo lo toglie SOLO da active_models (la voce models resta, cosi la
 * riattivazione e a costo zero). Il pool vuoto e vietato.
 */
async function editPool(cfg: BrickConfig): Promise<void> {
  const current = currentPool(cfg);
  const selected = await p.multiselect({
    message: 'Active models (candidates for skill-vector routing)',
    options: CLAUDE_MODELS.map((m) => ({ value: m.value, label: m.label, hint: m.hint })),
    initialValues: current.filter((m) => CLAUDE_MODELS.some((c) => c.value === m)),
    required: false,
  });
  if (p.isCancel(selected)) return;

  if (selected.length === 0) {
    p.note('At least one active model is required. Keeping the current pool.', 'pool');
    return;
  }

  // Garantisci una voce skill_router.models + model_config per ogni attivo.
  for (const modelId of selected) {
    ensureSkillModel(cfg, modelId as ClaudeModelID);
    ensureModelConfig(cfg, modelId);
  }

  // active_models = selezione, in ordine catalogo, deduplicata.
  const ordered = CLAUDE_MODELS.map((m) => m.value).filter((m) => selected.includes(m));
  (cfg.skill_router as any).active_models = ordered;
}

/**
 * Fallback difficolta -> modello (model_map). Usato solo quando lo skill router
 * e off/non disponibile. Pre-compilato; segnala se punta a un modello non
 * attivo.
 */
async function editDifficulty(cfg: BrickConfig): Promise<void> {
  const pool = currentPool(cfg);
  if (pool.length === 0) {
    p.note('Pool is empty. Add models under "Pool models" first.', 'difficulty');
    return;
  }
  p.note('This maps difficulty to a model only as a fallback when skill routing is off or unavailable.', 'difficulty (fallback)');
  for (const modelId of pool) {
    const cur = currentDifficultyOf(cfg, modelId);
    const d = await p.select({
      message: `Fallback difficulty for ${modelLabel(modelId)}`,
      options: DIFFICULTY_OPTIONS.map((o) => ({ ...o })),
      initialValue: cur,
    });
    if (p.isCancel(d)) return; // esce dalla sezione, mantiene le modifiche gia fatte
    if (d !== cur) {
      const displaced = (cfg.anthropic_passthrough!.model_map as Record<string, string>)[d as string];
      if (displaced && displaced !== modelId) {
        p.note(`"${d}" was mapped to ${modelLabel(displaced)}; it is replaced.`, 'difficulty');
      }
      assignDifficulty(cfg, modelId, d as Difficulty);
    }
  }
}

/** Scegli un modello attivo e modifica i suoi thinking modes (pre-compilati). */
async function editThinking(cfg: BrickConfig): Promise<void> {
  const pool = currentPool(cfg);
  if (pool.length === 0) {
    p.note('Pool is empty. Add models under "Pool models" first.', 'thinking');
    return;
  }
  const modelId = await p.select({
    message: 'Configure thinking modes for which model?',
    options: pool.map((m) => ({ value: m, label: modelLabel(m) })),
  });
  if (p.isCancel(modelId)) return;

  const current = cfg.model_config?.[modelId]?.allowed_thinking_modes ?? [];
  const modes = await p.multiselect({
    message: `Thinking modes for ${modelLabel(modelId)}`,
    options: THINKING_MODE_OPTIONS.map((m) => ({ value: m.value, label: m.label, hint: m.hint })),
    initialValues: THINKING_MODE_OPTIONS.filter((m) => current.includes(m.value)).map((m) => m.value),
    required: false,
  });
  if (p.isCancel(modes)) return;

  if (!cfg.model_config) cfg.model_config = {};
  if (!cfg.model_config[modelId]) cfg.model_config[modelId] = { preferred_endpoints: [] };

  if (modes.includes('off') && modes.length > 1) {
    p.note('"Off" disables reasoning entirely; other modes are incompatible. Setting to ["off"].', 'modes');
    cfg.model_config[modelId].allowed_thinking_modes = ['off'];
  } else if (modes.length === 0) {
    delete cfg.model_config[modelId].allowed_thinking_modes;
  } else {
    cfg.model_config[modelId].allowed_thinking_modes = modes as any[];
  }
}

// --- Helpers ---------------------------------------------------------------

/** Assicura che skill_router, model_map, model_config e blocchi correlati esistano. */
function ensureBlocks(cfg: BrickConfig): void {
  const ap = (cfg.anthropic_passthrough ??= { enabled: true, model_map: {} } as any);
  if (!ap.model_map) ap.model_map = {} as any;
  if (!ap.model_map_1m) ap.model_map_1m = {} as any;
  if (!cfg.model_config) cfg.model_config = {};
  const sr = (cfg.skill_router ??= {} as any);
  if (!Array.isArray(sr.models)) sr.models = [];
}

/** Endpoints da seedare per una nuova voce model_config: riusa un sibling Claude, fallback ['regolo']. */
function seedEndpoints(cfg: BrickConfig): string[] {
  for (const m of Object.values(cfg.model_config ?? {})) {
    const eps = (m as any)?.preferred_endpoints;
    if (Array.isArray(eps) && eps.length) return [...eps];
  }
  return ['regolo'];
}

/** Garantisce una voce skill_router.models per il modello (seed dal catalogo se assente). */
function ensureSkillModel(cfg: BrickConfig, modelId: ClaudeModelID): void {
  const sr = cfg.skill_router as any;
  if (!Array.isArray(sr.models)) sr.models = [];
  if (sr.models.some((m: any) => m?.model === modelId)) return;
  const catalog = CLAUDE_MODELS.find((m) => m.value === modelId)!;
  sr.models.push({
    model: modelId,
    skill_vector: [...catalog.skill_vector],
    cost_weight: catalog.cost_weight,
    use_reasoning: catalog.use_reasoning,
  });
}

/** Garantisce model_config[modelId] con preferred_endpoints validi (non vuoti). */
function ensureModelConfig(cfg: BrickConfig, modelId: string): void {
  if (!cfg.model_config) cfg.model_config = {};
  const mc = (cfg.model_config[modelId] ??= { preferred_endpoints: [] } as any);
  if (!Array.isArray(mc.preferred_endpoints) || mc.preferred_endpoints.length === 0) {
    mc.preferred_endpoints = seedEndpoints(cfg);
  }
}

/** Assegna una difficolta fallback a un modello, liberando eventuale slot precedente. */
function assignDifficulty(cfg: BrickConfig, modelId: string, d: Difficulty): void {
  const mm = cfg.anthropic_passthrough!.model_map as Record<string, string>;
  const mm1 = cfg.anthropic_passthrough!.model_map_1m as Record<string, string>;
  for (const k of DIFFICULTIES) {
    if (mm[k] === modelId && k !== d) {
      delete mm[k];
      delete mm1[k];
    }
  }
  mm[d] = modelId;
  // haiku non ha finestra 1M: sostituisci con sonnet-4-6 nella mappa 1M.
  mm1[d] = modelId.includes('haiku') ? 'claude-sonnet-4-6' : modelId;
}

/**
 * Modelli attualmente attivi = skill_router.active_models. Fallback (per profili
 * pre-esistenti senza active_models): i modelli gia in skill_router.models.
 */
function currentPool(cfg: BrickConfig): ClaudeModelID[] {
  const sr = cfg.skill_router as any;
  const active: string[] = Array.isArray(sr?.active_models) ? sr.active_models : [];
  const src = active.length ? active : (Array.isArray(sr?.models) ? sr.models.map((m: any) => m?.model) : []);
  const seen = new Set<string>();
  const out: ClaudeModelID[] = [];
  for (const m of src) {
    if (typeof m === 'string' && !seen.has(m)) {
      seen.add(m);
      out.push(m as ClaudeModelID);
    }
  }
  return out;
}

/** Difficolta fallback attualmente assegnata a un modello (default 'medium'). */
function currentDifficultyOf(cfg: BrickConfig, modelId: string): Difficulty {
  const mm = (cfg.anthropic_passthrough?.model_map ?? {}) as Record<string, string>;
  for (const d of DIFFICULTIES) if (mm[d] === modelId) return d;
  return 'medium';
}

function difficultyHint(cfg: BrickConfig): string {
  const mm = (cfg.anthropic_passthrough?.model_map ?? {}) as Record<string, string>;
  const parts = DIFFICULTIES.filter((d) => mm[d]).map((d) => `${d}->${modelLabel(mm[d])}`);
  return parts.length ? parts.join(', ') : 'unset';
}

function thinkingHint(cfg: BrickConfig): string {
  const pool = currentPool(cfg);
  const parts = pool
    .map((m) => {
      const modes = cfg.model_config?.[m]?.allowed_thinking_modes ?? [];
      return modes.length ? `${modelLabel(m)}: ${modes.join(',')}` : null;
    })
    .filter(Boolean);
  return parts.length ? (parts.join(' · ') as string) : 'all modes allowed';
}

/**
 * Stringa canonica dello stato rilevante per il confronto no-op: active_models,
 * le voci skill_router.models (vettore + cost + reasoning), model_map,
 * model_map_1m e i thinking modes. Ordina chiavi e array cosi che riconfermare
 * gli stessi valori non risulti "cambiato".
 */
function snapshot(cfg: BrickConfig): string {
  const sr = cfg.skill_router as any;
  const active = Array.isArray(sr?.active_models) ? [...sr.active_models].sort() : null;
  const models: Record<string, unknown> = {};
  for (const m of Array.isArray(sr?.models) ? sr.models : []) {
    if (typeof m?.model !== 'string') continue;
    models[m.model] = {
      v: Array.isArray(m.skill_vector) ? m.skill_vector : null,
      c: m.cost_weight ?? null,
      r: m.use_reasoning ?? null,
    };
  }
  const mm = (cfg.anthropic_passthrough?.model_map ?? null) as Record<string, string> | null;
  const mm1 = (cfg.anthropic_passthrough?.model_map_1m ?? null) as Record<string, string> | null;
  const mc: Record<string, string[] | null> = {};
  for (const [model, conf] of Object.entries(cfg.model_config ?? {})) {
    const modes = (conf as any)?.allowed_thinking_modes as string[] | undefined;
    mc[model] = modes ? [...modes].sort() : null;
  }
  const sortObj = (o: Record<string, unknown> | null) =>
    o ? Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))) : null;
  return JSON.stringify({
    active,
    models: sortObj(models),
    mm: sortObj(mm),
    mm1: sortObj(mm1),
    mc: sortObj(mc),
  });
}
