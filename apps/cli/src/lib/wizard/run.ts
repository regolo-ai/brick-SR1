import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { discoverModels } from '../catalog/discovery.js';
import { catalog,reasoningFamiliesDefault } from '../catalog/index.js';
import { resolveModelTransport } from '../catalog/transport.js';
import { saveCredential, validateProfileCredentials } from '../config/credentials.js';
import { paths } from '../config/paths.js';
import { saveConfig } from '../config/save.js';
import { ConfigSchema,type BrickConfig } from '../config/schema.js';
import { resolveSkillCards } from '../skills/resolver.js';
import { SYSTEMONE_CAPABILITIES, skillVectorInOrder } from '../skills/table.js';
import * as p from '../ui/prompts.js';

export async function runWizard(profile: string): Promise<BrickConfig> {
  const pp = paths(profile);
  p.intro(`brick — guided init (profile: ${profile})`);

  const enabledProvidersRaw = await p.multiselect({
    message: 'Which providers do you want to enable?',
    options: [
      { value: 'regolo', label: 'Regolo AI (default)', hint: 'api.regolo.ai' },
      { value: 'openai', label: 'OpenAI', hint: 'api.openai.com' },
      { value: 'local', label: 'Local OpenAI-compatible', hint: 'custom endpoint' },
    ],
    initialValues: ['regolo'],
    required: true,
  });
  if (p.isCancel(enabledProvidersRaw)) { p.cancel('aborted'); process.exit(0); }
  const enabledProviderTypes = enabledProvidersRaw as string[];

  const apiKeys: Record<string, string> = {};
  const providers: Record<string, any> = {};
  const providerProfiles: Record<string, any> = {};
  const providerEndpoints: any[] = [];
  const modelConfig: Record<string, any> = {};
  let selectedModelIds: string[] = [];
  const providerKinds: Record<string, string> = {};

  // Provider type and endpoint ID are intentionally separate. A Regolo
  // endpoint defaults to `regolo`, but `regolo-pool-models` is equally valid.
  for (const kind of enabledProviderTypes) {
    const pid = await promptProviderId(kind, providers);
    providerKinds[pid] = kind;
    await ensureProviderAuth(kind, pid, pp, apiKeys, providers, providerProfiles, providerEndpoints);
    await selectProviderModels(kind, pid, providers[pid].base_url, pp.env, modelConfig, selectedModelIds);
  }

  // loop-back: let the user keep adding models, returning to the provider list.
  // The list shows ALL providers (even already-configured ones) so more models
  // can be added to a provider that was already set up.
  for (;;) {
    const more = await p.confirm({ message: 'Add other models?', initialValue: false });
    if (p.isCancel(more)) { p.cancel('aborted'); process.exit(0); }
    if (!more) break;
    const pick = await p.select({
      message: 'Provider endpoint to configure:',
      options: [
        ...providerEndpoints.map((endpoint) => ({
          value: `existing:${endpoint.name}`,
          label: endpoint.name,
          hint: providers[endpoint.provider_profile]?.base_url,
        })),
        ...Object.keys(catalog).map((id) => ({ value: `new:${id}`, label: `Add ${catalog[id].label} endpoint` })),
      ],
    });
    if (p.isCancel(pick)) { p.cancel('aborted'); process.exit(0); }
    const [mode, value] = String(pick).split(':', 2);
    const pid = mode === 'existing' ? value : await promptProviderId(value, providers);
    const kind = mode === 'existing' ? providerKinds[pid] : value;
    providerKinds[pid] = kind;
    await ensureProviderAuth(kind, pid, pp, apiKeys, providers, providerProfiles, providerEndpoints);
    await selectProviderModels(kind, pid, providers[pid].base_url, pp.env, modelConfig, selectedModelIds);
  }

  const defaultModelChoice = await p.select({
    message: 'Default model (used for fixed routing):',
    options: selectedModelIds.map((id) => ({ value: id, label: id })),
  });
  if (p.isCancel(defaultModelChoice)) { p.cancel('aborted'); process.exit(0); }
  const defaultModel = String(defaultModelChoice);

  p.note('Queries are encoded locally by SystemOne; generation uses the selected provider.', 'routing');
  const knobValue = await p.text({ message: 'Routing knob (-1 to +1):', defaultValue: '0',
    validate: (text) => text.trim() && Number.isFinite(Number(text)) && Number(text) >= -1 && Number(text) <= 1 ? undefined : 'Enter a number between -1 and +1' });
  if (p.isCancel(knobValue)) { p.cancel('aborted'); process.exit(0); }
  const knob = Number(knobValue);
  const modelRouting = await p.confirm({ message: 'Enable model routing?', initialValue: true });
  if (p.isCancel(modelRouting)) { p.cancel('aborted'); process.exit(0); }
  // Multimodal — always on. Per-model native capability flags decide which
  // models receive raw image/audio directly; the brick block below stays as the
  // OCR/STT/vision FALLBACK for models that handle neither.
  const imageCapable = await p.multiselect({
    message: 'Which models handle IMAGES natively? (raw image passed through, no OCR) — space to toggle, enter to confirm',
    options: selectedModelIds.map((id) => ({ value: id, label: id })),
    required: false,
  });
  if (p.isCancel(imageCapable)) { p.cancel('aborted'); process.exit(0); }
  const audioCapable = await p.multiselect({
    message: 'Which models handle AUDIO natively? (raw audio passed through, no STT) — space to toggle, enter to confirm',
    options: selectedModelIds.map((id) => ({ value: id, label: id })),
    required: false,
  });
  if (p.isCancel(audioCapable)) { p.cancel('aborted'); process.exit(0); }
  const caps: Record<string, { images?: boolean; audio?: boolean }> = {};
  for (const id of imageCapable as string[]) caps[id] = { ...caps[id], images: true };
  for (const id of audioCapable as string[]) caps[id] = { ...caps[id], audio: true };

  const primaryProviderKind = Object.values(providerKinds).includes('regolo') ? 'regolo' : Object.values(providerKinds)[0];
  const mm = catalog[primaryProviderKind].multimodal;
  const brick = {
    enabled: true,
    use_model_routing: Boolean(modelRouting),
    stt_model: mm.stt?.model ?? 'faster-whisper-large-v3',
    stt_endpoint: mm.stt?.endpoint ?? 'https://api.regolo.ai/v1/audio/transcriptions',
    ocr_model: mm.ocr?.model ?? 'deepseek-ocr-2',
    ocr_endpoint: mm.ocr?.endpoint ?? 'https://api.regolo.ai/v1/chat/completions',
    vision_model: mm.vision?.model ?? 'qwen3.5-122b',
    vision_endpoint: mm.vision?.endpoint ?? 'https://api.regolo.ai/v1/chat/completions',
    ocr_min_text_length: 10,
  };

  const skillRouter = await buildSkillRouter(
    selectedModelIds, knob, caps,
    modelConfig, providerProfiles, providerEndpoints,
  );
  if (!skillRouter.models.length) {
    throw new Error('No selected model has a skill-card. Run the evaluation skill-profile export workflow and retry.');
  }
  const poolIds = skillRouter.models.map((m: any) => m.model);
  const effectiveDefaultModel = poolIds.includes(defaultModel) ? defaultModel : poolIds[0];

  // assemble
  const reasoningFamilies: Record<string, any> = {};
  for (const id of selectedModelIds) {
    const fam = modelConfig[id]?.reasoning_family;
    if (fam && (reasoningFamiliesDefault as any)[fam]) {
      reasoningFamilies[fam] = (reasoningFamiliesDefault as any)[fam];
    }
  }

  const cfg: BrickConfig = ConfigSchema.parse({
    config_version: 2,
    providers,
    brick,
    server_port: 8000,
    auto_model_name: 'brick',
    provider_profiles: providerProfiles,
    provider_endpoints: providerEndpoints,
    default_model: effectiveDefaultModel,
    model_config: modelConfig,
    reasoning_families: reasoningFamilies,
    skill_router: skillRouter,
  });

  await validateProfileCredentials(profile, cfg, apiKeys);

  // summary
  const skillLines = skillRouter.models.map(
    (m: any) => `  ${m.model}: remote skill table`
  );
  p.note(
    [
      `providers: ${Object.keys(providers).join(', ')}`,
      `models: ${selectedModelIds.join(', ')}`,
      `default_model: ${defaultModel}`,
      `routing knob: ${knob}`,
      `skill sources:`,
      ...skillLines,
      `multimodal: on (passthrough per-model; OCR/STT/vision fallback)`,
      `  native image: ${(imageCapable as string[]).join(', ') || 'none'}`,
      `  native audio: ${(audioCapable as string[]).join(', ') || 'none'}`,
    ].join('\n'),
    'summary'
  );

  const ok = await p.confirm({ message: `Write config to ${pp.config}?`, initialValue: true });
  if (p.isCancel(ok) || !ok) { p.cancel('aborted'); process.exit(0); }

  await saveConfig(cfg, profile);
  await writeEnvFile(apiKeys, pp.env);
  p.outro(`done. config=${pp.config} env=${pp.env}`);
  return cfg;
}

