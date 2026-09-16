export const SKILL_CAPABILITIES = [
  'coding', 'creative_synthesis', 'instruction_following',
  'math_reasoning', 'planning_agentic', 'world_knowledge',
] as const;
export const SKILL_TABLE_HEADER = ['model', ...SKILL_CAPABILITIES] as const;
export interface SkillTableRecord { model: string; skill_vector: number[]; }

/** Parse the complete published table. Any malformed row invalidates the table. */
export function parseSkillTableCsv(input: string): Map<string, SkillTableRecord> {
  const lines = input.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length < 2) throw new Error('skill table contains no records');
  const header = lines[0].split(',');
  if (header.length !== SKILL_TABLE_HEADER.length || header.some((value, i) => value !== SKILL_TABLE_HEADER[i]))
    throw new Error(`invalid skill table header (expected ${SKILL_TABLE_HEADER.join(',')})`);
  const records = new Map<string, SkillTableRecord>();
  for (let row = 1; row < lines.length; row++) {
    const fields = lines[row].split(',');
    if (fields.length !== SKILL_TABLE_HEADER.length) throw new Error(`invalid skill table row ${row + 1}`);
    const model = fields[0].trim();
    if (!model) throw new Error(`empty model id at row ${row + 1}`);
    if (records.has(model)) throw new Error(`duplicate model id '${model}'`);
    const skill_vector = fields.slice(1).map((field) => Number(field.trim()));
    if (skill_vector.some((value) => !Number.isFinite(value) || value <= 0 || value >= 1))
      throw new Error(`invalid skill vector for '${model}' (values must be finite and strictly between 0 and 1)`);
    records.set(model, { model, skill_vector });
  }
  return records;
}
