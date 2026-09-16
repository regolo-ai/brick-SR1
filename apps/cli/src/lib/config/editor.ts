import Enquirer from 'enquirer';
import yaml from 'js-yaml';
import { readFile } from 'node:fs/promises';
import pc from 'picocolors';
import { resolveContextWindows } from '../../lib/catalog/context-windows.js';
import { discoverModels } from '../../lib/catalog/discovery.js';
import { catalog } from '../../lib/catalog/index.js';
import { resolveProviderTransport } from '../../lib/catalog/transport.js';
import { isRegoloEndpoint,validateCredential } from '../../lib/config/credentials.js';
import { readEnvValue } from '../../lib/config/env-file.js';
import { paths } from '../../lib/config/paths.js';
import { ConfigSchema,type BrickConfig } from '../../lib/config/schema.js';
import { saveProfileSettings } from '../../lib/config/settings.js';
import { resolveSkillCards } from '../../lib/skills/resolver.js';
import * as p from '../../lib/ui/prompts.js';
import { applyComputeToConfig } from './classifier.js';

const AutoCompletePrompt: any = (Enquirer as any).AutoComplete;

export const CACHE_ROUTING_OPTIONS = [
  { value: 'off', label: 'off (route each request independently)' },
  { value: 'sticky', label: 'sticky (keep a conversation on the same model)' },
  { value: 'smartsqueeze', label: 'smartsqueeze (compact context when switching models)' },
] as const;

/** A searchable one-of-many menu whose filled square follows keyboard focus. */
export class SquareAutocomplete extends AutoCompletePrompt {
  indicator(choice: any): string {
    return choice === this.focused ? pc.cyan('■') : pc.dim('□');
  }

  pointer(): string {
    return '';
  }

  async renderChoice(choice: any, index: number): Promise<string> {
    return `${pc.cyan('│')}  ${await super.renderChoice(choice, index)}`;
  }
}

/** A searchable many-of-many menu whose filled squares persist across focus changes. */
export class SquareMultiAutocomplete extends AutoCompletePrompt {
  indicator(choice: any): string {
    return choice.enabled ? pc.cyan('■') : pc.dim('□');
  }

  pointer(): string {
    return '';
  }

  async renderChoice(choice: any, index: number): Promise<string> {
    return `${pc.cyan('│')}  ${await super.renderChoice(choice, index)}`;
  }
}

function searchableEnquirer(): any {
  const enquirer: any = new (Enquirer as any)({
    styles: {
      primary: (s: string) => pc.cyan(s),
      success: (s: string) => pc.cyan(s),
      em: (s: string) => pc.cyan(pc.bold(s)),
    },
  });
  enquirer.register('square-autocomplete', SquareAutocomplete);
  enquirer.register('square-multi-autocomplete', SquareMultiAutocomplete);
  return enquirer;
}

