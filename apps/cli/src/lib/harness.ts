import { ensureCodexLocalKey } from './codex/native-transport.js';
import { localBaseUrl } from './net/local.js';
import { getBaseUrl, hasBrickModelOption, restoreBaseUrl, setBaseUrl } from './claude/settings.js';
import { clearWiring, readWiring, writeWiring } from './claude/wiring-state.js';
import { getTopLevelModel, getTopLevelModelProvider, isWired, readCodexConfig, unwireCodex, wireCodex, codexModelCatalogPath } from './codex/config-toml.js';
import { clearCodexWiring, readCodexWiring, writeCodexWiring } from './codex/wiring-state.js';
import { isWired as isOpencodeWired, opencodeConfigPath, unwireOpencode, wireOpencode } from './opencode/wiring.js';
import { readOpencodeWiring } from './opencode/wiring-state.js';
import { installOpencodePlugin, isOpencodePluginInstalled, uninstallOpencodePlugin } from './opencode/plugin-install.js';
import { catalog } from './catalog/index.js';
import { readFileSync } from 'node:fs';

/** Raw JSONC of `~/.config/opencode/opencode.json`, or '' when it does not exist. */
function readOpencodeConfig(): string {
  try {
    return readFileSync(opencodeConfigPath(), 'utf8');
  } catch {
    return '';
  }
}

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
  } else if (profile === 'opencode') {
    const old = readOpencodeWiring();
    if (old?.baseUrl === baseUrl && isOpencodeWired(readOpencodeConfig()) && isOpencodePluginInstalled()) return;
    wireOpencode(baseUrl, catalog.opencode?.models.map((model) => model.id) ?? []);
    installOpencodePlugin();
  }
}

export async function disconnectOfficialHarness(profile: string): Promise<void> {
  if (profile === 'claude') {
    const state = readWiring(); if (!state) return;
    restoreBaseUrl(state.previousBaseUrl, state.createdEnvBlock); clearWiring();
  } else if (profile === 'codex') {
    const state = readCodexWiring(); if (!state) return;
    unwireCodex(state); clearCodexWiring();
  } else if (profile === 'opencode') {
    unwireOpencode();
    uninstallOpencodePlugin();
  }
}

/** Refresh an attached harness after a ready runtime changes its port. */
export async function refreshOfficialHarness(profile: string, port: number): Promise<void> {
  if (profile === 'claude') {
    const old = readWiring();
    if (old?.wired && getBaseUrl() === old.baseUrl) await connectOfficialHarness(profile, port);
  } else if (profile === 'codex') {
    if (readCodexWiring()?.wired && isWired(readCodexConfig())) await connectOfficialHarness(profile, port);
  } else if (profile === 'opencode') {
    if (readOpencodeWiring()?.wired && isOpencodeWired(readOpencodeConfig())) await connectOfficialHarness(profile, port);
  }
}

export function normalizedUrl(value?: string | null): string | undefined {
  return value?.replace(/\/+$/, '');
}

export type HarnessConnection = {
  url?: string;
  attached: boolean;
  label: string;
  disconnectedLabel: string;
  unattachedLabel: string;
};

export function harnessConnection(profile: string, baseUrl: string): HarnessConnection {
  if (profile === 'codex') {
    const wiring = readCodexWiring();
    const config = readCodexConfig();
    return {
      url: normalizedUrl(wiring?.baseUrl),
      attached: !!wiring?.wired && normalizedUrl(wiring.baseUrl) === normalizedUrl(baseUrl) &&
        isWired(config) && getTopLevelModel(config) === 'brick' && getTopLevelModelProvider(config) === 'brick',
      label: 'Codex config',
      disconnectedLabel: 'not wired — run brick start codex after updating the router',
      unattachedLabel: 'not wired to this router',
    };
  }
  if (profile === 'claude') {
    const wiring = readWiring();
    const settingsUrl = normalizedUrl(getBaseUrl());
    return {
      url: settingsUrl,
      attached: !!wiring?.wired && settingsUrl === normalizedUrl(baseUrl) && hasBrickModelOption(),
      label: 'Claude settings',
      disconnectedLabel: 'not wired — run brick start claude',
      unattachedLabel: 'not wired to this router',
    };
  }
  if (profile === 'opencode') {
    const wiring = readOpencodeWiring();
    return {
      url: normalizedUrl(wiring?.baseUrl),
      attached: !!wiring?.wired && normalizedUrl(wiring.baseUrl) === normalizedUrl(baseUrl) &&
        isOpencodeWired(readOpencodeConfig()) && isOpencodePluginInstalled(),
      label: 'OpenCode config',
      disconnectedLabel: 'not wired — run brick start opencode',
      unattachedLabel: 'not wired to this router',
    };
  }
  return { url: baseUrl, attached: true, label: `profile ${profile}`, disconnectedLabel: 'not attached', unattachedLabel: 'not attached' };
}
