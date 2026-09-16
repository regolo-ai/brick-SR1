// Routing preference presets shared by profile creation and harness state.
export type ClaudeMode = 'eco' | 'lite' | 'mid' | 'pro' | 'max';

export const MODES: readonly ClaudeMode[] = ['eco', 'lite', 'mid', 'pro', 'max'] as const;

/** Continuous routing preference each mode represents. */
export const R_BY_MODE: Record<ClaudeMode, number> = {
  eco: -1,
  lite: -0.5,
  mid: 0,
  pro: 0.5,
  max: 1,
};