function disclaimerMultiline(target: 'providers' | 'models'): string {
  const max = 50;
  const w = Math.min(max, (process.stdout.columns ?? 80) - 8);
  const partsProviders = ['space = toggle ■/□', 'enter = confirm', 'type to filter (empty = all)'];
  const partsModels = [...partsProviders, 'No match → No Models Found'];
  const parts = target === 'providers' ? partsProviders : partsModels;
  const lines: string[] = [];
  let cur = '';
  for (const part of parts) {
    const sep = cur ? '  •  ' : '';
    if ((cur + sep + part).length > w) { lines.push(cur); cur = part; }
    else cur += sep + part;
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}

async function searchableMultiselect(
  message: string,
  choices: Array<{ value: string; label: string; hint?: string }>,
  initialValues: string[],
): Promise<string[] | null> {
  const isProviders = message.toLowerCase().includes('provider');
  p.note(disclaimerMultiline(isProviders ? 'providers' : 'models'), message);
  const enquirer = searchableEnquirer();
  try {
    const ans: any = await enquirer.prompt({
      type: 'square-multi-autocomplete',
      name: 'value',
      message,
      multiple: true,
      choices: choices.map((c) => ({ name: c.value, message: c.label, hint: c.hint })),
      initial: initialValues,
      limit: 12,
      symbols: { indicator: { on: '■', off: '□' }, prefix: ' ' },
    });
    const v = ans?.value;
    if (Array.isArray(v)) return v as string[];
    if (typeof v === 'string') return [v];
    return [];
  } catch (e: any) {
    if (e === '' || e?.message === '' || String(e).includes('canceled')) return null;
    throw e;
  }
}

function isCancel(v: unknown): boolean { return p.isCancel(v); }
function abort(): never { p.cancel('aborted'); process.exit(0); }

let currentEnvPath: string = '';
let pendingEnvValues: Record<string, string> = {};

/** True when the settings session has a secret change waiting for .env. */
export async function hasPendingEnvChanges(
  envPath: string,
  pendingValues: Record<string, string>,
  readValue: typeof readEnvValue = readEnvValue,
): Promise<boolean> {
  for (const [key, value] of Object.entries(pendingValues)) {
    if ((await readValue(envPath, key)) !== value) return true;
  }
  return false;
}

/** One transactional settings session. Unknown YAML keys are retained because
 * the raw object is mutated and written only once, on Save. */
export async function editConfigProfile(profile: string, title = `Brick settings  (profile: ${profile})`): Promise<void> {
    const pp = paths(profile);
    let cfg: BrickConfig;
    let raw: any;
    let originalText: string;
    try {
      originalText = await readFile(pp.config, 'utf8');
      raw = yaml.load(originalText);
      ConfigSchema.parse(raw);
      cfg = raw as BrickConfig;
    } catch (e: any) {
      throw new Error(`cannot load ${pp.config}: ${e?.message ?? e}`);
    }

    currentEnvPath = pp.env;
    pendingEnvValues = {};
    p.intro(title);

    while (true) {
      const yamlDirty = yaml.dump(raw, { lineWidth: 120, noRefs: true, sortKeys: false }) !==
        yaml.dump(yaml.load(originalText!), { lineWidth: 120, noRefs: true, sortKeys: false });
      const envDirty = await hasPendingEnvChanges(pp.env, pendingEnvValues);
      const dirty = yamlDirty || envDirty;
      const sec = await p.select({
        message: title,
        options: [
          { value: 'providers', label: 'Providers', hint: `${Object.keys(cfg.providers ?? {}).length} configured — incl. Claude/Codex` },
          { value: 'models', label: 'Models', hint: modelSummary(cfg) },
          { value: 'thinking', label: 'Thinking modes', hint: 'per-model allowed modes' },
          { value: 'cache_routing', label: 'Cache-aware routing', hint: (cfg as any).brick?.routing_mode ?? 'off' },
          { value: 'advanced', label: 'Advanced' },
          { value: 'save', label: dirty ? 'Save changes and exit' : 'Exit (no changes)' },
          { value: 'discard', label: 'Discard changes and exit' },
        ],
      });
      if (isCancel(sec)) abort();

      if (sec === 'save') {

        for (const ep of cfg.provider_endpoints ?? []) {
          const prov = (cfg.providers as any)?.[ep.provider_profile];
          if (!prov) continue;
          const cat: any = (catalog as any)[ep.provider_profile] ?? Object.values(catalog).find((c: any) => c.base_url.replace(/\/+$/, '') === prov.base_url.replace(/\/+$/, '')) ?? null;
          const envKey: string | undefined = cat?.env_key;
          const isOptional = !!cat?.optional;
          if (!envKey || isOptional) continue;
          const stored = pendingEnvValues[envKey] ?? await readEnvValue(pp.env, envKey) ?? (process.env as any)[envKey];
          if (!stored || !String(stored).trim()) {
            p.note(`API key for ${ep.name} (${envKey}) not set — save anyway, provider will fail at runtime (stored in ${pp.env})`, 'providers');
          }
        }
        normalizeRoutingInvariants(cfg);
        ConfigSchema.parse(raw);
        const result = await saveProfileSettings(profile, raw, pendingEnvValues);
        p.outro(`saved to ${pp.config}${result.routerWasRunning ? (result.restartedRouter ? '; router restarted once' : '; router restart failed') : ''}`);
        return;
      }
      if (sec === 'discard') { p.outro('discarded'); return; }

      if (sec === 'thinking') await editThinkingGlobal(cfg);
      else if (sec === 'cache_routing') await editCacheRouting(cfg);
      else if (sec === 'advanced') await editAdvanced(cfg);
      else await editSection(cfg, sec as string);
    }
}

async function editSection(cfg: BrickConfig, section: string): Promise<boolean> {
  switch (section) {
    case 'providers': return await editProvidersForConfig(cfg, currentEnvPath);
    case 'models': return await editModels(cfg);
    case 'server_port': return await editServerPort(cfg);
    case 'complexity': return await editComplexity(cfg);
    case 'brick': return await editBrick(cfg);
    default: return false;
  }
}

export async function editProvidersForConfig(cfg: BrickConfig, envPath = currentEnvPath): Promise<boolean> {
  const action = await p.select({
    message: 'Providers:',
    options: [
      { value: 'list', label: 'Providers list', hint: `${Object.keys(cfg.providers ?? {}).length} configured` },
      { value: 'addCustom', label: 'Add Custom Provider', hint: 'custom OpenAI-compatible' },
      { value: 'remove', label: 'Remove provider', hint: 'select who to remove' },
      { value: 'edit', label: 'Edit provider', hint: 'custom: nome/base_url/api key · nativi: only api key' },
      { value: 'back', label: '← back' },
    ],
  });
  if (isCancel(action) || action === 'back') return false;
  if (action === 'list') {
    const configured = Object.keys(cfg.providers ?? {});
    const catalogIds = Object.keys(catalog).filter((k) => k !== 'anthropic');
    const allIds = [...new Set([...catalogIds, ...configured])];
    const sel = await searchableMultiselect(
      'Providers list — space to toggle, type to filter',
      allIds.map((id) => {
        const isConfigured = configured.includes(id);
        const cat: any = (catalog as any)[id];
        let labelSuffix = '';
        if (id === 'openai') labelSuffix = ' (Api Key)';
        const label = (cat?.label ?? id) + labelSuffix;
        const hint = isConfigured ? pc.cyan('(enabled)') : pc.dim('(not configured)');
        return { value: id, label, hint };
      }),
      configured
    );
    if (sel === null || isCancel(sel as any)) return false;
    const selected = [...new Set(sel as string[])];
    const toAdd = selected.filter((id) => !configured.includes(id));
    const toRemove = configured.filter((id) => !selected.includes(id));
    if (!toAdd.length && !toRemove.length) return false;
    let changed = false;
    for (const id of toAdd) {
      const known: any = (catalog as any)[id];
      if (!known) continue;
      const isCodex = id === 'openai-codex';
      const isClaudeCode = id === 'claude-code';
      const isClaudeApi = id === 'claude-api';
      if (!known.optional) {
        const existingToken = pendingEnvValues[known.env_key] ?? await readEnvValue(envPath, known.env_key) ?? (process.env as any)[known.env_key];
        if (!existingToken) {
          const key = await p.password({ message: `${known.env_key} (blank to keep/set later; stored only in profile .env):` });
          if (isCancel(key)) continue;
          if (String(key).trim()) {
            if (!isRegoloEndpoint(known.base_url)) await validateCredential(known.base_url, String(key).trim(), isClaudeApi ? 'anthropic' : 'openai');
            pendingEnvValues[known.env_key] = String(key).trim();
          }
        }
      }
      (cfg.providers as any)[id] = { base_url: known.base_url };
      (cfg.provider_profiles as any)[id] = { type: known.type, base_url: known.base_url };
      if (!cfg.provider_endpoints.find((v: any) => v.name === id)) cfg.provider_endpoints.push({ name: id, provider_profile: id, weight: 1 });
      if (isClaudeApi && !(cfg as any).anthropic_passthrough) {
        (cfg as any).anthropic_passthrough = { enabled: true, use_skill_router: true, route_subagents: false, upstream_url: 'https://api.anthropic.com', model_map: { easy: cfg.default_model, medium: cfg.default_model, hard: cfg.default_model }, model_map_1m: { easy: cfg.default_model, medium: cfg.default_model, hard: cfg.default_model } };
      }
      if (isClaudeCode && !(cfg as any).anthropic_passthrough) {
        (cfg as any).anthropic_passthrough = { enabled: true, use_skill_router: true, route_subagents: false, upstream_url: 'https://api.anthropic.com', model_map: { easy: cfg.default_model, medium: cfg.default_model, hard: cfg.default_model }, model_map_1m: { easy: cfg.default_model, medium: cfg.default_model, hard: cfg.default_model } };
      }
      if (isCodex && !(cfg as any).brick) {
        (cfg as any).brick = { enabled: true, use_model_routing: true, routing_mode: 'smartsqueeze', context_window: { enabled: true, k: 8 }, ocr_min_text_length: 10 };
      }
      changed = true;
    }
    for (const id of toRemove) {
      const removedEndpoints = new Set(cfg.provider_endpoints.filter((v: any) => v.name === id || v.provider_profile === id).map((v: any) => v.name));
      const orphanedModels = Object.entries(cfg.model_config ?? {})
        .filter(([, mc]: any) => (mc.preferred_endpoints ?? []).every((ep: string) => removedEndpoints.has(ep)))
        .map(([m]) => m);
      if (cfg.skill_router?.enabled && activeModels(cfg).length > 0 && activeModels(cfg).every((m) => orphanedModels.includes(m))) {
        p.note(`Removing '${id}' would empty the active pool — skipped`, 'providers');
        continue;
      }
      delete (cfg.providers as any)[id];
      if (cfg.provider_profiles) delete (cfg.provider_profiles as any)[id];
      cfg.provider_endpoints = cfg.provider_endpoints.filter((v: any) => v.name !== id && v.provider_profile !== id);
      for (const [m, mc] of Object.entries(cfg.model_config ?? {})) {
        (mc as any).preferred_endpoints = ((mc as any).preferred_endpoints ?? []).filter((ep: string) => !removedEndpoints.has(ep));
        if ((mc as any).preferred_endpoints.length === 0) removeModelAtomic(cfg, m);
      }
      if ((id === 'claude-api' || id === 'claude-code' || id === 'anthropic') && (cfg as any).anthropic_passthrough) {
        const stillHasClaude = ['claude-api', 'claude-code', 'anthropic'].some((k) => (cfg.providers as any)?.[k]);
        if (!stillHasClaude) delete (cfg as any).anthropic_passthrough;
      }
      if (id === 'openai-codex' && (cfg as any).brick) {
        const stillHasCodex = !!(cfg.providers as any)?.['openai-codex'];
        if (!stillHasCodex) delete (cfg as any).brick;
      }
      changed = true;
    }
    if (changed) p.note(`${toAdd.length} added, ${toRemove.length} removed`, 'providers');
    return changed;
  }
  if (action === 'addCustom') {
    const customId = await p.text({
      message: 'Provider ID:',
      placeholder: 'my-provider',
      validate: (v) => {
        const t = v.trim();
        if (!/^[A-Za-z0-9._-]+$/.test(t)) return 'use letters, digits, dot, - or _';
        if ((cfg.providers as any)?.[t] || cfg.provider_endpoints?.some((ep: any) => ep.name === t)) return `ID '${t}' already exists`;
        if (!t) return 'required';
      },
    });
    if (isCancel(customId) || !String(customId).trim()) return false;
    const cid = String(customId).trim();
    const u = await p.text({
      message: 'base_url:',
      placeholder: 'https://api.example.com/v1',
      validate: (v) => { try { new URL(v); } catch { return 'enter an absolute URL'; } },
    });
    if (isCancel(u)) return false;
    const baseUrl = String(u).replace(/\/+$/, '');
    const envKey = isRegoloEndpoint(baseUrl) ? 'REGOLO_API_KEY' : `${cid.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_API_KEY`;
    const key = await p.password({ message: `${envKey} (blank to keep/set later):` });
    if (isCancel(key)) return false;
    if (String(key).trim()) {
      if (!isRegoloEndpoint(baseUrl)) await validateCredential(baseUrl, String(key).trim());
      pendingEnvValues[envKey] = String(key).trim();
    }
    (cfg.providers as any)[cid] = { base_url: baseUrl };
    (cfg.provider_profiles as any)[cid] = { type: 'openai_compatible', base_url: baseUrl };
    cfg.provider_endpoints.push({ name: cid, provider_profile: cid, weight: 1 });
    p.note(`custom provider '${cid}' added`, 'providers');
    return true;
  }
  if (action === 'remove') {
    const configured = Object.keys(cfg.providers ?? {});
    if (!configured.length) { p.note('no providers to remove', 'providers'); return false; }
    const sel = await searchableMultiselect(
      'Remove provider — select who to remove',
      configured.map((id) => {
        const cat: any = (catalog as any)[id];
        const prov: any = (cfg.providers as any)[id];
        return { value: id, label: cat?.label ?? id, hint: prov?.base_url ?? cat?.base_url ?? '' };
      }),
      []
    );
    if (sel === null || isCancel(sel as any) || !(sel as string[]).length) return false;
    let changed = false;
    for (const id of sel as string[]) {
      const removedEndpoints = new Set(cfg.provider_endpoints.filter((v: any) => v.name === id || v.provider_profile === id).map((v: any) => v.name));
      const orphanedModels = Object.entries(cfg.model_config ?? {})
        .filter(([, mc]: any) => (mc.preferred_endpoints ?? []).every((ep: string) => removedEndpoints.has(ep)))
        .map(([m]) => m);
      if (cfg.skill_router?.enabled && activeModels(cfg).length > 0 && activeModels(cfg).every((m) => orphanedModels.includes(m))) {
        p.note(`Removing '${id}' would empty the active pool — skipped`, 'providers');
        continue;
      }
      delete (cfg.providers as any)[id];
      if (cfg.provider_profiles) delete (cfg.provider_profiles as any)[id];
      cfg.provider_endpoints = cfg.provider_endpoints.filter((v: any) => v.name !== id && v.provider_profile !== id);
      for (const [m, mc] of Object.entries(cfg.model_config ?? {})) {
        (mc as any).preferred_endpoints = ((mc as any).preferred_endpoints ?? []).filter((ep: string) => !removedEndpoints.has(ep));
        if ((mc as any).preferred_endpoints.length === 0) removeModelAtomic(cfg, m);
      }
      if ((id === 'claude-api' || id === 'claude-code' || id === 'anthropic') && (cfg as any).anthropic_passthrough) {
        const stillHasClaude = ['claude-api', 'claude-code', 'anthropic'].some((k) => (cfg.providers as any)?.[k]);
        if (!stillHasClaude) delete (cfg as any).anthropic_passthrough;
      }
      if (id === 'openai-codex' && (cfg as any).brick) {
        const stillHasCodex = !!(cfg.providers as any)?.['openai-codex'];
        if (!stillHasCodex) delete (cfg as any).brick;
      }
      changed = true;
    }
    if (changed) p.note(`${(sel as string[]).length} provider(s) removed`, 'providers');
    return changed;
  }
  if (action === 'edit') {
    const configured = Object.keys(cfg.providers ?? {});
    if (!configured.length) { p.note('no providers to edit', 'providers'); return false; }
    const idSel = await searchableSelect(
      'Edit provider',
      configured.map((id) => {
        const cat: any = (catalog as any)[id];
        const isCustom = !(id in catalog);
        return { value: id, label: (cat?.label ?? id) + (isCustom ? ' (custom)' : ''), hint: isCustom ? (cfg.providers as any)[id]?.base_url ?? '' : 'native — only API key' };
      })
    );
    if (!idSel || isCancel(idSel as any)) return false;
    const id = String(idSel);
    const isCustom = !(id in catalog);
    if (isCustom) {
      const sub = await p.select({ message: `Edit custom ${id}:`, options: [{ value: 'name', label: 'Name' }, { value: 'base_url', label: 'base_url' }, { value: 'api_key', label: 'API key' }, { value: 'back', label: '← back' }] });
      if (isCancel(sub) || sub === 'back') return false;
      if (sub === 'name') {
        const v = await p.text({
          message: 'New provider ID:',
          initialValue: id,
          validate: (val) => {
            const t = val.trim();
            if (!/^[A-Za-z0-9._-]+$/.test(t)) return 'use letters, digits, dot, - or _';
            if (t !== id && ((cfg.providers as any)?.[t] || cfg.provider_endpoints?.some((ep: any) => ep.name === t))) return `ID '${t}' already exists`;
            if (!t) return 'required';
          },
        });
        if (isCancel(v)) return false;
        const nid = String(v).trim();
        if (nid !== id) {
          (cfg.providers as any)[nid] = (cfg.providers as any)[id];
          (cfg.provider_profiles as any)[nid] = (cfg.provider_profiles as any)[id];
          delete (cfg.providers as any)[id];
          delete (cfg.provider_profiles as any)[id];
          for (const ep of cfg.provider_endpoints) { if (ep.name === id) ep.name = nid; if (ep.provider_profile === id) ep.provider_profile = nid; }
          for (const mc of Object.values(cfg.model_config ?? {} as any)) {
            (mc as any).preferred_endpoints = ((mc as any).preferred_endpoints ?? []).map((ep: string) => ep === id ? nid : ep);
          }
          return true;
        }
        return false;
      }
      if (sub === 'base_url') {
        const v = await p.text({ message: 'base_url:', initialValue: (cfg.providers as any)[id]?.base_url ?? '', validate: (val) => { try { new URL(val); } catch { return 'enter an absolute URL'; } } });
        if (isCancel(v)) return false;
        const baseUrl = String(v).replace(/\/+$/, '');
        (cfg.providers as any)[id].base_url = baseUrl;
        (cfg.provider_profiles as any)[id].base_url = baseUrl;
        return true;
      }
      if (sub === 'api_key') {
        const envKey = isRegoloEndpoint((cfg.providers as any)[id]?.base_url ?? '') ? 'REGOLO_API_KEY' : `${id.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_API_KEY`;
        const v: any = await p.password({ message: `${envKey}:` });
        if (isCancel(v)) return false;
        if (String(v).trim()) pendingEnvValues[envKey] = String(v).trim();
        return !!String(v).trim();
      }
      return false;
    } else {
      const cat: any = (catalog as any)[id];
      const envKey: string = cat?.env_key;
      if (!envKey) { p.note('native provider has no API key', 'providers'); return false; }
      const v: any = await p.password({ message: `${envKey} (only API key editable for native):` });
      if (isCancel(v)) return false;
      if (String(v).trim()) { pendingEnvValues[envKey] = String(v).trim(); return true; }
      return false;
    }
  }
  return false;
}

async function editModels(cfg: BrickConfig): Promise<boolean> {
  if (!cfg.skill_router) { p.note('This profile has no skill_router block.', 'models'); return false; }
  const configured = Object.keys(cfg.model_config ?? {});
  const active = activeModels(cfg);
  const endpoints = cfg.provider_endpoints ?? [];
  let discoverable: string[] = [];
  const cardsById = new Map<string, any>();
  const endpointByModel = new Map<string, string>();
  for (const ep of endpoints) {
    const provider = cfg.providers?.[ep.provider_profile];
    if (!provider) continue;
    let discoveredIds: string[] = [];
    try {
      const envKey = resolveProviderTransport(ep.provider_profile, provider)?.apiKeyEnv;
      if (!envKey) throw new Error(`provider ${ep.provider_profile} has no credential source`);
      const token = await readEnvValue(currentEnvPath, envKey) ?? (process.env as any)[envKey];
      const discovered = await discoverModels(ep.name, provider.base_url, {
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
      discoveredIds = discovered.models.map((m) => m.id);
    } catch {
      const cat: any = (catalog as any)[ep.provider_profile];
      if (cat?.models?.length) discoveredIds = cat.models.map((m: any) => m.id);
      else continue;
    }
    try {
      const cards = await resolveSkillCards(discoveredIds);
      for (const id of discoveredIds) {
        const card = cards.get(id);
        if (!card) continue;
        if (!cardsById.has(id)) { cardsById.set(id, card); endpointByModel.set(id, ep.name); discoverable.push(id); }
      }
    } catch {}
  }
  const allIds = [...new Set([...configured, ...discoverable])].sort();
  if (allIds.length === 0) { p.note('no models — add a provider first', 'models'); return false; }
  const eligible = allIds.filter((id) => configured.includes(id) || cardsById.has(id));
  const sel = await searchableMultiselect(
    'Models',
    eligible.map((id) => {
      const epName = (cfg.model_config as any)?.[id]?.preferred_endpoints?.[0] ?? endpointByModel.get(id) ?? '';
      const prov = epName ? ` (${epName})` : '';
      const isActive = active.includes(id);
      return {
        value: id,
        label: `${id}${prov}`,
        hint: !configured.includes(id) ? 'available' : isActive ? pc.cyan('(active)') : pc.dim('(inactive)'),
      };
    }),
    active.filter((id) => eligible.includes(id)),
  );
  if (sel === null || isCancel(sel as any)) return false;
  const selected = [...new Set(sel as string[])];
  if (cfg.skill_router.enabled && selected.length === 0) {
    p.note('The active routing pool cannot be empty.', 'models');
    return false;
  }
  let changed = false;
  for (const id of selected) {
    if (!configured.includes(id)) {
      const card = cardsById.get(id)!;
      const epName = endpointByModel.get(id)!;
      const ep = endpoints.find((e) => e.name === epName)!;
      const provider = cfg.providers![ep.provider_profile]!;
      const transport = resolveProviderTransport(ep.provider_profile, provider);
      addModelAtomic(cfg, id, epName, card, transport ?? undefined);
      changed = true;
    }
  }
  const toDeactivate = active.filter((id) => !selected.includes(id));
  const toActivate = selected.filter((id) => !active.includes(id) && configured.includes(id));
  if (toDeactivate.length || toActivate.length) {
    cfg.skill_router.active_models = selected;
    if (selected.length && !selected.includes(cfg.default_model)) cfg.default_model = selected[0];
    changed = true;
  }
  const toRemove = configured.filter((id) => !selected.includes(id) && !active.includes(id) && !discoverable.includes(id));
  for (const id of toRemove) {
    if (Object.keys(cfg.model_config ?? {}).includes(id) && !selected.includes(id) && !active.includes(id)) {
      // keep configured but inactive models — do not delete model_config here; deactivation is enough
    }
  }
  if (selected.length) {
    const stillConfigured = new Set(Object.keys(cfg.model_config ?? {}));
    for (const id of selected) if (!stillConfigured.has(id) && !cardsById.has(id)) { /* no-op */ }
  }
  if (selected.length) {
    const discoveryEnv: Record<string, string | undefined> = { ...process.env, ...pendingEnvValues };
    for (const [providerId, provider] of Object.entries(cfg.provider_profiles ?? {})) {
      const envKey = resolveProviderTransport(providerId, provider)?.apiKeyEnv;
      if (envKey && discoveryEnv[envKey] == null) discoveryEnv[envKey] = await readEnvValue(currentEnvPath, envKey) ?? undefined;
    }
    try {
      const resolutions = await resolveContextWindows(cfg, { env: discoveryEnv });
      for (const resolution of resolutions) {
        if (resolution.maxInputTokens && resolution.state !== 'error') {
          const entry = cfg.model_config[resolution.model];
          if (entry.context_window_size !== resolution.maxInputTokens) {
            entry.context_window_size = resolution.maxInputTokens;
            changed = true;
          }
          continue;
        }
        if (resolution.provider in catalog) continue;
        const value = await p.text({
          message: `Maximum operational input for custom model ${resolution.model} (tokens):`,
          validate(input) {
            const parsed = Number(input);
            return Number.isInteger(parsed) && parsed > 0 ? undefined : 'Enter a positive whole number.';
          },
        });
        if (isCancel(value)) return false;
        cfg.model_config[resolution.model].context_window_size = Number(value);
        changed = true;
      }
    } catch (error: any) {
      p.note(`${error?.message ?? error}. Brick will retry and verify all active limits at start.`, 'context discovery');
    }
  }
  return changed;
}

export function activeModels(cfg: BrickConfig): string[] {
  const sr = cfg.skill_router;
  const source = sr?.active_models?.length ? sr.active_models : (sr?.models ?? []).map((entry) => entry.model);
  return [...new Set(source.filter((id): id is string => typeof id === 'string' && !!id))];
}

function modelSummary(cfg: BrickConfig): string {
  return `${activeModels(cfg).length} active · ${Object.keys(cfg.model_config ?? {}).length} configured`;
}

export function addModelAtomic(
  cfg: BrickConfig,
  model: string,
  endpoint: string,
  card: any,
  transport?: { baseUrl: string; apiKeyEnv?: string },
  contextWindowSize?: number,
): void {
  cfg.model_config ??= {};
  const current = cfg.model_config[model] ?? { preferred_endpoints: [] };
  current.preferred_endpoints = [...new Set([...(current.preferred_endpoints ?? []), endpoint])];
  if (contextWindowSize != null) current.context_window_size = contextWindowSize;
  cfg.model_config[model] = current;

  if (!cfg.skill_router) throw new Error('profile has no skill_router block; initialize routing before adding catalog models');
  const existing = cfg.skill_router.models.find((entry) => entry.model === model);
  if (existing) {
    existing.skill_vector = [...card.skill_vector];
    // Keep the established primary transport when this model is attached to a
    // second endpoint. model_config retains all endpoint associations.
    if (!existing.base_url && transport?.baseUrl) existing.base_url = transport.baseUrl;
    if (!existing.api_key_env && transport?.apiKeyEnv) existing.api_key_env = transport.apiKeyEnv;
  } else {
    cfg.skill_router.models.push({
      model,
      skill_vector: [...card.skill_vector],
      use_reasoning: false,
      ...(transport?.baseUrl ? { base_url: transport.baseUrl } : {}),
      ...(transport?.apiKeyEnv ? { api_key_env: transport.apiKeyEnv } : {}),
    });
  }
  cfg.skill_router.active_models = [...new Set([...activeModels(cfg), model])];
  if (!cfg.default_model || !cfg.model_config[cfg.default_model]) cfg.default_model = model;
}

export function removeModelAtomic(cfg: BrickConfig, model: string): void {
  delete cfg.model_config?.[model];
  if (cfg.skill_router) {
    cfg.skill_router.models = cfg.skill_router.models.filter((entry) => entry.model !== model);
    cfg.skill_router.active_models = activeModels(cfg).filter((id) => id !== model);
  }
  for (const map of [cfg.anthropic_passthrough?.model_map, cfg.anthropic_passthrough?.model_map_1m]) {
    if (!map) continue;
    for (const key of Object.keys(map)) if ((map as any)[key] === model) delete (map as any)[key];
  }
  if (cfg.anthropic_passthrough?.fixed_model === model) delete cfg.anthropic_passthrough.fixed_model;
  if (cfg.brick?.fixed_model === model) delete cfg.brick.fixed_model;
  if (cfg.default_model === model) cfg.default_model = activeModels(cfg)[0] ?? Object.keys(cfg.model_config ?? {})[0] ?? '';
}

export function normalizeRoutingInvariants(cfg: BrickConfig): void {
  if (!cfg.skill_router) return;
  const configured = new Set(Object.keys(cfg.model_config ?? {}));
  cfg.skill_router.models = cfg.skill_router.models.filter((entry) => configured.has(entry.model));
  const skillIds = new Set(cfg.skill_router.models.map((entry) => entry.model));
  cfg.skill_router.active_models = activeModels(cfg).filter((id) => configured.has(id) && skillIds.has(id));
  if (cfg.skill_router.enabled && cfg.skill_router.active_models.length === 0) {
    throw new Error('skill_router is enabled but the active model pool is empty');
  }
  if (!configured.has(cfg.default_model)) cfg.default_model = cfg.skill_router.active_models[0] ?? [...configured][0] ?? cfg.default_model;
}

export async function editThinkingGlobal(
  cfg: BrickConfig,
  selectModel: (message: string, choices: Array<{ value: string; label: string }>) => Promise<string | null> = searchableSelect,
  editModes: (cfg: BrickConfig, model: string) => Promise<boolean> = editThinkingModes,
): Promise<boolean> {
  let changed = false;
  while (true) {
    const ids = activeModels(cfg);
    if (!ids.length) { p.note('no models in pool', 'thinking'); return changed; }
    const model = await selectModel('Thinking — select model', [
      ...ids.map((id) => {
        const ep = (cfg.model_config as any)[id]?.preferred_endpoints?.[0] ?? '';
        return { value: id, label: `${id}${ep ? ` (${ep})` : ''}` };
      }),
      { value: '__back__', label: '← back' },
    ]);
    if (!model || model === '__back__') return changed;
    changed = await editModes(cfg, model) || changed;
  }
}

async function searchableSelect(message: string, choices: Array<{ value: string; label: string }>): Promise<string | null> {
  const enquirer = searchableEnquirer();
  try {
    const ans: any = await enquirer.prompt({
      type: 'square-autocomplete',
      name: 'value',
      message,
      multiple: false,
      initial: 0,
      choices: choices.map((c) => ({ name: c.value, message: c.label })),
      limit: 12,
      symbols: { indicator: { on: '■', off: '□' }, prefix: ' ' },
    });
    return ans?.value ?? null;
  } catch (e: any) { if (e === '' || String(e).includes('canceled')) return null; throw e; }
}

async function editCacheRouting(cfg: BrickConfig): Promise<boolean> {
  if (!(cfg as any).brick) (cfg as any).brick = { enabled: true, routing_mode: 'off' };
  const cur = (cfg as any).brick.routing_mode ?? 'off';
  const sel = await p.select({ message: 'Cache-aware routing:', options: [...CACHE_ROUTING_OPTIONS], initialValue: cur });
  if (isCancel(sel) || sel === cur) return false;
  (cfg as any).brick.routing_mode = sel as string;
  return true;
}

async function editThinkingModes(cfg: BrickConfig, model: string): Promise<boolean> {
  const current = cfg.model_config?.[model]?.allowed_thinking_modes ?? [];
  const modes = await p.multiselect({
    message: `Allowed thinking modes for ${model}:`,
    options: ['off', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value })),
    initialValues: current,
    required: false,
  });
  if (isCancel(modes)) return false;
  const selected = modes as any[];
  cfg.model_config[model].allowed_thinking_modes = selected.includes('off') ? ['off'] : selected;
  if (!selected.length) delete cfg.model_config[model].allowed_thinking_modes;
  return true;
}

async function editAdvanced(cfg: BrickConfig): Promise<boolean> {
  const action = await p.select({
    message: 'Advanced:',
    options: [
      { value: 'server_port', label: 'Server port', hint: String(cfg.server_port) },
      { value: 'complexity', label: 'Complexity service', hint: cfg.complexity_service?.enabled ? 'on' : 'off' },
      { value: 'brick', label: 'Multimodal Brick', hint: cfg.brick?.enabled ? 'on' : 'off' },
      { value: 'back', label: '← back' },
    ],
  });
  if (isCancel(action) || action === 'back') return false;
  return editSection(cfg, String(action));
}

async function editServerPort(cfg: BrickConfig): Promise<boolean> {
  const v = await p.text({
    message: 'Server port:',
    defaultValue: String(cfg.server_port),
    validate: (s) => /^\d+$/.test(s) && Number(s) > 0 && Number(s) < 65536 ? undefined : 'enter a port between 1 and 65535',
  });
  if (isCancel(v)) abort();
  const n = Number(v);
  if (n === cfg.server_port) return false;
  cfg.server_port = n;
  return true;
}


async function editComplexity(cfg: BrickConfig): Promise<boolean> {
  const mode = await p.select({
    message: 'Complexity classifier:',
    options: [
      { value: 'remote', label: 'Remote (OpenAI-compatible API)', hint: 'custom /v1/chat/completions endpoint' },
      { value: 'off', label: 'Disable', hint: 'no complexity signal' },
    ],
    initialValue: cfg.complexity_service?.enabled
      ? 'remote'
      : 'off',
  });
  if (isCancel(mode)) abort();

  if (mode === 'off') {
    if (!cfg.complexity_service?.enabled) return false;
    cfg.complexity_service = undefined as any;
    return true;
  }

  if (mode === 'remote') {
    const baseUrl = await p.text({ message: 'Remote base_url:', defaultValue: cfg.complexity_service?.base_url ?? '' });
    if (isCancel(baseUrl)) abort();
    const modelName = await p.text({ message: 'Model name (sent to the API):', defaultValue: cfg.complexity_service?.model_name ?? 'brick-complexity-pro' });
    if (isCancel(modelName)) abort();
    const token = await p.password({ message: 'Bearer token (blank to keep current / skip):' });
    if (isCancel(token)) abort();
    const envKey = isRegoloEndpoint(String(baseUrl).trim()) ? 'REGOLO_API_KEY' : 'COMPLEXITY_API_KEY';
    const keepToken = cfg.complexity_service?.bearer_token;
    if (String(token).trim()) {
      // Validate before mutating the in-memory YAML; the profile .env is the
      // only persistence location for a custom classifier secret.
      await validateCredential(String(baseUrl).trim(), String(token).trim(), 'openai', String(modelName).trim());
      pendingEnvValues[envKey] = String(token).trim();
    }
    applyComputeToConfig(cfg, 'api', { baseUrl: String(baseUrl).trim(), model: String(modelName).trim() });
    if (!String(token).trim() && keepToken && !isRegoloEndpoint(String(baseUrl).trim())) {
      cfg.complexity_service!.bearer_token = keepToken;
      if (cfg.skill_router?.complexity_model) cfg.skill_router.complexity_model.bearer_token = keepToken;
    }
  }
  return true;
}

async function editBrick(cfg: BrickConfig): Promise<boolean> {
  const enable = await p.confirm({ message: 'Enable Brick multimodal (STT / OCR / Vision)?', initialValue: !!cfg.brick?.enabled });
  if (isCancel(enable)) abort();
  if (!enable) {
    if (!cfg.brick?.enabled) return false;
    cfg.brick = undefined as any;
    return true;
  }
  const sttModel = await p.text({ message: 'STT model:', defaultValue: cfg.brick?.stt_model ?? 'faster-whisper-large-v3' });
  if (isCancel(sttModel)) abort();
  const sttEp = await p.text({ message: 'STT endpoint:', defaultValue: cfg.brick?.stt_endpoint ?? 'https://api.regolo.ai/v1/audio/transcriptions' });
  if (isCancel(sttEp)) abort();
  const ocrModel = await p.text({ message: 'OCR model:', defaultValue: cfg.brick?.ocr_model ?? 'deepseek-ocr-2' });
  if (isCancel(ocrModel)) abort();
  const ocrEp = await p.text({ message: 'OCR endpoint:', defaultValue: cfg.brick?.ocr_endpoint ?? 'https://api.regolo.ai/v1/chat/completions' });
  if (isCancel(ocrEp)) abort();
  const visionModel = await p.text({ message: 'Vision model:', defaultValue: cfg.brick?.vision_model ?? 'qwen3.5-122b' });
  if (isCancel(visionModel)) abort();
  const visionEp = await p.text({ message: 'Vision endpoint:', defaultValue: cfg.brick?.vision_endpoint ?? 'https://api.regolo.ai/v1/chat/completions' });
  if (isCancel(visionEp)) abort();
  const minTextLen = await p.text({
    message: 'OCR min text length:',
    defaultValue: String(cfg.brick?.ocr_min_text_length ?? 10),
    validate: (s) => /^\d+$/.test(s) ? undefined : 'must be an integer',
  });
  if (isCancel(minTextLen)) abort();
  cfg.brick = {
    enabled: true,
    stt_model: String(sttModel), stt_endpoint: String(sttEp),
    ocr_model: String(ocrModel), ocr_endpoint: String(ocrEp),
    vision_model: String(visionModel), vision_endpoint: String(visionEp),
    ocr_min_text_length: Number(minTextLen),
  };
  return true;
}
