/**
 * Per-model colours for the dashboard.
 *
 * Two rules learned the hard way:
 *  - a prefix match made every gpt-6 model the same pink, and two different
 *    hex colours can still collapse onto the same 256-colour palette entry in
 *    a normal terminal, so models are assigned from a palette whose entries are
 *    guaranteed to survive quantisation as distinct colours;
 *  - reasoning modes must read as shades of the model colour, not as unrelated
 *    alert colours (a pink model with a bright green "thinking" row).
 */

/** Brand accent shared by the dashboard and the CLI banners. */
export const ACCENT = '#00d4aa';

/**
 * Eighteen hues spread by the golden angle, each one landing on a different
 * xterm-256 entry (verified in model-colors.test.ts), so a normal terminal
 * never renders two models in the same colour.
 */
export const MODEL_PALETTE = [
  '#d8806e', '#6ed89f', '#be6ed8', '#d4d86e', '#6eb5d8', '#d86e96',
  '#77d86e', '#846ed8', '#ce8a46', '#46ceb2', '#ce46c2', '#b0d86e',
  '#6e91d8', '#d86e72', '#46ce68', '#9046ce', '#ceb746', '#46bcce',
];

/** FNV-1a, so a model keeps the same preferred slot between runs. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const channel = (value: number) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Move a colour towards white (amount > 0) or black (amount < 0). */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const target = amount >= 0 ? 255 : 0;
  const ratio = Math.min(1, Math.abs(amount));
  return rgbToHex(r + (target - r) * ratio, g + (target - g) * ratio, b + (target - b) * ratio);
}

/**
 * Assign one distinct palette colour per model. Models are visited in name
 * order and each one starts from its hash-preferred slot, probing forward on
 * collision, so the mapping is deterministic for a given set of models and
 * never repeats a colour while the pool fits the palette.
 */
export function assignModelColors(models: Iterable<string>): Map<string, string> {
  const unique = [...new Set(models)].sort();
  const used = new Set<number>();
  const colors = new Map<string, string>();
  for (const model of unique) {
    let slot = hashString(model.toLowerCase()) % MODEL_PALETTE.length;
    for (let step = 0; step < MODEL_PALETTE.length && used.has(slot); step++) {
      slot = (slot + 1) % MODEL_PALETTE.length;
    }
    used.add(slot);
    colors.set(model, MODEL_PALETTE[slot]);
  }
  return colors;
}

/** Single-model colour when no shared assignment is available. */
export function colorForModel(model: string): string {
  return MODEL_PALETTE[hashString(model.toLowerCase()) % MODEL_PALETTE.length];
}

/**
 * Shade of the model colour for one reasoning mode: brighter means more
 * effort, dimmer means less.
 */
export function colorForMode(baseColor: string, mode: string): string {
  const steps: Record<string, number> = {
    default: -0.28,
    minimal: -0.38,
    low: -0.18,
    medium: -0.04,
    high: 0.14,
    xhigh: 0.3,
    max: 0.44,
  };
  return shade(baseColor, steps[mode] ?? 0);
}

/** Trims a trailing date stamp (claude-haiku-4-5-20251001 → claude-haiku-4-5). */
export function shortModel(model: string): string {
  return model.replace(/-\d{8}$/, '');
}
