// Core of `brick skills extract`: run the frozen probe set against an
// OpenAI-compatible endpoint, grade the verifiable categories, smooth with the
// probe-scale prior, map onto the paper skill scale via the known-model
// anchors, and return a measured skill record.
import { loadProbeSet, probeAccuracyToSkill, smoothedAccuracy, type ProbeSet } from './probe.js';
import { lookupSkillRecord, type SkillTableRecord } from './table.js';

export interface ExtractOptions {
  model: string;
  baseUrl: string;
  apiKey?: string;
  concurrency?: number;
  /** Limit questions per category (debug/cost cap). */
  limit?: number;
  onProgress?: (done: number, total: number, category: string) => void;
}

export interface CategoryResult {
  category: string;
  correct: number;
  total: number;
  probeAccuracy: number;
  smoothedAccuracy: number;
  skill: number;
}

export interface ExtractResult {
  model: string;
  subsetHash: string;
  categories: CategoryResult[];
  /** Full 6D vector: measured coords from the probe, others from the public
   * table (benchmark) or heuristic baseline. */
  skillVector: number[];
  capabilities: string[];
  /** Per-coordinate provenance: measured | benchmark | heuristic. */
  coordSources: string[];
  record: SkillTableRecord;
}

async function callModel(opts: ExtractOptions, query: string): Promise<string> {
  const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        {
          role: 'system',
          content:
            'Answer the question. End your reply with a line of the form "Final Answer: <answer>". For multiple-choice questions answer with the letter only.',
        },
        { role: 'user', content: query },
      ],
      temperature: 0,
      max_tokens: 4096,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} from ${opts.baseUrl}: ${body.slice(0, 200)}`);
  }
  const data: any = await res.json();
  return String(data?.choices?.[0]?.message?.content ?? '');
}

async function pool<T, R>(items: T[], n: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, n) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function extractSkills(opts: ExtractOptions): Promise<ExtractResult> {
  const probe: ProbeSet = loadProbeSet();
  const { gradeAnswer } = await import('./grade.js');

  // group questions per category, honoring the optional per-category limit
  const byCat = new Map<string, typeof probe.questions>();
  for (const q of probe.questions) {
    const arr = byCat.get(q.category) ?? [];
    if (!opts.limit || arr.length < opts.limit) arr.push(q);
    byCat.set(q.category, arr);
  }

  const categories: CategoryResult[] = [];
  for (const [category, questions] of byCat) {
    const catMeta = probe.meta.categories[category];
    let done = 0;
    const results = await pool(questions, opts.concurrency ?? 4, async (q) => {
      let correct = false;
      try {
        const response = await callModel(opts, q.query);
        correct = gradeAnswer(q.protocol, q.expected_answer, response).correct;
      } catch {
        // API errors count as incorrect (consistent with the paper: none/error = wrong)
      }
      done++;
      opts.onProgress?.(done, questions.length, category);
      return correct;
    });
    const nCorrect = results.filter(Boolean).length;
    const probeAcc = nCorrect / questions.length;
    const smoothed = smoothedAccuracy(nCorrect, questions.length, catMeta.probe_prior_mu, probe.meta.prior_strength);
    const skill = probeAccuracyToSkill(smoothed, catMeta.anchors);
    categories.push({
      category,
      correct: nCorrect,
      total: questions.length,
      probeAccuracy: probeAcc,
      smoothedAccuracy: smoothed,
      skill,
    });
  }

  // assemble the full 6D vector: measured coords override, the rest comes from
  // the public table or a neutral heuristic baseline.
  const caps = probe.meta.capabilities;
  const published = lookupSkillRecord(opts.model);
  const measured = new Map(categories.map((c) => [c.category, c.skill]));
  const skillVector: number[] = [];
  const coordSources: string[] = [];
  for (const cap of caps) {
    if (measured.has(cap)) {
      skillVector.push(Number(measured.get(cap)!.toFixed(6)));
      coordSources.push('measured');
    } else if (published) {
      skillVector.push(published.skill_vector[caps.indexOf(cap)]);
      coordSources.push(published.source);
    } else {
      skillVector.push(0.6); // neutral mid baseline, flagged heuristic
      coordSources.push('heuristic');
    }
  }

  const support: Record<string, { correct: number; total: number }> = {};
  for (const c of categories) support[c.category] = { correct: c.correct, total: c.total };

  const record: SkillTableRecord = {
    model: opts.model,
    capabilities: caps,
    skill_vector: skillVector,
    source: 'measured',
    confidence: coordSources.map((s) => (s === 'measured' ? 'high' : 'low')),
    imputed_capabilities: caps.filter((c) => !measured.has(c)),
    support,
    subset_hash: probe.meta.subset_hash,
    date: new Date().toISOString().slice(0, 10),
    notes: `Measured with brick skills extract on the frozen probe set (${probe.meta.subset_hash}); non-measured coordinates inherited (${published ? published.source : 'heuristic'}).`,
  };

  return {
    model: opts.model,
    subsetHash: probe.meta.subset_hash,
    categories,
    skillVector,
    capabilities: caps,
    coordSources,
    record,
  };
}