async function buildSkillRouter(
  modelIds: string[], knob = 0,
  caps: Record<string, { images?: boolean; audio?: boolean }> = {},
  modelConfig: Record<string, any> = {}, providerProfiles: Record<string, any> = {},
  providerEndpoints: Array<{ name: string; provider_profile: string }> = [],
): Promise<any> {
  const cards = await resolveSkillCards(modelIds);
  const models = modelIds.filter((id) => cards.has(id)).map((id) => {
    const transport = resolveModelTransport(id, modelConfig, providerProfiles, providerEndpoints);
    return {
      model: id, skill_vector: skillVectorInOrder(cards.get(id)!, SYSTEMONE_CAPABILITIES),
      ...(transport?.baseUrl ? { base_url: transport.baseUrl } : {}),
      ...(transport?.apiKeyEnv ? { api_key_env: transport.apiKeyEnv } : {}),
      ...(caps[id]?.images ? { handles_images: true } : {}),
      ...(caps[id]?.audio ? { handles_audio: true } : {}),
    };
  });
  if (models.length !== modelIds.length) p.note(`${modelIds.length - models.length} model(s) excluded because they are absent from the skill table.`, 'skill table');
  return { enabled: true, knob, capabilities: [...SYSTEMONE_CAPABILITIES], systemone: { local_path: 'models/systemone' }, models };
}

