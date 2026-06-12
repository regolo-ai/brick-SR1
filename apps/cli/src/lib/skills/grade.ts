// Programmatic graders for the verifiable probe-set protocols. No LLM judge,
// no code execution: math final-answer equivalence and MCQ letter match only.

export interface GradeResult {
  correct: boolean;
  extracted: string | null;
}

/** Normalize a numeric/string final answer for comparison. */
function normalizeAnswer(s: string): string {
  let t = s.trim()
    .replace(/\\boxed\{([^}]*)\}/g, '$1')
    .replace(/[$,\s]/g, '')
    .replace(/\\!/g, '')
    .replace(/^\((.*)\)$/, '$1')
    .replace(/\.0+$/, '')
    .toLowerCase();
  // canonical numeric form when parseable
  const num = Number(t);
  if (t !== '' && Number.isFinite(num)) return String(num);
  return t;
}

/** Pull the model's final answer out of its raw response. */
export function extractFinalAnswer(response: string): string | null {
  // 1. explicit "Final Answer:" marker (we instruct models to emit it)
  const marker = response.match(/final\s*answer\s*[:\-]\s*(.+?)(?:\n|$)/i);
  if (marker) return marker[1].trim();
  // 2. last \boxed{...}
  const boxes = [...response.matchAll(/\\boxed\{([^}]*)\}/g)];
  if (boxes.length > 0) return boxes[boxes.length - 1][1].trim();
  // 3. last number in the response
  const nums = [...response.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)];
  if (nums.length > 0) return nums[nums.length - 1][0];
  return null;
}

/** Pull an MCQ letter (A-J) out of the model response. */
export function extractMcqLetter(response: string): string | null {
  const marker = response.match(/(?:final\s*answer|answer)\s*[:\-]?\s*\(?([A-J])\)?(?:\b|$)/i);
  if (marker) return marker[1].toUpperCase();
  // last standalone capital letter A-J
  const letters = [...response.matchAll(/\b([A-J])\b/g)];
  if (letters.length > 0) return letters[letters.length - 1][1].toUpperCase();
  return null;
}

export function gradeAnswer(protocol: string, expectedAnswerJson: string, response: string): GradeResult {
  let expected: any;
  try {
    expected = JSON.parse(expectedAnswerJson);
  } catch {
    return { correct: false, extracted: null };
  }
  const payload = expected?.payload ?? {};

  if (protocol === 'mcq_letter') {
    const want = String(payload.answer_letter ?? '').toUpperCase();
    const got = extractMcqLetter(response);
    return { correct: !!got && got === want, extracted: got };
  }

  // math_equiv / gsm8k_final_answer: compare normalized final answers
  const want = normalizeAnswer(String(payload.final_answer ?? ''));
  const got = extractFinalAnswer(response);
  if (got === null) return { correct: false, extracted: null };
  return { correct: normalizeAnswer(got) === want, extracted: got };
}
