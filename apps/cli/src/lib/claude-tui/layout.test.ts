import { describe, expect, it } from 'vitest';
import { layoutHeight, planLayout, type LayoutInput } from './layout.js';

const base: LayoutInput = { rows: 60, models: 3, modes: 4, nativeModels: 1, economyAvailable: true };

describe('planLayout', () => {
  it('uses the full layout when the terminal is tall enough', () => {
    const layout = planLayout(base);
    expect(layout.mode).toBe('full');
    expect(layout.pool).toBe(true);
    expect(layout.shimmer).toBe(true);
    expect(layoutHeight(layout, base)).toBeLessThanOrEqual(base.rows);
  });

  it('drops the shimmer before any section on medium terminals', () => {
    const input = { ...base, rows: 40 };
    const layout = planLayout(input);
    expect(layout.mode).toBe('compact');
    expect(layout.shimmer).toBe(false);
    expect(layoutHeight(layout, input)).toBeLessThanOrEqual(input.rows);
  });

  it('drops the least important sections first', () => {
    const input = { ...base, rows: 24 };
    const layout = planLayout(input);
    expect(layout.pool).toBe(false);
    expect(layout.systemOne).toBe(false);
    expect(layout.connection).toBe(false);
    expect(layout.economy).toBe(false);
    expect(layoutHeight(layout, input)).toBeLessThanOrEqual(input.rows);
  });

  it('keeps the economy box longer than the connection box', () => {
    const input = { ...base, rows: 28 };
    const layout = planLayout(input);
    expect(layout.economy).toBe(true);
    expect(layout.connection).toBe(false);
    expect(layoutHeight(layout, input)).toBeLessThanOrEqual(input.rows);
  });

  it('falls back to a borderless summary when even the routing box does not fit', () => {
    const input = { ...base, rows: 12 };
    const layout = planLayout(input);
    expect(layout.mode).toBe('micro');
    expect(layoutHeight(layout, input)).toBeLessThanOrEqual(input.rows);
  });

  it('never plans a frame taller than the terminal', () => {
    for (let rows = 10; rows <= 80; rows++) {
      for (const models of [1, 3, 6]) {
        const input = { ...base, rows, models };
        const layout = planLayout(input);
        expect(layoutHeight(layout, input), `rows=${rows} models=${models}`).toBeLessThanOrEqual(rows);
      }
    }
  });
});
