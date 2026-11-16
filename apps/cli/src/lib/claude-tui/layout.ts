/**
 * The dashboard is redrawn on every tick, and Ink always writes at the bottom
 * of the terminal. When the frame is taller than the viewport that forces the
 * terminal to scroll on each refresh, which yanks the user back down whenever
 * they scroll up. These helpers size the report so it always fits: sections are
 * dropped in priority order instead of overflowing.
 */
export type DashboardMode = 'full' | 'compact' | 'micro';

export interface LayoutInput {
  /** Terminal rows available. */
  rows: number;
  /** Models with routed traffic (one row each in the routing box). */
  models: number;
  /** Total reasoning-mode rows shown under the models (full layout only). */
  modes: number;
  /** Native (router bypass) models, rendered as an extra grey block. */
  nativeModels: number;
  /** False renders the compact "pricing unavailable" economy variant. */
  economyAvailable: boolean;
}

export interface DashboardLayout {
  mode: DashboardMode;
  shimmer: boolean;
  legend: boolean;
  /** Top spacer before the footer. */
  pool: boolean;
  economy: boolean;
  connection: boolean;
  systemOne: boolean;
}

const FOOTER = 2; // spacer + hint line

function routingHeight(input: LayoutInput, full: boolean): number {
  const { models, modes, nativeModels } = input;
  let height = 2 /* borders */ + 1 /* title */ + 1 /* total requests */;
  if (full) {
    height += 1 + 1 + 1; // blank, shimmer, blank
    height += 1 + 1 + 1 + 1; // label, bar, spacer, legend
    height += models * 2 + modes; // per model: spacer + row + its mode rows
    if (nativeModels > 0) height += 2 + nativeModels; // spacer, label, rows
  } else {
    height += 1 + 1; // bar, legend
    height += models; // model rows, modes inline
    if (nativeModels > 0) height += 2 + nativeModels;
  }
  return height + 1 + 1 + 1; // spacer, latency, fallback
}

function economyHeight(available: boolean, full: boolean): number {
  const content = available ? 7 : 6; // borders + title + body
  return content + (full ? 1 : 0);
}

function connectionHeight(mode: DashboardMode): number {
  return 5 + (mode === 'full' ? 1 : 0);
}

function systemOneHeight(mode: DashboardMode): number {
  return 4 + (mode === 'full' ? 1 : 0);
}

function poolHeight(mode: DashboardMode): number {
  return mode === 'full' ? 5 : 1;
}

/** Minimum rows for the borderless summary used on very short terminals. */
function microHeight(input: LayoutInput): number {
  return 1 /* totals */ + 1 /* stacked bar */ + input.models + FOOTER;
}

export function planLayout(input: LayoutInput): DashboardLayout {
  const rows = Math.max(1, input.rows);
  const margin = 1; // first box top margin

  const fullTotal = margin + routingHeight(input, true) + poolHeight('full')
    + economyHeight(input.economyAvailable, true)
    + connectionHeight('full') + systemOneHeight('full') + FOOTER;

  if (fullTotal <= rows) {
    return { mode: 'full', shimmer: true, legend: true, pool: true, economy: true, connection: true, systemOne: true };
  }

  // Compact: same data, denser rendering. Then drop sections by ascending
  // importance until the frame fits the viewport.
  let keep = { pool: true, economy: true, connection: true, systemOne: true };
  const compactTotal = () => margin + routingHeight(input, false) + (keep.pool ? poolHeight('compact') : 0)
    + (keep.economy ? economyHeight(input.economyAvailable, false) : 0)
    + (keep.connection ? connectionHeight('compact') : 0)
    + (keep.systemOne ? systemOneHeight('compact') : 0) + FOOTER;

  const dropOrder: Array<keyof typeof keep> = ['pool', 'systemOne', 'connection', 'economy'];
  for (const section of dropOrder) {
    if (compactTotal() <= rows) break;
    keep = { ...keep, [section]: false };
  }

  const routingAlone = margin + routingHeight(input, false) + FOOTER;
  if (compactTotal() > rows || routingAlone > rows) {
    // Even the routing box does not fit: fall back to a borderless summary.
    return { mode: 'micro', shimmer: false, legend: false, pool: false, economy: false, connection: false, systemOne: false };
  }

  return { mode: 'compact', shimmer: false, legend: true, ...keep };
}

/** True when the chosen layout provably fits (exposed for tests). */
export function layoutHeight(layout: DashboardLayout, input: LayoutInput): number {
  if (layout.mode === 'micro') return microHeight(input);
  let height = 1 + routingHeight(input, layout.mode === 'full');
  if (layout.pool) height += poolHeight(layout.mode);
  if (layout.economy) height += economyHeight(input.economyAvailable, layout.mode === 'full');
  if (layout.connection) height += connectionHeight(layout.mode);
  if (layout.systemOne) height += systemOneHeight(layout.mode);
  return height + FOOTER;
}
