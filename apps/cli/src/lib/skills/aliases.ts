/**
 * Regolo serves some models under ids that differ from the canonical ids used
 * by the published skill table (Hugging Face `regolo/brick-skill-tables`).
 * Without these aliases the exact-match lookup in `syncSkillCards` silently
 * drops those models from the routing pool at every `brick start`.
 *
 * Keys are lowercase Regolo API ids; values are the canonical skill-table ids.
 */
export const SKILL_MODEL_ALIASES: Record<string, string> = {
  'qwen3.5-122b': 'qwen3.5-122b-a10b',
  'glm5.2': 'glm-5.2',
  'gemma4-31b': 'gemma-4-31b',
  'mistral-small-4-119b': 'mistral-small-4',
  // The published table should list these Codex tiers directly; exact matches
  // win when present. The 6.2 rows are currently sparse estimates from the
  // benchmark feeds (several dimensions are neutral 0.5), so keep the same-tier
  // alias as a fallback for a table that has not caught up yet.
  'gpt-6.1-terra': 'gpt-5.6-terra',
  'gpt-6-luna': 'gpt-5.6-luna',
  'gpt-6.2-sol': 'gpt-6.1-sol',
  'gpt-6.2-astra': 'gpt-6-astra',
};

export function skillModelCandidates(model: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const id = value.trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    candidates.push(id);
  };
  push(model);
  const alias = SKILL_MODEL_ALIASES[model.trim().toLowerCase()];
  if (alias) push(alias);
  return candidates;
}

/**
 * Resolve a model id against the skill table: exact match first, then the
 * Regolo→canonical alias, then a case-insensitive match for provider-cased ids
 * (for example `Llama-3.3-70B-Instruct`). The returned record keeps its
 * canonical `model` id; callers keep the requested id as the routing key.
 */
export function resolveSkillRecord<T extends { model: string }>(table: Map<string, T>, model: string): T | undefined {
  for (const candidate of skillModelCandidates(model)) {
    const hit = table.get(candidate);
    if (hit) return hit;
  }
  const lower = model.trim().toLowerCase();
  for (const [id, record] of table) if (id.toLowerCase() === lower) return record;
  return undefined;
}
