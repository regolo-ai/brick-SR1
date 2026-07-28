import { Args, Command } from '@oclif/core';
import * as p from '@clack/prompts';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { paths, resolveProfile } from '../../lib/config/paths.js';
import { ConfigSchema, type BrickConfig } from '../../lib/config/schema.js';
import { saveConfig } from '../../lib/config/save.js';
import { catalog } from '../../lib/catalog/index.js';
import { runDecisionBuilder } from '../../lib/wizard/steps/decisions.js';
import { writeCompose } from '../../lib/docker/compose.js';
import { err } from '../../lib/ui/banners.js';

function isCancel(v: unknown): boolean { return p.isCancel(v); }
function abort(): never { p.cancel('aborted'); process.exit(0); }

let currentEnvPath: string = '';

export default class ConfigEdit extends Command {
  static description = 'Edit the configuration of a profile through a navigable menu';
  static args = {
    profile: Args.string({ required: false, description: 'profile name (defaults to active profile)' }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(ConfigEdit);
    const profile = resolveProfile(args.profile);
    await editConfigProfile(profile, `brick config edit (profile: ${profile})`);
  }
}

/** Run the generic YAML editor for a resolved profile. Kept separate so the
 * top-level `brick settings <profile>` command can expose the same editor
 * without pretending to be a Claude or Codex settings surface. */
export async function editConfigProfile(profile: string, title = `brick config edit (profile: ${profile})`): Promise<void> {
    const pp = paths(profile);
    let cfg: BrickConfig;
    let raw: any;
    try {
      const text = await readFile(pp.config, 'utf8');
      raw = yaml.load(text);
      cfg = ConfigSchema.parse(raw);
    } catch (e: any) {
      throw new Error(`cannot load ${pp.config}: ${e?.message ?? e}`);
    }

    currentEnvPath = pp.env;
    p.intro(title);
    let dirty = false;

    while (true) {
      const sec = await p.select({
        message: 'What do you want to change?',
        options: [
          { value: 'providers', label: 'Providers', hint: `${Object.keys(cfg.providers ?? {}).length} configured` },
          { value: 'models', label: 'Models', hint: `${Object.keys(cfg.model_config ?? {}).length} entries` },
          { value: 'default_model', label: 'Default model', hint: cfg.default_model },
          { value: 'server_port', label: 'Server port', hint: String(cfg.server_port) },
          { value: 'skill_router', label: 'Skill router', hint: cfg.skill_router?.enabled ? `${cfg.skill_router.models.length} models` : 'off' },
          { value: 'classifier', label: 'Legacy classifier (domain)', hint: cfg.classifier ? 'on' : 'off' },
          { value: 'complexity', label: 'Complexity service', hint: cfg.complexity_service?.enabled ? (cfg.complexity_service.base_url ?? `${cfg.complexity_service.address}:${cfg.complexity_service.port}`) : 'off' },
          { value: 'brick', label: 'Multimodal Brick (STT/OCR/Vision)', hint: cfg.brick?.enabled ? 'on' : 'off' },
          { value: 'reasoning_effort', label: 'Default reasoning effort', hint: cfg.default_reasoning_effort },
          { value: 'decisions', label: 'Legacy decisions', hint: `${cfg.decisions.length} routes` },
          { value: 'plugins', label: 'Plugins (PII / jailbreak / cache / prompt-guard)' },
          { value: 'save', label: dirty ? 'Save and exit' : 'Exit (no changes)' },
          { value: 'discard', label: 'Discard changes and exit' },
        ],
      });
      if (isCancel(sec)) abort();

      if (sec === 'save') {
        if (!dirty) { p.outro('no changes'); return; }
        cfg = ConfigSchema.parse(cfg);
        await saveConfig(cfg, profile);
        await writeCompose({ profile, port: cfg.server_port });
        p.outro(`saved to ${pp.config} (compose updated for port ${cfg.server_port})`);
        return;
      }
      if (sec === 'discard') { p.outro('discarded'); return; }

      const changed = await editSection(cfg, sec as string);
      if (changed) dirty = true;
    }
}

async function editSection(cfg: BrickConfig, section: string): Promise<boolean> {
  switch (section) {
    case 'providers': return await editProvidersForConfig(cfg, currentEnvPath);
    case 'models': return await editModels(cfg);
    case 'default_model': return await editDefaultModel(cfg);
    case 'server_port': return await editServerPort(cfg);
    case 'skill_router': return await editSkillRouter(cfg);
    case 'classifier': return await editClassifier(cfg);
    case 'complexity': return await editComplexity(cfg);
    case 'brick': return await editBrick(cfg);
    case 'reasoning_effort': return await editReasoningEffort(cfg);
    case 'decisions': return await editDecisions(cfg);
    case 'plugins': return await editPlugins(cfg);
    default: return false;
  }
}

export async function editProvidersForConfig(cfg: BrickConfig, envPath = currentEnvPath): Promise<boolean> {
  const action = await p.select({
    message: 'Providers:',
    options: [
      { value: 'list', label: `View list (${Object.keys(cfg.providers ?? {}).length})` },
      { value: 'add', label: 'Add provider' },
      { value: 'remove', label: 'Remove provider' },
      { value: 'back', label: '← back' },
    ],
  });
  if (isCancel(action)) abort();
  if (action === 'back') return false;

  if (action === 'list') {
    p.note(
      Object.entries(cfg.providers ?? {}).map(([id, v]) => `${id} · ${v.type} · ${v.base_url}`).join('\n') || '(none)',
      'providers'
    );
    return false;
  }

  if (action === 'add') {
    const known = Object.keys(catalog).filter((k) => !cfg.providers?.[k]);
    const choices = [
      ...known.map((k) => ({ value: k, label: catalog[k].label, hint: catalog[k].base_url })),
      { value: '__custom__', label: 'Custom (provide id + base_url)' },
    ];
    if (choices.length === 1) { p.note('all built-in providers already added; only custom is available', 'providers'); }
    const which = await p.select({ message: 'Which provider?', options: choices });
    if (isCancel(which)) abort();
    let id: string; let baseUrl: string;
    if (which === '__custom__') {
      const i = await p.text({ message: 'Provider id:' });
      if (isCancel(i)) abort();
      id = String(i).trim();
      const u = await p.text({ message: 'base_url:', placeholder: 'https://...' });
      if (isCancel(u)) abort();
      baseUrl = String(u).trim();
    } else {
      id = String(which);
      baseUrl = catalog[id].base_url;
    }
    cfg.providers ??= {} as any;
    (cfg.providers as any)[id] = { type: 'openai_compatible', base_url: baseUrl };
    cfg.provider_profiles ??= {} as any;
    (cfg.provider_profiles as any)[id] = { type: 'openai_compatible', base_url: baseUrl };
    if (!cfg.provider_endpoints.find((v) => v.name === id)) cfg.provider_endpoints.push({ name: id, provider_profile: id, weight: 1 });
    p.note(`provider '${id}' added. remember to put the API key in ${envPath} (variable ${(catalog[id]?.env_key) ?? `${id.toUpperCase()}_API_KEY`}).`, 'providers');
    return true;
  }

  // remove
  const pids = Object.keys(cfg.providers ?? {});
  if (pids.length === 0) { p.note('no providers to remove', 'providers'); return false; }
  const idSel = await p.select({ message: 'Remove which provider?', options: pids.map((x) => ({ value: x, label: x })) });
  if (isCancel(idSel)) abort();
  const id = String(idSel);
  delete (cfg.providers as any)[id];
  if (cfg.provider_profiles) delete (cfg.provider_profiles as any)[id];
  cfg.provider_endpoints = cfg.provider_endpoints.filter((v) => v.name !== id);
  for (const [m, mc] of Object.entries(cfg.model_config ?? {})) {
    mc.preferred_endpoints = (mc.preferred_endpoints ?? []).filter((pp: string) => pp !== id);
    if (mc.preferred_endpoints.length === 0) delete (cfg.model_config as any)[m];
  }
  p.note(`provider '${id}' removed (and orphan models pruned)`, 'providers');
  return true;
}

async function editModels(cfg: BrickConfig): Promise<boolean> {
  const action = await p.select({
    message: 'Models:',
    options: [
      { value: 'list', label: `View list (${Object.keys(cfg.model_config ?? {}).length})` },
      { value: 'add', label: 'Add model from catalog' },
      { value: 'remove', label: 'Remove model' },
      { value: 'back', label: '← back' },
    ],
  });
  if (isCancel(action)) abort();
  if (action === 'back') return false;
  if (action === 'list') {
    p.note(
      Object.entries(cfg.model_config ?? {}).map(([id, m]) => `${id} · ${(m.preferred_endpoints ?? []).join(',')} · ${m.param_size ?? '-'}${m.reasoning_family ? ' · ' + m.reasoning_family : ''}`).join('\n') || '(none)',
      'models'
    );
    return false;
  }
  if (action === 'add') {
    const enabledProviders = Object.keys(cfg.providers ?? {});
    if (enabledProviders.length === 0) { p.note('no providers configured — add a provider first', 'models'); return false; }
    const provider = await p.select({ message: 'Which provider?', options: enabledProviders.map((x) => ({ value: x, label: x })) });
    if (isCancel(provider)) abort();
    const cat = catalog[String(provider)];
    if (!cat || cat.models.length === 0) {
      const id = await p.text({ message: 'Model id:' });
      if (isCancel(id)) abort();
      const ps = await p.text({ message: 'param_size (e.g. 9b, 70b, unknown):', defaultValue: 'unknown' });
      if (isCancel(ps)) abort();
      cfg.model_config ??= {} as any;
      (cfg.model_config as any)[String(id)] = { preferred_endpoints: [String(provider)], param_size: String(ps || 'unknown') };
      return true;
    }
    const available = cat.models.filter((m) => !cfg.model_config?.[m.id]);
    if (available.length === 0) { p.note(`all ${cat.label} models already added`, 'models'); return false; }
    const sel = await p.multiselect({
      message: `Pick models from ${cat.label}:`,
      options: available.map((m) => ({ value: m.id, label: `${m.label} (${m.param_size})`, hint: m.reasoning_family })),
      required: true,
    });
    if (isCancel(sel)) abort();
    cfg.model_config ??= {} as any;
    for (const id of sel as string[]) {
      const m = cat.models.find((x) => x.id === id)!;
      (cfg.model_config as any)[id] = {
        preferred_endpoints: [String(provider)],
        param_size: m.param_size,
        ...(m.reasoning_family ? { reasoning_family: m.reasoning_family } : {}),
      };
    }
    return true;
  }
  // remove
  const ids = Object.keys(cfg.model_config ?? {});
  if (ids.length === 0) { p.note('no models', 'models'); return false; }
  const sel = await p.multiselect({
    message: 'Remove which models?',
    options: ids.map((x) => ({ value: x, label: x })),
    required: true,
  });
  if (isCancel(sel)) abort();
  for (const id of sel as string[]) delete (cfg.model_config as any)[id];
  return true;
}

async function editDefaultModel(cfg: BrickConfig): Promise<boolean> {
  const ids = Object.keys(cfg.model_config ?? {});
  if (ids.length === 0) { p.note('no models configured', 'default_model'); return false; }
  const sel = await p.select({
    message: 'Default model:',
    options: ids.map((x) => ({ value: x, label: x, hint: x === cfg.default_model ? 'current' : undefined })),
    initialValue: cfg.default_model,
  });
  if (isCancel(sel)) abort();
  if (sel === cfg.default_model) return false;
  cfg.default_model = String(sel);
  return true;
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

async function editSkillRouter(cfg: BrickConfig): Promise<boolean> {
  if (!cfg.skill_router) {
    p.note('skill_router is not configured. Run `brick init` or edit YAML with `brick config ai` to add model skill vectors.', 'skill_router');
    return false;
  }
  const action = await p.select({
    message: 'Skill router:',
    options: [
      { value: 'list', label: `View models (${cfg.skill_router.models.length})` },
      { value: 'toggle', label: cfg.skill_router.enabled ? 'Disable' : 'Enable' },
      { value: 'back', label: '← back' },
    ],
  });
  if (isCancel(action)) abort();
  if (action === 'back') return false;
  if (action === 'list') {
    p.note(
      cfg.skill_router.models.map((m) => `${m.model} · [${m.skill_vector.map((v) => v.toFixed(3)).join(', ')}]`).join('\n') || '(none)',
      'skill_router'
    );
    return false;
  }
  cfg.skill_router.enabled = !cfg.skill_router.enabled;
  return true;
}

async function editClassifier(cfg: BrickConfig): Promise<boolean> {
  const enable = await p.confirm({ message: 'Enable ModernBERT domain classifier?', initialValue: !!cfg.classifier });
  if (isCancel(enable)) abort();
  if (!enable) {
    if (!cfg.classifier) return false;
    cfg.classifier = undefined as any;
    return true;
  }
  const threshold = await p.text({
    message: 'Classifier threshold (0.0–1.0):',
    defaultValue: String(cfg.classifier?.category_model.threshold ?? 0.45),
    validate: (s) => { const n = Number(s); return !Number.isNaN(n) && n >= 0 && n <= 1 ? undefined : 'must be 0.0–1.0'; },
  });
  if (isCancel(threshold)) abort();
  const cpu = await p.confirm({ message: 'Run on CPU?', initialValue: cfg.classifier?.category_model.use_cpu ?? true });
  if (isCancel(cpu)) abort();
  cfg.classifier = {
    category_model: {
      model_id: 'models/mom-domain-classifier',
      use_modernbert: true,
      threshold: Number(threshold),
      use_cpu: !!cpu,
      category_mapping_path: 'models/mom-domain-classifier/category_mapping.json',
    },
  };
  return true;
}

async function editComplexity(cfg: BrickConfig): Promise<boolean> {
  const mode = await p.select({
    message: 'Complexity classifier:',
    options: [
      { value: 'local', label: 'Local (Docker sidecar)', hint: 'bundled classifier container (brick claude on)' },
      { value: 'remote', label: 'Remote (OpenAI-compatible API)', hint: 'custom /v1/chat/completions endpoint' },
      { value: 'off', label: 'Disable', hint: 'no complexity signal' },
    ],
    initialValue: cfg.complexity_service?.enabled
      ? (cfg.complexity_service?.protocol === 'openai' ? 'remote' : 'local')
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
    const modelName = await p.text({ message: 'Model name (sent to the API):', defaultValue: cfg.complexity_service?.model_name ?? 'brick-complexity' });
    if (isCancel(modelName)) abort();
    const token = await p.password({ message: 'Bearer token (blank to keep current / skip):' });
    if (isCancel(token)) abort();
    const keepToken = cfg.complexity_service?.bearer_token;
    cfg.complexity_service = {
      enabled: true,
      protocol: 'openai',
      base_url: String(baseUrl).trim(),
      model_name: String(modelName || 'brick-complexity').trim(),
      ...(token ? { bearer_token: String(token) } : (keepToken ? { bearer_token: keepToken } : {})),
      timeout_seconds: 8,
      auto_spawn: false,
    };
  } else {
    // Local Docker sidecar reached via the compose service DNS name.
    cfg.complexity_service = {
      enabled: true,
      base_url: 'http://classifier:8094',
      bearer_token: '${BRICK_CLASSIFIER_TOKEN}',
      timeout_seconds: 8,
      auto_spawn: false,
    };
  }
  if (cfg.skill_router) {
    cfg.skill_router.complexity_model.base_url = cfg.complexity_service.base_url;
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

async function editReasoningEffort(cfg: BrickConfig): Promise<boolean> {
  const sel = await p.select({
    message: 'Default reasoning effort:',
    options: [
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' },
    ],
    initialValue: cfg.default_reasoning_effort,
  });
  if (isCancel(sel)) abort();
  if (sel === cfg.default_reasoning_effort) return false;
  cfg.default_reasoning_effort = sel as 'low' | 'medium' | 'high';
  return true;
}

async function editDecisions(cfg: BrickConfig): Promise<boolean> {
  const action = await p.select({
    message: 'Decisions:',
    options: [
      { value: 'list', label: `View list (${cfg.decisions.length})` },
      { value: 'add', label: 'Add decision (interactive builder)' },
      { value: 'remove', label: 'Remove decision' },
      { value: 'back', label: '← back' },
    ],
  });
  if (isCancel(action)) abort();
  if (action === 'back') return false;
  if (action === 'list') {
    p.note(
      cfg.decisions.map((d) => `${d.name} → ${d.modelRefs.map((r: any) => r.model + (r.use_reasoning ? `*` : '')).join(',')}`).join('\n') || '(none)',
      'decisions'
    );
    return false;
  }
  if (action === 'add') {
    const newOnes = await runDecisionBuilder(Object.keys(cfg.model_config ?? {}));
    if (newOnes.length === 0) return false;
    cfg.decisions = [...cfg.decisions, ...newOnes];
    return true;
  }
  if (cfg.decisions.length === 0) { p.note('no decisions to remove', 'decisions'); return false; }
  const sel = await p.multiselect({
    message: 'Remove which decisions?',
    options: cfg.decisions.map((d) => ({ value: d.name, label: d.name })),
    required: true,
  });
  if (isCancel(sel)) abort();
  const removeSet = new Set(sel as string[]);
  cfg.decisions = cfg.decisions.filter((d) => !removeSet.has(d.name));
  return true;
}

async function editPlugins(cfg: BrickConfig): Promise<boolean> {
  const known = ['pii_detection', 'jailbreak_guard', 'semantic_cache', 'prompt_guard'];
  const initial = known.filter((k) => cfg.plugins?.[k]?.enabled);
  const sel = await p.multiselect({
    message: 'Enable plugins:',
    options: known.map((k) => ({ value: k, label: k.replace(/_/g, ' '), hint: cfg.plugins?.[k]?.action ? `action=${cfg.plugins[k]!.action}` : undefined })),
    initialValues: initial,
    required: false,
  });
  if (isCancel(sel)) abort();
  const enabled = new Set(sel as string[]);
  const oldEnabled = new Set(initial);
  let changed = false;
  cfg.plugins ??= {} as any;
  for (const k of known) {
    if (enabled.has(k) && !oldEnabled.has(k)) {
      const action = await p.text({ message: `Action for ${k}:`, defaultValue: 'block' });
      if (isCancel(action)) abort();
      (cfg.plugins as any)[k] = { enabled: true, action: String(action) };
      changed = true;
    } else if (!enabled.has(k) && oldEnabled.has(k)) {
      delete (cfg.plugins as any)[k];
      changed = true;
    }
  }
  return changed;
}
