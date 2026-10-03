import {
  fetchEconomics,
  fetchHealth,
  fetchSnapshot,
  unifyEconomy,
  type HealthResponse,
  type Snapshot,
  type UnifiedEconomy,
} from '../claude/metrics.js';
import { readContextDiscoverySnapshot, type ContextWindowResolution } from '../catalog/context-windows.js';
import { localBaseUrl } from '../net/local.js';
import { runtimeStatus } from '../runtime/process.js';
import { harnessConnection } from '../harness.js';
import type { BrickConfig } from '../config/schema.js';

export const AGENT_REPORT_SCHEMA_VERSION = '1.0';

export type AgentSelection = {
  default_model: string;
  active_models: string[];
  skill_vectors: Record<string, number[]>;
};

export type AgentRuntime = {
  pid: number;
  profile: string;
  port: number;
  instance_id: string;
  version: string;
  config: string;
  digest: string;
  healthy: boolean;
  routing_ready: boolean;
} | null;

export type AgentHarness = {
  label: string;
  url?: string;
  attached: boolean;
};

export type AgentReport = {
  schema_version: string;
  profile: string;
  port: number;
  selection: AgentSelection;
  runtime: AgentRuntime;
  router: HealthResponse | null;
  harness: AgentHarness;
  classifier: Snapshot['diag'];
  stats: Snapshot['stats'];
  economy: UnifiedEconomy;
  context_discovery: ContextWindowResolution[];
};

const EMPTY_STATS = { overall: { calls: 0, completed_calls: 0, failed_calls: 0 }, models: [] };

export async function buildAgentReport(profile: string, cfg: BrickConfig): Promise<AgentReport> {
  const port = cfg.server_port;
  const baseUrl = localBaseUrl(port);

  const [runtime, snapshot, health, econ] = await Promise.all([
    runtimeStatus(profile),
    fetchSnapshot(baseUrl),
    fetchHealth(baseUrl),
    fetchEconomics(baseUrl, cfg.default_model),
  ]);

  let contextDiscovery: ContextWindowResolution[] = [];
  try {
    contextDiscovery = await readContextDiscoverySnapshot(profile);
  } catch {
    contextDiscovery = [];
  }

  return {
    schema_version: AGENT_REPORT_SCHEMA_VERSION,
    profile,
    port,
    selection: {
      default_model: cfg.default_model,
      active_models: cfg.skill_router?.active_models ?? [],
      skill_vectors: Object.fromEntries(
        (cfg.skill_router?.models ?? []).map((m) => [m.model, m.skill_vector]),
      ),
    },
    runtime: runtime ? {
      pid: runtime.pid,
      profile: runtime.profile,
      port: runtime.port,
      instance_id: runtime.instance,
      version: runtime.version,
      config: runtime.config,
      digest: runtime.digest,
      healthy: runtime.healthy,
      routing_ready: runtime.routingReady,
    } : null,
    router: health,
    harness: harnessConnection(profile, baseUrl),
    classifier: snapshot.diag,
    stats: snapshot.stats,
    economy: unifyEconomy(econ, snapshot.stats ?? EMPTY_STATS, cfg.default_model),
    context_discovery: contextDiscovery,
  };
}