async function ensureProviderAuth(
  kind: string,
  pid: string,
  pp: ReturnType<typeof paths>,
  apiKeys: Record<string, string>,
  providers: Record<string, any>,
  providerProfiles: Record<string, any>,
  providerEndpoints: any[]
): Promise<void> {
  if (providers[pid]) return;
  const cat = catalog[kind];
  let baseUrl = cat.base_url;
  if (kind === 'local') {
    const u = await p.text({ message: 'Local endpoint base_url:', placeholder: cat.base_url, defaultValue: cat.base_url });
    if (p.isCancel(u)) { p.cancel('aborted'); process.exit(0); }
    baseUrl = String(u || cat.base_url);
  }
  const existing = await readEnvKey(cat.env_key, pp.env);
  let key: string;
  if (existing) {
    key = existing;
  } else {
    const k = await p.password({ message: `${cat.label} API key (will be saved to ~/.brick/.env, not in YAML):` });
    if (p.isCancel(k)) { p.cancel('aborted'); process.exit(0); }
    key = String(k);
  }
  apiKeys[cat.env_key] = key;
  // Persist credentials as soon as the endpoint is accepted. A later wizard
  // cancellation must not leave an apparently configured provider with a lost
  // key, and unrelated .env entries are preserved.
  if (!existing) await saveCredential(pp.profile, cat.env_key, key, baseUrl, /anthropic/i.test(kind) ? 'anthropic' : 'openai');
  providers[pid] = { base_url: baseUrl };
  providerProfiles[pid] = { type: 'openai_compatible', base_url: baseUrl };
  providerEndpoints.push({ name: pid, provider_profile: pid, weight: 1 });
}

