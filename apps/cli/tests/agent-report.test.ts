import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigSchema, type BrickConfig } from '../src/lib/config/schema.js';

const mocks = vi.hoisted(() => ({
  runtimeStatus: vi.fn(),
  harnessConnection: vi.fn(),
  readContextDiscoverySnapshot: vi.fn(),
}));

vi.mock('../src/lib/runtime/process.js', () => ({ runtimeStatus: mocks.runtimeStatus }));
vi.mock('../src/lib/harness.js', () => ({ harnessConnection: mocks.harnessConnection }));
vi.mock('../src/lib/catalog/context-windows.js', () => ({
  readContextDiscoverySnapshot: mocks.readContextDiscoverySnapshot,
}));

import { buildAgentReport, AGENT_REPORT_SCHEMA_VERSION } from '../src/lib/status/agent-report.js';

const HEALTH = {
  status: 'ok',
  instance_id: 'inst-1',
  profile: 'default',
  version: '3.0.2',
  pid: 4321,
  config: '/home/u/.brick/profiles/default/runtime/config-abc.yaml',
  routing_ready: true,
  routing_checked: true,
};

const DIAG = {
  enabled: true,
  reachable: true,
  device: 'cpu',
  model: 'regolo/brick-capability',
  latency_ms: 12,
};

const STATS = {
  schema_version: '2.0',
  overall: { calls: 3, completed_calls: 3, failed_calls: 0 },
  models: [
    {
      model: 'claude-sonnet',
      routed_calls: 2,
      native_calls: 1,
      reasoning_modes: [{ mode: 'high', calls: 2 }],
      routing_modes: [],
      calls: 3,
      completed_calls: 3,
      failed_calls: 0,
    },
  ],
  difficulty: [],
  classifier: { calls: 3, fallbacks: 0, fallback_rate: 0 },
  latencies: {
    routing: { average_ms: 40, p50_ms: 38, p95_ms: 61 },
    provider: { average_ms: 900, p50_ms: 880, p95_ms: 1200 },
    overall: { average_ms: 940, p50_ms: 918, p95_ms: 1261 },
  },
};

const ECON = {
  models: [
    {
      model: 'claude-sonnet',
      requests: 2,
      input_tokens: 1000,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 9000,
      output_tokens: 300,
      cost_ratio_in: 1,
      cost_ratio_out: 1,
      estimated_cost_units: 1.5,
    },
  ],
  most_expensive_model: 'claude-sonnet',
  actual_cost_units: 1.5,
  baseline_cost_units_all_expensive: 3,
  savings_pct: 50,
  savings_pct_vs_opus: 60,
  baseline_model: 'claude-sonnet',
  pricing_available: true,
};

function cfg(overrides: Record<string, unknown> = {}): BrickConfig {
  return ConfigSchema.parse({
    default_model: 'claude-sonnet',
    skill_router: {
      capabilities: ['coding'],
      capability_model: {},
      complexity_model: {},
      math: {},
      models: [
        { model: 'claude-sonnet', skill_vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] },
        { model: 'gpt-5.6-sol', skill_vector: [0.6, 0.5, 0.4, 0.3, 0.2, 0.1] },
      ],
      active_models: ['claude-sonnet', 'gpt-5.6-sol'],
    },
    ...overrides,
  });
}

function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    const key = String(url).replace('http://127.0.0.1:8000', '').split('?')[0];
    const body = routes[key];
    if (body === undefined) throw new Error(`unexpected fetch: ${url}`);
    return { ok: true, status: 200, json: async () => body };
  }));
}

function stubDown() {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
}

function wireHappyPath() {
  stubFetch({
    '/health': HEALTH,
    '/api/v1/diag/classifier': DIAG,
    '/api/v1/stats': STATS,
    '/api/v1/economics': ECON,
  });
  mocks.runtimeStatus.mockResolvedValue({
    pid: 4321,
    profile: 'default',
    port: 8000,
    instance: 'inst-1',
    version: '3.0.2',
    config: HEALTH.config,
    digest: 'abc123',
    healthy: true,
    routingReady: true,
  });
  mocks.harnessConnection.mockReturnValue({
    url: 'http://127.0.0.1:8000',
    attached: true,
    label: 'Claude settings',
    disconnectedLabel: 'not wired',
    unattachedLabel: 'not wired to this router',
  });
  mocks.readContextDiscoverySnapshot.mockResolvedValue([
    { model: 'claude-sonnet', maxInputTokens: 200000, state: 'cache', source: 'openrouter', verifiedAt: new Date().toISOString() },
  ]);
}

