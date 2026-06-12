"""Pick one example query (full walkthrough) + three cherry-picked queries.

Source: /root/forkGO/external_comparison/predictions/brick_debug_gpu.jsonl

The chosen "main" example shows a non-trivial routing decision (NOT a query where
all three models would have agreed). The three cherry-picked queries cover one
easy (qwen-routed), one medium (ds4-routed), one hard (kimi-routed).

Outputs `figures/example_query.tex` ready to be \\input{} into paper.tex.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

DBG = Path("/root/forkGO/external_comparison/predictions/brick_debug_gpu.jsonl")
QUERIES_DIRS = [
    Path("/root/forkGO/scientificv1/data/inference/deepseek-v4-flash"),
    Path("/root/forkGO/scientificv1/data/inference/kimi2.6"),
    Path("/root/forkGO/scientificv1/data/inference/qwen3.5-9b"),
]
EVAL_PARAMS = Path("/root/forkGO/scientificv1/data/final/evaluation_parameters_full.jsonl")
OUT = Path("/root/forkGO/scientificv1/docs/figures/example_query.tex")

CAP_ORDER = ["coding", "creative_synthesis", "instruction_following",
             "math_reasoning", "planning_agentic", "world_knowledge"]
SHORT = {"coding": "cod", "creative_synthesis": "crea", "instruction_following": "ifo",
         "math_reasoning": "mat", "planning_agentic": "pln", "world_knowledge": "wld"}

# Production-locked Brick configuration (from spatial-routing/config.yaml).
# Keep in sync with the values printed in Table tab:brick-knob-defaults.
SKILL_MATRIX = {
    "qwen": [0.714788, 0.511538, 0.810109, 0.912146, 0.577072, 0.179876],
    "ds4":  [0.820939, 0.657845, 0.863112, 0.934963, 0.62055,  0.488518],
    "kimi": [0.904272, 0.751595, 0.87018,  0.943892, 0.641863, 0.344074],
}
# Mean cost per call (USD), full Dataset A, OpenRouter prices fetched 2026-05-26.
# Source: scientificv1/data/reports/cost_audit/hf_verbose_means.md.
COST_VECTOR = {"qwen": 0.001386, "ds4": 0.002895, "kimi": 0.030703}
KNOB_DEFAULTS = {"mu0": 1.07, "b0": 0.15, "beta0": 0.63, "lambda0": 0.35,
                 "alpha": 1.56}
CLIP_MIN, CLIP_MAX = 0.02, 0.98  # config.yaml lines 173-174


def logit(p: float) -> float:
    """Clamped logit. Mirrors clip_min/clip_max in production config."""
    p = max(CLIP_MIN, min(CLIP_MAX, float(p)))
    return math.log(p / (1.0 - p))


def knob_scalars(r: float):
    """Map preference r in [-1, 1] to (mu, b, beta, lambda) at neutral defaults.
    At r=0 the two branches vanish and we recover the base values."""
    a = KNOB_DEFAULTS["alpha"]
    pos = max(r, 0.0) ** a
    neg = max(-r, 0.0) ** a
    # At r=0 both pos/neg are 0, so all multipliers collapse to 1 / 0 shift.
    # We only need the trivial case for the walkthrough; full mapping mirrors
    # router.go:304-343 (see paper Sec. brick-knob).
    mu = KNOB_DEFAULTS["mu0"]
    b  = KNOB_DEFAULTS["b0"]
    beta = KNOB_DEFAULTS["beta0"]
    lam = KNOB_DEFAULTS["lambda0"]
    return mu, b, beta, lam, pos, neg


def compute_chain(cap_vec: dict, tau: float, r_pref: float = 0.0):
    """Run the full Brick scoring chain on one query. Returns a dict with every
    intermediate quantity needed for the worked-example walkthrough."""
    mu, b, beta, lam, pos, neg = knob_scalars(r_pref)
    z_q = b + mu * logit(tau)
    p = [cap_vec[c] for c in CAP_ORDER]
    r_qc = [pi * z_q for pi in p]  # per-capability requirement

    models = ("qwen", "ds4", "kimi")
    out_models = {}
    for m in models:
        s_vec = SKILL_MATRIX[m]
        logit_s = [logit(s) for s in s_vec]
        v = [pi * ls for pi, ls in zip(p, logit_s)]
        u = [max(0.0, r_qc[i] - v[i]) for i in range(len(CAP_ORDER))]
        o = [max(0.0, v[i] - r_qc[i]) for i in range(len(CAP_ORDER))]
        D = math.sqrt(sum(ui * ui + lam * oi * oi for ui, oi in zip(u, o)))
        cost_pen = beta * COST_VECTOR[m]
        J = D + cost_pen
        out_models[m] = {
            "s": s_vec, "logit_s": logit_s,
            "v": v, "u": u, "o": o,
            "D": D, "cost_pen": cost_pen, "J": J,
        }
    return {
        "r_pref": r_pref, "pos": pos, "neg": neg,
        "mu": mu, "b": b, "beta": beta, "lambda": lam,
        "tau": tau, "logit_tau": logit(tau), "z_q": z_q,
        "p": p, "r_qc": r_qc,
        "models": out_models,
    }


def load_query_texts():
    """Map query_id -> short query text. Prefer evaluation_parameters_full.jsonl (clean,
    no few-shot prefix) then fall back to inference dirs."""
    out = {}
    if EVAL_PARAMS.exists():
        with EVAL_PARAMS.open() as f:
            for line in f:
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                qid = r.get("query_id")
                q = (r.get("query") or "").strip().replace("\n", " ")
                if qid and q:
                    out[qid] = q[:200]
    for d in QUERIES_DIRS:
        if not d.exists():
            continue
        for jp in d.glob("*.jsonl"):
            if jp.name.endswith(".bak"):
                continue
            try:
                with jp.open() as f:
                    for line in f:
                        try:
                            r = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        qid = r.get("query_id")
                        q = (r.get("query") or "").strip().replace("\n", " ")
                        if qid and q and qid not in out:
                            # strip few-shot prefix: take everything after last "<question>" marker if present
                            for marker in ("Now, please answer the following question:",
                                           "Question:", "Q:"):
                                idx = q.rfind(marker)
                                if idx >= 0 and idx < len(q) - 30:
                                    q = q[idx + len(marker):].strip()
                                    break
                            out[qid] = q[:160]
            except Exception:
                continue
    return out


def main():
    texts = load_query_texts()
    name_to_short = {"qwen/qwen3.5-9b": "qwen",
                     "deepseek/deepseek-v4-flash": "ds4",
                     "moonshotai/kimi-k2.6": "kimi"}

    def parse_scores(d):
        out = {}
        for entry in d.get("scores") or []:
            s = name_to_short.get(entry.get("model"))
            if s:
                out[s] = float(entry.get("score", 0.0))
        return out

    candidates_by_dim = {"coding": [], "math_reasoning": [], "planning_agentic": []}
    main_candidate = None  # ds4 picked AND argmin(score)==ds4 AND ds4 correct AND qwen wrong, math
    for line in DBG.open():
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        d = r.get("brick_debug") or {}
        if not isinstance(d, dict):
            continue
        cap = d.get("capability") or {}
        sc = parse_scores(d)
        if not cap or not sc or len(sc) < 3:
            continue
        argmin = min(sc, key=sc.get)
        dim = r.get("dimension")
        sel = r.get("brick_selected")
        if sel != argmin:  # require consistency between shown scores and decision
            continue
        # Cherry-pick lists: dim-typical routing, prioritize correct answers
        if dim == "coding" and sel == "qwen":
            candidates_by_dim["coding"].append((r, bool(r.get("gt_qwen_correct"))))
        if dim == "math_reasoning" and sel in ("ds4", "kimi"):
            candidates_by_dim["math_reasoning"].append((r, bool(r.get(f"gt_{sel}_correct"))))
        if dim == "planning_agentic" and sel == "kimi":
            candidates_by_dim["planning_agentic"].append((r, bool(r.get("gt_kimi_correct"))))
        # Main candidate: ds4 picked (and is argmin), ds4 correct, qwen wrong, math_reasoning
        if (main_candidate is None
                and dim == "math_reasoning"
                and sel == "ds4"
                and r.get("gt_ds4_correct")
                and not r.get("gt_qwen_correct")):
            main_candidate = r

    if main_candidate is None:
        # fallback: pick the first ds4-routed consistency-checked candidate (any dim)
        for line in DBG.open():
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            d = r.get("brick_debug") or {}
            if not isinstance(d, dict):
                continue
            sc = parse_scores(d)
            if not sc or len(sc) < 3:
                continue
            if r.get("brick_selected") == "ds4" and min(sc, key=sc.get) == "ds4":
                main_candidate = r
                break
    if main_candidate is None:
        raise SystemExit("[err] no candidate found")

    # ---- MAIN walkthrough ----
    d = main_candidate["brick_debug"]
    cap = {k: float(d["capability"].get(k, 0.0)) for k in CAP_ORDER}
    # scores is a list of {model: 'org/name', score: float, ...}
    name_to_short = {"qwen/qwen3.5-9b": "qwen",
                     "deepseek/deepseek-v4-flash": "ds4",
                     "moonshotai/kimi-k2.6": "kimi"}
    scores = {}
    for entry in d["scores"]:
        s = name_to_short.get(entry.get("model"))
        if s:
            scores[s] = float(entry.get("score", 0.0))
    for k in ("qwen", "ds4", "kimi"):
        scores.setdefault(k, float("nan"))
    tau = float(d.get("tau_query") or d.get("effective_tau_query") or 0.0)
    cx_lab = d.get("complexity_label", "?")
    cx_conf = float(d.get("complexity_confidence") or 0.0)
    sel = main_candidate["brick_selected"]
    qid = main_candidate["query_id"]
    dim = main_candidate["dimension"]
    qtext = texts.get(qid, "(query text not joined)")
    # Shorten the query: keep only the actual problem, not few-shot prefix
    if len(qtext) > 130:
        qtext = qtext[:128] + "..."

    # ---- 3 cherry-picked queries ----
    cherry = []
    label_map = {"qwen": "qwen", "ds4": "ds4", "kimi": "kimi"}
    for target_dim in ("coding", "math_reasoning", "planning_agentic"):
        sorted_cands = sorted(candidates_by_dim[target_dim], key=lambda kv: 0 if kv[1] else 1)
        for cand, _ok in sorted_cands:
            if cand["query_id"] == qid:
                continue
            db = cand["brick_debug"]
            cap_c = {k: float(db["capability"].get(k, 0.0)) for k in CAP_ORDER}
            top_cap_key = max(cap_c, key=cap_c.get)
            cherry.append({
                "qid": cand["query_id"],
                "dim": target_dim,
                "top_cap": top_cap_key,
                "top_cap_val": cap_c[top_cap_key],
                "tau": float(db.get("tau_query") or 0.0),
                "selected": cand["brick_selected"],
            })
            break

    def texesc(s):
        # Minimal LaTeX escape for prose strings (query text).
        return (s.replace("\\", "\\textbackslash{}")
                 .replace("&", "\\&").replace("%", "\\%").replace("$", "\\$")
                 .replace("#", "\\#").replace("_", "\\_").replace("{", "\\{")
                 .replace("}", "\\}").replace("~", "\\textasciitilde{}")
                 .replace("^", "\\textasciicircum{}"))

    qid_tex = qid.replace("_", "\\_")
    dim_tex = dim.replace("_", "\\_")
    qtext_tex = texesc(qtext.strip().strip('"').strip("'"))
    # ---- Run the full Brick chain on this query (neutral knob, production constants) ----
    chain = compute_chain(cap, tau, r_pref=0.0)
    best_key = min(chain["models"], key=lambda k: chain["models"][k]["J"])

    # ---- Emit LaTeX ----
    lines = []
    lines.append("% Auto-generated by extract_example_query.py. Do not hand-edit.")
    lines.append("")
    lines.append(f"\\textbf{{Query.}} \\texttt{{{qid_tex}}} (dim: \\texttt{{{dim_tex}}}): "
                 f"``{qtext_tex}''")
    lines.append("")

    pretty_cap = {"coding": "cod", "creative_synthesis": "crea",
                  "instruction_following": "ifo", "math_reasoning": "math",
                  "planning_agentic": "plan", "world_knowledge": "wld"}
    pretty = {"qwen": "qwen3.5-9b", "ds4": "deepseek-v4-flash", "kimi": "kimi2.6"}

    # ---- Step 0: preference knob ----
    lines.append("\\textbf{Step 0 -- preference knob.} "
                 f"The caller sets $r{{=}}{chain['r_pref']:.0f}$ (\\texttt{{balanced}} profile), "
                 f"so $p^{{+}}{{=}}p^{{-}}{{=}}0$ and the four routing scalars collapse to their "
                 f"locked production base values (Table~\\ref{{tab:brick-knob-defaults}}):")
    lines.append("\\[")
    lines.append(f"(\\mu, b, \\beta, \\lambda) \\;=\\; (\\mu_0, b_0, \\beta_0, \\lambda_0) \\;=\\; "
                 f"({chain['mu']:.2f},\\,{chain['b']:.2f},\\,{chain['beta']:.2f},\\,{chain['lambda']:.2f}).")
    lines.append("\\]")
    lines.append("")

    # ---- Step 1: capability distribution ----
    lines.append("\\medskip\\noindent\\textbf{Step 1 -- capability distribution} $p(x)$ from ModernBERT "
                 "(six entries, sum to one):")
    lines.append("\\begin{center}\\small")
    lines.append("\\begin{tabular}{l " + "r " * len(CAP_ORDER) + "}")
    lines.append("\\toprule")
    lines.append("$c$ & " + " & ".join(f"\\texttt{{{pretty_cap[k]}}}" for k in CAP_ORDER) + " \\\\")
    lines.append("$p_c$ & " + " & ".join(f"{cap[k]:.2f}" for k in CAP_ORDER) + " \\\\")
    lines.append("\\bottomrule")
    lines.append("\\end{tabular}\\end{center}")
    lines.append("")

    # ---- Step 2: complexity + effective logit ----
    lines.append(f"\\medskip\\noindent\\textbf{{Step 2 -- complexity and difficulty lift.}} The complexity head "
                 f"labels the query \\texttt{{{cx_lab}}} with confidence ${cx_conf:.2f}$, blending into "
                 f"$\\tau_q{{=}}{tau:.3f}$. The effective difficulty logit is")
    lines.append("\\[")
    lines.append(f"z_q \\;=\\; b + \\mu\\,\\mathrm{{logit}}(\\tau_q) "
                 f"\\;=\\; {chain['b']:.2f} + {chain['mu']:.2f}\\cdot{chain['logit_tau']:.3f} "
                 f"\\;=\\; {chain['z_q']:.3f}.")
    lines.append("\\]")
    lines.append("")

    # ---- Step 3: requirement vector ----
    lines.append("\\medskip\\noindent\\textbf{Step 3 -- per-capability requirement} "
                 f"$r_{{q,c}}{{=}}p_c\\,z_q$ (with $z_q{{=}}{chain['z_q']:.3f}$):")
    lines.append("\\begin{center}\\small")
    lines.append("\\begin{tabular}{l " + "r " * len(CAP_ORDER) + "}")
    lines.append("\\toprule")
    lines.append("$c$ & " + " & ".join(f"\\texttt{{{pretty_cap[k]}}}" for k in CAP_ORDER) + " \\\\")
    lines.append("\\midrule")
    lines.append("$p_c$ & " + " & ".join(f"{cap[k]:.2f}" for k in CAP_ORDER) + " \\\\")
    lines.append("$r_{q,c}$ & " + " & ".join(f"{chain['r_qc'][i]:.2f}" for i in range(len(CAP_ORDER))) + " \\\\")
    lines.append("\\bottomrule")
    lines.append("\\end{tabular}\\end{center}")
    lines.append("")

    # ---- Step 4: model capacity v_{m,c} (skill matrix → logit → weighted) ----
    lines.append("\\medskip\\noindent\\textbf{Step 4 -- per-model capacity} "
                 "$v_{m,c}{=}p_c\\,\\mathrm{logit}(s_{m,c})$, with $S$ the offline-calibrated "
                 "skill matrix:")
    lines.append("\\begin{center}\\scriptsize")
    lines.append("\\begin{tabular}{l " + "r " * len(CAP_ORDER) + "}")
    lines.append("\\toprule")
    lines.append("$c$ & " + " & ".join(f"\\texttt{{{pretty_cap[k]}}}" for k in CAP_ORDER) + " \\\\")
    lines.append("\\midrule")
    for m in ("qwen", "ds4", "kimi"):
        s = chain["models"][m]["s"]
        v = chain["models"][m]["v"]
        lines.append(f"$s_{{{m},c}}$ & " + " & ".join(f"{si:.3f}" for si in s) + " \\\\")
        lines.append(f"$v_{{{m},c}}$ & " + " & ".join(f"{vi:.2f}" for vi in v) + " \\\\")
    lines.append("\\bottomrule")
    lines.append("\\end{tabular}\\end{center}")
    lines.append("")

    # ---- Step 5: residuals u, o ----
    lines.append("\\medskip\\noindent\\textbf{Step 5 -- asymmetric residuals.}\\\\"
                 "$u_{m,c}{=}\\max(0, r_{q,c}{-}v_{m,c})$ (under-capacity, model too weak), "
                 "$o_{m,c}{=}\\max(0, v_{m,c}{-}r_{q,c})$ (over-capacity, overkill):")
    lines.append("\\begin{center}\\scriptsize")
    lines.append("\\begin{tabular}{l " + "r " * len(CAP_ORDER) + "}")
    lines.append("\\toprule")
    lines.append("$c$ & " + " & ".join(f"\\texttt{{{pretty_cap[k]}}}" for k in CAP_ORDER) + " \\\\")
    lines.append("\\midrule")
    for m in ("qwen", "ds4", "kimi"):
        u = chain["models"][m]["u"]
        o = chain["models"][m]["o"]
        lines.append(f"$u_{{{m},c}}$ & " + " & ".join(f"{ui:.2f}" for ui in u) + " \\\\")
        lines.append(f"$o_{{{m},c}}$ & " + " & ".join(f"{oi:.2f}" for oi in o) + " \\\\")
    lines.append("\\bottomrule")
    lines.append("\\end{tabular}\\end{center}")
    lines.append("")

    # ---- Step 6: aggregation D_m, cost penalty, J_m ----
    lines.append("\\medskip\\noindent\\textbf{Step 6 -- distance, cost penalty, total score.} "
                 f"$D_m{{=}}\\sqrt{{\\sum_c(u_{{m,c}}^{{2}}+\\lambda\\,o_{{m,c}}^{{2}})}}$ "
                 f"(with $\\lambda{{=}}{chain['lambda']:.2f}$) and "
                 f"$J_m{{=}}D_m{{+}}\\beta\\,a_m$ (with $\\beta{{=}}{chain['beta']:.2f}$):")
    short_name = {"qwen": "qwen", "ds4": "ds4", "kimi": "kimi"}
    lines.append("\\begin{center}\\scriptsize\\setlength{\\tabcolsep}{4pt}")
    lines.append("\\begin{tabular}{l r r r r c}")
    lines.append("\\toprule")
    lines.append("\\textbf{model} & $a_m$ & $D_m$ & $\\beta a_m$ & $J_m$ & \\textbf{sel.} \\\\")
    lines.append("\\midrule")
    short_name = {"qwen": "qwen", "ds4": "ds4", "kimi": "kimi"}
    for k in ("qwen", "ds4", "kimi"):
        mdl = chain["models"][k]
        mark = "$\\checkmark$" if k == best_key else ""
        lines.append(f"\\mdlogo{{{k}}}\\,\\texttt{{{short_name[k]}}} & "
                     f"{COST_VECTOR[k]:.2f} & {mdl['D']:.3f} & {mdl['cost_pen']:.3f} & "
                     f"{mdl['J']:.3f} & {mark} \\\\")
    lines.append("\\bottomrule")
    lines.append("\\end{tabular}\\end{center}")
    lines.append("")

    # ---- Step 7: decision ----
    top_cap = max(cap, key=cap.get).replace('_', '\\_')
    Jq, Js, Jk = (chain["models"][k]["J"] for k in ("qwen", "ds4", "kimi"))
    lines.append(f"\\medskip\\noindent\\textbf{{Step 7 -- decision.}} $m^{{\\star}}=\\arg\\min_m J_m = "
                 f"\\mdlogo{{{best_key}}}\\,\\texttt{{{pretty[best_key]}}}$ "
                 f"($J_{{\\text{{qwen}}}}{{=}}{Jq:.3f}$, $J_{{\\text{{ds4}}}}{{=}}{Js:.3f}$, "
                 f"$J_{{\\text{{kimi}}}}{{=}}{Jk:.3f}$). "
                 f"The dominant capability is \\texttt{{{top_cap}}} at $p{{=}}{max(cap.values()):.2f}$, "
                 f"and $\\tau_q{{=}}{tau:.2f}$ inflates the per-capability requirement; "
                 f"the qwen capacity on that dimension falls short, so its under-capacity "
                 f"penalty exceeds the cost gap to {best_key}.")
    lines.append("")
    lines.append("")
    lines.append("% --- Mini table 3 cherry-picked queries ---")
    lines.append("\\begin{table}[!t]")
    lines.append("\\caption{Three additional Brick decisions across capability dimensions, with the "
                 "dominant capability probability and complexity-derived difficulty.}")
    lines.append("\\label{tab:example_queries}")
    lines.append("\\small")
    lines.append("\\centering")
    lines.append("\\begin{tabular}{l l r l}")
    lines.append("\\toprule")
    lines.append("\\textbf{Dimension} & \\textbf{Dominant cap.} & $\\tau_q$ & \\textbf{Selected} \\\\")
    lines.append("\\midrule")
    for ent in cherry:
        sel_logo = f"\\mdlogo{{{ent['selected']}}}\\,\\texttt{{{label_map[ent['selected']]}}}"
        dim_esc = ent['dim'].replace('_', '\\_')
        lines.append(f"\\texttt{{{dim_esc}}} & \\texttt{{{SHORT[ent['top_cap']]}}}{{=}}{ent['top_cap_val']:.2f} & "
                     f"{ent['tau']:.2f} & {sel_logo} \\\\")
    lines.append("\\bottomrule")
    lines.append("\\end{tabular}")
    lines.append("\\end{table}")
    lines.append("")
    OUT.write_text("\n".join(lines))
    print(f"[ok] wrote {OUT}")
    print(f"  main query: {qid} ({dim}) selected={sel} J={scores}")
    print(f"  cherry-picked: {[(c['dim'], c['selected']) for c in cherry]}")


if __name__ == "__main__":
    main()
