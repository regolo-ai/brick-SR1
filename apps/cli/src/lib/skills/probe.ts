// Loader for the frozen skill-probe set bundled at templates/skill-probe-set.jsonl.
// First line is a metadata header (K per category, anchors for probe->skill
// mapping, subset hash); following lines are one question each.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = join(__dirname, '..', '..', '..', 'templates', 'skill-probe-set.jsonl');

export interface ProbeAnchor {
  model: string;
  probe_accuracy: number;
  paper_skill: number;
}

export interface ProbeCategoryMeta {
  k_discriminative: number;
  k_hard_anchor: number;
  n_total: number;
  ci_separated: boolean;
  global_prior_mu: number;
  probe_prior_mu: number;
  anchors: ProbeAnchor[];
}

export interface ProbeMeta {
  version: number;
  subset_hash: string;
  capabilities: string[];
  prior_strength: number;
  categories: Record<string, ProbeCategoryMeta>;
}

export interface ProbeQuestion {
  query_id: string;
  category: string;
  protocol: string;
  query: string;
  expected_answer: string; // JSON string {type, payload}
}

export interface ProbeSet {
  meta: ProbeMeta;
  questions: ProbeQuestion[];
}

export function loadProbeSet(): ProbeSet {
  if (!existsSync(PROBE_PATH)) {
    throw new Error(`probe set not found at ${PROBE_PATH}; run packages/evals/scripts/150_calibrate_probe_set.py`);
  }
  const lines = readFileSync(PROBE_PATH, 'utf8').split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]);
  if (!header._meta) throw new Error('probe set header missing (_meta)');
  const questions = lines.slice(1).map((l) => JSON.parse(l) as ProbeQuestion);
  return { meta: header as ProbeMeta, questions };
}

/**
 * Map a probe accuracy onto the paper skill scale via piecewise-linear
 * interpolation through the known-model anchors, clamped to [0.02, 0.98]
 * (the router's logit clipping range).
 */
export function probeAccuracyToSkill(acc: number, anchors: ProbeAnchor[]): number {
  const pts = [...anchors].sort((a, b) => a.probe_accuracy - b.probe_accuracy);
  let skill: number;
  if (acc <= pts[0].probe_accuracy) {
    // extrapolate toward 0 below the weakest anchor
    skill = pts[0].paper_skill * (acc / Math.max(pts[0].probe_accuracy, 1e-9));
  } else if (acc >= pts[pts.length - 1].probe_accuracy) {
    // extrapolate toward 1 above the strongest anchor
    const top = pts[pts.length - 1];
    const t = (acc - top.probe_accuracy) / Math.max(1 - top.probe_accuracy, 1e-9);
    skill = top.paper_skill + t * (1 - top.paper_skill);
  } else {
    skill = pts[0].paper_skill;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (acc >= a.probe_accuracy && acc <= b.probe_accuracy) {
        const t = (acc - a.probe_accuracy) / Math.max(b.probe_accuracy - a.probe_accuracy, 1e-9);
        skill = a.paper_skill + t * (b.paper_skill - a.paper_skill);
        break;
      }
    }
  }
  return Math.min(0.98, Math.max(0.02, skill));
}

/** Bayesian smoothed accuracy: (K + k*mu) / (N + k). */
export function smoothedAccuracy(correct: number, total: number, mu: number, priorStrength: number): number {
  return (correct + priorStrength * mu) / (total + priorStrength);
}
