import { describe, expect, it } from 'vitest';
import { parseSkillTableCsv, SKILL_TABLE_HEADER } from './table.js';

const header = SKILL_TABLE_HEADER.join(',');
const row = 'Model-A,0.1,0.2,0.3,0.4,0.5,0.6';
describe('skill table CSV validation', () => {
  it('accepts BOM and CRLF', () => expect(parseSkillTableCsv(`\uFEFF${header}\r\n${row}\r\n`).get('Model-A')?.skill_vector).toHaveLength(6));
  it('accepts a model id with unquoted commas', () => {
    const got = parseSkillTableCsv(`${header}\nclaude-fable-5-(adaptive-reasoning,-max-effort,-opus-4.8-fallback),0.5,0.5,0.5,0.5,0.45,0.5`);
    expect(got.get('claude-fable-5-(adaptive-reasoning,-max-effort,-opus-4.8-fallback)')?.skill_vector).toEqual([0.5, 0.5, 0.5, 0.5, 0.45, 0.5]);
  });
  it('accepts a quoted model id with commas', () => {
    const got = parseSkillTableCsv(`${header}\n"Model-A,variant",0.1,0.2,0.3,0.4,0.5,0.6`);
    expect(got.get('Model-A,variant')?.skill_vector).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
  });
  it.each([
    ['reordered header', `model,creative_synthesis,coding,instruction_following,math_reasoning,planning_agentic,world_knowledge\n${row}`],
    ['extra header', `${header},extra\n${row},x`],
    ['duplicate id', `${header}\n${row}\n${row}`],
    ['incomplete row', `${header}\nModel-A,0.1`],
    ['NaN', `${header}\nModel-A,NaN,0.2,0.3,0.4,0.5,0.6`],
    ['zero', `${header}\nModel-A,0,0.2,0.3,0.4,0.5,0.6`],
    ['one', `${header}\nModel-A,1,0.2,0.3,0.4,0.5,0.6`],
    ['out of range', `${header}\nModel-A,-0.1,0.2,0.3,0.4,0.5,0.6`],
  ])('rejects %s', (_name, csv) => expect(() => parseSkillTableCsv(csv)).toThrow());
});
