import { describe, expect, it } from 'vitest';
import { assignModelColors, colorForMode, colorForModel, MODEL_PALETTE, shade, shortModel } from './model-colors.js';

function rgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Nearest xterm-256 entry, mirroring color-convert (what Ink/chalk use). */
function ansi256(hex: string): number {
  const [r, g, b] = rgb(hex);
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}

describe('MODEL_PALETTE', () => {
  it('stays distinct after 256-colour quantisation', () => {
    const entries = MODEL_PALETTE.map(ansi256);
    expect(new Set(entries).size).toBe(MODEL_PALETTE.length);
  });
});

describe('assignModelColors', () => {
  it('never repeats a colour inside a pool', () => {
    const models = ['glm5.2', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.6-sol', 'qwen3.5-122b', 'gpt-oss-120b'];
    const colors = assignModelColors(models);
    expect(new Set(colors.values()).size).toBe(models.length);
    for (const hex of colors.values()) expect(ansi256(hex)).toBeGreaterThanOrEqual(16);
  });

  it('is deterministic regardless of input order', () => {
    const a = assignModelColors(['gpt-6.1-terra', 'glm5.2', 'gpt-6-luna']);
    const b = assignModelColors(['glm5.2', 'gpt-6-luna', 'gpt-6.1-terra']);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('keeps existing colours when a new model joins', () => {
    const before = assignModelColors(['glm5.2', 'gpt-6.1-terra']);
    const after = assignModelColors(['glm5.2', 'gpt-6.1-terra', 'zzz-new-model']);
    expect(after.get('glm5.2')).toBe(before.get('glm5.2'));
    expect(after.get('gpt-6.1-terra')).toBe(before.get('gpt-6.1-terra'));
  });

  it('falls back to the accent for a single unknown model', () => {
    expect(colorForModel('mystery-model')).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('colorForMode', () => {
  const base = assignModelColors(['gpt-6.1-terra']).get('gpt-6.1-terra')!;

  it('renders thinking modes as shades of the model colour, not alert colours', () => {
    const shades = ['default', 'low', 'medium', 'high', 'xhigh', 'max'].map((mode) => colorForMode(base, mode));
    const lums = shades.map(luminance);
    expect([...lums].sort((a, b) => a - b)).toEqual(lums);
    expect(new Set(shades).size).toBe(shades.length);
  });

  it('keeps the base hue (no green row under a pink model)', () => {
    const order = (hex: string) => rgb(hex).map((value, index) => [value, index] as const)
      .sort((a, b) => b[0] - a[0]).map(([, index]) => index).join();
    for (const mode of ['default', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(order(colorForMode(base, mode))).toBe(order(base));
    }
  });
});

describe('shade', () => {
  it('moves towards white and black', () => {
    expect(luminance(shade('#336699', 0.5))).toBeGreaterThan(luminance('#336699'));
    expect(luminance(shade('#336699', -0.5))).toBeLessThan(luminance('#336699'));
    expect(shade('#000000', 1)).toBe('#ffffff');
  });
});

describe('shortModel', () => {
  it('strips a trailing date stamp only', () => {
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(shortModel('gpt-6.1-terra')).toBe('gpt-6.1-terra');
  });
});
