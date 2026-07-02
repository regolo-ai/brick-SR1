import * as p from '@clack/prompts';
import { type BrickConfig } from '../../config/schema.js';

const THINKING_MODES = [
  { value: 'off',    label: 'off',    hint: 'disabilita il reasoning completamente per questo modello' },
  { value: 'low',    label: 'low',    hint: 'eco mode  (livello 0-1)' },
  { value: 'medium', label: 'medium', hint: 'lite mode (livello 2)' },
  { value: 'high',   label: 'high',   hint: 'mid mode  (livello 3)' },
  { value: 'xhigh',  label: 'xhigh',  hint: 'pro mode  (livello 4, solo Opus)' },
  { value: 'max',    label: 'max',    hint: 'max mode  (livello 5, solo Opus)' },
] as const;

function isCancel(v: unknown): boolean { return p.isCancel(v); }
function abort(): never { p.cancel('aborted'); process.exit(0); }

/**
 * Wizard step per configurare gli `allowed_thinking_modes` per ogni modello
 * presente in `cfg.model_config`. Modifica `cfg` in-place.
 *
 * @returns true se è stata apportata almeno una modifica (dirty flag per il chiamante).
 */
export async function runModelThinkingModeWizard(cfg: BrickConfig): Promise<boolean> {
  const modelIds = Object.keys(cfg.model_config ?? {});

  if (modelIds.length === 0) {
    p.note(
      'Nessun modello configurato in model_config.\nAggiungi prima un modello tramite la sezione "Models".',
      'thinking modes',
    );
    return false;
  }

  // ── Step B: selezione dei modelli da configurare ───────────────────────
  const modelSel = await p.multiselect({
    message: 'Seleziona i modelli da configurare (SPACE per toggle, ENTER per confermare):',
    options: modelIds.map((id) => {
      const current = (cfg.model_config as any)[id]?.allowed_thinking_modes as string[] | undefined;
      const hint = current?.length ? current.join(', ') : 'unrestricted';
      return { value: id, label: id, hint };
    }),
    required: false,
  });
  if (isCancel(modelSel)) abort();

  const selectedModels = modelSel as string[];
  if (selectedModels.length === 0) return false;

  let changed = false;

  // ── Step C: per ogni modello selezionato, chiedi i thinking modes ───────
  for (const modelId of selectedModels) {
    const current =
      ((cfg.model_config as any)[modelId]?.allowed_thinking_modes as string[] | undefined) ?? [];

    const modes = await p.multiselect({
      message: `Thinking modes permessi per ${modelId}:`,
      options: THINKING_MODES.map((m) => ({ ...m })),
      initialValues: current,
      required: false,
    });
    if (isCancel(modes)) abort();

    const modeList = modes as string[];

    if (modeList.length === 0) {
      // Selezione vuota = rimuovi il vincolo (unrestricted)
      if ('allowed_thinking_modes' in (cfg.model_config as any)[modelId]) {
        delete (cfg.model_config as any)[modelId].allowed_thinking_modes;
        changed = true;
      }
    } else if (modeList.includes('off') && modeList.length > 1) {
      // 'off' è esclusivo: sovrascrive tutti gli altri
      p.note(`'off' è esclusivo — altri modes rimossi per ${modelId}`, 'thinking modes');
      (cfg.model_config as any)[modelId].allowed_thinking_modes = ['off'];
      changed = true;
    } else {
      (cfg.model_config as any)[modelId].allowed_thinking_modes = modeList;
      changed = true;
    }
  }

  return changed;
}