describe('buildAgentReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits a stable top-level schema with every field the dashboard renders', async () => {
    wireHappyPath();

    const report = await buildAgentReport('default', cfg());

    expect(Object.keys(report).sort()).toEqual([
      'classifier', 'context_discovery', 'economy', 'harness', 'port',
      'profile', 'router', 'runtime', 'schema_version', 'selection', 'stats',
    ]);
    expect(report.schema_version).toBe(AGENT_REPORT_SCHEMA_VERSION);
    expect(report.profile).toBe('default');
    expect(report.port).toBe(8000);
  });

  it('reports the selected model pool and skill vectors', async () => {
    wireHappyPath();

    const report = await buildAgentReport('default', cfg());

    expect(report.selection.default_model).toBe('claude-sonnet');
    expect(report.selection.active_models).toEqual(['claude-sonnet', 'gpt-5.6-sol']);
    expect(report.selection.skill_vectors).toEqual({
      'claude-sonnet': [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
      'gpt-5.6-sol': [0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
    });
  });

  it('normalizes runtime state to the router snake_case vocabulary', async () => {
    wireHappyPath();

    const report = await buildAgentReport('default', cfg());

    expect(report.runtime).toEqual({
      pid: 4321,
      profile: 'default',
      port: 8000,
      instance_id: 'inst-1',
      version: '3.0.2',
      config: HEALTH.config,
      digest: 'abc123',
      healthy: true,
      routing_ready: true,
    });
    expect(report.router).toEqual(HEALTH);
  });

  it('passes through classifier, stats, harness and context discovery verbatim', async () => {
    wireHappyPath();

    const report = await buildAgentReport('default', cfg());

    expect(report.classifier).toEqual(DIAG);
    expect(report.stats).toEqual(STATS);
    expect(report.harness).toEqual({
      url: 'http://127.0.0.1:8000',
      attached: true,
      label: 'Claude settings',
      disconnectedLabel: 'not wired',
      unattachedLabel: 'not wired to this router',
    });
    expect(report.context_discovery).toHaveLength(1);
    expect(report.context_discovery[0].model).toBe('claude-sonnet');
  });

  it('surfaces real token-based savings when the router reports priced traffic', async () => {
    wireHappyPath();

    const report = await buildAgentReport('default', cfg());

    expect(report.economy.source).toBe('real');
    expect(report.economy.savedPct).toBe(50);
    expect(report.economy.savedPctVsOpus).toBe(60);
    expect(report.economy.totalCacheReadTokens).toBe(9000);
  });

  it('degrades to nulls instead of throwing when the router is unreachable', async () => {
    stubDown();
    mocks.runtimeStatus.mockResolvedValue(null);
    mocks.harnessConnection.mockReturnValue({
      url: 'http://127.0.0.1:8000',
      attached: false,
      label: 'Claude settings',
    });
    mocks.readContextDiscoverySnapshot.mockRejectedValue(new Error('no snapshot'));

    const report = await buildAgentReport('default', cfg());

    expect(report.router).toBeNull();
    expect(report.runtime).toBeNull();
    expect(report.classifier).toBeNull();
    expect(report.stats).toBeNull();
    expect(report.context_discovery).toEqual([]);
    expect(report.economy.source).toBe('unavailable');
    expect(report.selection.active_models).toEqual(['claude-sonnet', 'gpt-5.6-sol']);
  });

  it('keeps skill vectors when the active pool is empty', async () => {
    wireHappyPath();

    const report = await buildAgentReport('default', cfg({
      skill_router: {
        capabilities: ['coding'],
        capability_model: {},
        complexity_model: {},
        math: {},
        models: [{ model: 'claude-sonnet', skill_vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] }],
      },
    }));

    expect(report.selection.active_models).toEqual([]);
    expect(report.selection.skill_vectors).toEqual({ 'claude-sonnet': [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] });
  });

  it('reports savings as unavailable when the router has no pricing table', async () => {
    wireHappyPath();
    stubFetch({
      '/health': HEALTH,
      '/api/v1/diag/classifier': DIAG,
      '/api/v1/stats': STATS,
      '/api/v1/economics': { ...ECON, pricing_available: false, note: 'pricing table not available' },
    });

    const report = await buildAgentReport('default', cfg());

    expect(report.economy.source).toBe('unavailable');
    expect(report.economy.note).toBe('pricing table not available');
    expect(report.economy.baselineModel).toBe('claude-sonnet');
  });
});
