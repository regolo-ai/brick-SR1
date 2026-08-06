import { describe, expect, it } from 'vitest';
import { applyCodexRoutingModeToConfig } from './settings-apply.js';

describe('applyCodexRoutingModeToConfig', () => {
  it('writes an explicit off when the absent-key default is smartsqueeze', () => {
    const obj: any = { brick: { enabled: true } };

    expect(applyCodexRoutingModeToConfig(obj, 'off')).toBe(true);
    expect(obj.brick.routing_mode).toBe('off');
  });

  it('treats an absent key as the smartsqueeze default', () => {
    const obj: any = { brick: { enabled: true } };

    expect(applyCodexRoutingModeToConfig(obj, 'smartsqueeze')).toBe(false);
    expect(obj.brick.routing_mode).toBeUndefined();
  });

  it('updates an explicit mode and reports unchanged values', () => {
    const obj: any = { brick: { enabled: true, routing_mode: 'sticky' } };

    expect(applyCodexRoutingModeToConfig(obj, 'orchestrator')).toBe(true);
    expect(obj.brick.routing_mode).toBe('orchestrator');
    expect(applyCodexRoutingModeToConfig(obj, 'orchestrator')).toBe(false);
  });
});