// Select models for a provider and merge them into modelConfig/selectedModelIds.
// Additive with dedup: ids already chosen are pre-selected and never duplicated.
async function selectProviderModels(
  kind: string,
  pid: string,
  baseUrl: string,
  envPath: string,
  modelConfig: Record<string, any>,
  selectedModelIds: string[]
): Promise<void> {
  const cat = catalog[kind];
  const add = (id: string, conf: any) => {
    modelConfig[id] = conf;
    if (!selectedModelIds.includes(id)) selectedModelIds.push(id);
  };
  let available = cat.models;
  try {
    const key = await readEnvKey(cat.env_key, envPath);
    const result = await discoverModels(pid, baseUrl, {
      ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
    });
    const discovered = result.models.map((m) => ({ id: m.id, label: m.id, param_size: '', reasoning_family: undefined }));
    const cards = await resolveSkillCards(discovered.map((m) => m.id));
    const excluded = discovered.filter((m) => !cards.has(m.id));
    available = discovered.filter((m) => cards.has(m.id));
    p.note(
      [
        'Skill-card precheck: only models with a direct card in the bundled tables, local cache, or the public Hugging Face dataset are shown.',
        excluded.length
          ? `${excluded.length} Regolo model(s) are hidden because Brick could not find a matching card.`
          : 'Every discovered Regolo model has a matching skill-card.',
        "If you don't see your model, it is not covered by the skill cards yet. Choose a covered model or export its evaluated skill profile before creating a profile.",
      ].join('\n'),
      `${cat.label} model eligibility`,
    );
    if (result.source === 'cache') p.note(`${pid} /models unavailable; using the local model catalog cache.`, 'models');
  } catch (error: any) {
    p.note(
      `${error?.message ?? error}\n${available.length ? 'Using the bundled compatibility catalog for onboarding.' : 'No cache or bundled catalog is available; enter model IDs manually.'}`,
      'model discovery',
    );
  }
  if (available.length === 0) {
    const ids = await p.text({ message: `Comma-separated model IDs for ${cat.label}:`, placeholder: 'mistral,llama3' });
    if (p.isCancel(ids)) { p.cancel('aborted'); process.exit(0); }
    const list = String(ids).split(',').map((s) => s.trim()).filter(Boolean);
    for (const id of list) add(id, { preferred_endpoints: [pid] });
  } else {
    const sel = await p.multiselect({
      message: `Select models for ${cat.label}:`,
        options: available.map((m) => ({ value: m.id, label: m.param_size ? `${m.label} (${m.param_size})` : m.label, hint: m.reasoning_family })),
        initialValues: available.map((m) => m.id).filter((id) => selectedModelIds.includes(id)),
      required: true,
    });
    if (p.isCancel(sel)) { p.cancel('aborted'); process.exit(0); }
    for (const id of sel as string[]) {
      const m = available.find((x) => x.id === id)!;
      add(id, {
        preferred_endpoints: [pid],
        ...(m.reasoning_family ? { reasoning_family: m.reasoning_family } : {}),
      });
    }
  }
}

async function promptProviderId(kind: string, existing: Record<string, any>): Promise<string> {
  const value = await p.text({
    message: `${catalog[kind].label} provider ID:`,
    defaultValue: kind,
    placeholder: kind === 'regolo' ? 'regolo-pool-models' : kind,
    validate: (raw) => {
      const id = raw.trim();
      if (!/^[A-Za-z0-9._-]+$/.test(id)) return 'use letters, digits, dot, - or _';
      if (existing[id]) return `provider ID '${id}' already exists`;
    },
  });
  if (p.isCancel(value)) { p.cancel('aborted'); process.exit(0); }
  return String(value).trim();
}

async function readEnvKey(envKey: string, envPath?: string): Promise<string | null> {
  const target = envPath;
  try {
    if (target) {
      const txt = await readFile(target, 'utf8');
      const m = txt.match(new RegExp(`^${envKey}=(.+)$`, 'm'));
      if (m) return m[1].trim();
    }
  } catch {}
  return process.env[envKey] ?? null;
}

async function writeEnvFile(keys: Record<string, string>, envPath: string): Promise<void> {
  await mkdir(dirname(envPath), { recursive: true, mode: 0o700 });
  let existing = '';
  try {
    existing = await readFile(envPath, 'utf8');
  } catch {}
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(keys)) {
    lines.push(`${k}=${v}`);
    seen.add(k);
  }
  for (const line of existing.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (m && !seen.has(m[1])) lines.push(line);
  }
  await writeFile(envPath, lines.filter(Boolean).join('\n') + '\n', { mode: 0o600 });
}
