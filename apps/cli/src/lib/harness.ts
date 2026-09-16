import { ensureCodexLocalKey } from './codex/native-transport.js';
import { localBaseUrl } from './net/local.js';
import { getBaseUrl, hasBrickModelOption, restoreBaseUrl, setBaseUrl } from './claude/settings.js';
import { clearWiring, readWiring, writeWiring } from './claude/wiring-state.js';
import { getTopLevelModel, getTopLevelModelProvider, isWired, readCodexConfig, unwireCodex, wireCodex, codexModelCatalogPath } from './codex/config-toml.js';
import { clearCodexWiring, readCodexWiring, writeCodexWiring } from './codex/wiring-state.js';

export async function connectOfficialHarness(profile: string, port: number): Promise<void> {
  const baseUrl = localBaseUrl(port);
  if (profile === 'claude') {
    const old = readWiring();
    if (old?.baseUrl === baseUrl && getBaseUrl() === baseUrl && hasBrickModelOption()) return;
    const previousBaseUrl = old?.previousBaseUrl ?? getBaseUrl() ?? null;
    const result = setBaseUrl(baseUrl);
    writeWiring({ wired: true, baseUrl, previousBaseUrl, createdEnvBlock: old?.createdEnvBlock ?? result.createdEnvBlock });
  } else if (profile === 'codex') {
    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000), redirect: 'error' }).then(r => r.json()) as any;
    const hasNativeCodexResponses = health.codex_router === 'native-responses-v1';
    if (!hasNativeCodexResponses) {
      throw new Error('The running Brick router is outdated and does not support native Codex Responses. Update Brick with `brick update`, restart the Codex profile, then connect the harness.');
    }
    const localKey = await ensureCodexLocalKey(profile);
    const old = readCodexWiring(); const config = readCodexConfig();
    if (old?.baseUrl === baseUrl && isWired(config) && getTopLevelModel(config) === 'brick' && getTopLevelModelProvider(config) === 'brick' && config.includes(JSON.stringify(localKey))) return;
    const result = wireCodex(baseUrl, codexModelCatalogPath(), localKey);
    writeCodexWiring({ ...old, wired: true, baseUrl,
      previousModel: old?.wired ? old.previousModel : result.previousModel,
      previousModelProvider: old?.wired ? old.previousModelProvider : result.previousModelProvider,
      previousProfile: old?.wired ? old.previousProfile : result.previousProfile,
      previousModelCatalog: old?.wired ? old.previousModelCatalog : result.previousModelCatalog,
      managedModelCatalog: result.managedModelCatalog,
      createdFile: old?.wired ? old.createdFile : result.createdFile,
    });
  }
}

export async function disconnectOfficialHarness(profile: string): Promise<void> {
  if (profile === 'claude') {
    const state = readWiring(); if (!state) return;
    restoreBaseUrl(state.previousBaseUrl, state.createdEnvBlock); clearWiring();
  } else if (profile === 'codex') {
    const state = readCodexWiring(); if (!state) return;
    unwireCodex(state); clearCodexWiring();
  }
}

/** Refresh an attached harness after a ready runtime changes its port. */
export async function refreshOfficialHarness(profile: string, port: number): Promise<void> {
  if (profile === 'claude') {
    const old = readWiring();
    if (old?.wired && getBaseUrl() === old.baseUrl) await connectOfficialHarness(profile, port);
  } else if (profile === 'codex') {
    if (readCodexWiring()?.wired && isWired(readCodexConfig())) await connectOfficialHarness(profile, port);
  }
}
