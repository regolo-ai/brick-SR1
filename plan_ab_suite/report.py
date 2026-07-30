#!/usr/bin/env python3
"""Report della suite A/B plan-savings: consumo piano reale ON vs OFF.

Input: la run dir prodotta da run_suite.py (task_runs.jsonl +
events_snapshot_final.jsonl + meta.json) e pricing.yaml del repo.

Produce in <run_dir>:
  report_task_runs.csv    una riga per task-run (token, plan_units, esito)
  summary_by_branch.csv   aggregato per ramo
  report.md               tabelle + note metodologiche

Metriche:
  plan_units   = fresh*Pin + 1.25*cache_write*Pin + 0.10*cache_read*Pin + out*Pout
                 (USD, prezzi anthropic da pricing.yaml; proxy del consumo piano)
  delta util   = incrementi per-richiesta degli header anthropic-ratelimit
                 unified-*-utilization, attribuiti al ramo della richiesta
                 (robusto all'ordine abba); reset rilevati e scartati con WARN.
  risparmio lordo = (plan_units_off - plan_units_on) / plan_units_off
  risparmio netto = valore risparmiato - costo stimato classificatore Regolo
"""

import argparse
import csv
import datetime as dt
import json
import sys
from collections import defaultdict
from pathlib import Path
from statistics import median

import yaml

SUITE_DIR = Path(__file__).resolve().parent
REPO_ROOT = SUITE_DIR.parent

CACHE_WRITE_MULT = 1.25
CACHE_READ_MULT = 0.10
CLASSIFIER_OUT_TOKENS = 8  # etichetta di complessita: risposta di pochi token


def parse_ts(ts: str) -> dt.datetime:
    return dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))


def load_jsonl(path: Path):
    out = []
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def load_pricing(path: Path):
    """{model_prefix: (input_usd_per_1m, output_usd_per_1m, currency)}"""
    table = {}
    for row in yaml.safe_load(path.read_text()):
        table[row["model"]] = (
            float(row["input_price"]), float(row["output_price"]),
            row.get("currency", "USD"),
        )
    return table


def price_for(model: str, pricing):
    """Match per prefisso: served claude-sonnet-4-6 -> entry claude-sonnet."""
    best = None
    for name, p in pricing.items():
        if model.startswith(name) and (best is None or len(name) > len(best[0])):
            best = (name, p)
    return best[1] if best else None


def plan_units(ev, pricing, warns):
    model = ev.get("served_model", "")
    p = price_for(model, pricing)
    if p is None:
        key = f"pricing mancante per served_model {model}: plan_units=0 per i suoi eventi"
        if key not in warns:
            warns.append(key)
        return 0.0
    pin, pout, _ = p
    return (
        ev.get("fresh_input_tokens", 0) * pin
        + ev.get("cache_creation_tokens", 0) * pin * CACHE_WRITE_MULT
        + ev.get("cache_read_tokens", 0) * pin * CACHE_READ_MULT
        + ev.get("output_tokens", 0) * pout
    ) / 1e6


def join_events(runs, events, warns, time_fallback):
    """Associa gli eventi ai task-run. Join primario e autorevole sul
    request_tag. Il fallback sulla finestra temporale e opt-in perche in
    presenza di traffico Claude concorrente sullo stesso proxy (es. la sessione
    che lancia la suite) attribuirebbe eventi estranei ai run: va usato solo se
    il tag manca del tutto (versione Claude che non propaga l'header)."""
    by_tag = defaultdict(list)
    untagged = []
    for ev in events:
        tag = ev.get("request_tag")
        (by_tag[tag] if tag else untagged).append(ev)

    for run in runs:
        run["events"] = list(by_tag.get(run["tag"], []))

    run_tags = {r["tag"] for r in runs}
    if not time_fallback:
        if untagged:
            warns.append(f"{len(untagged)} eventi senza tag ESCLUSI dalla misura "
                         "(traffico concorrente sul proxy o richieste non taggate). "
                         "Usa --time-fallback per attribuirli per finestra temporale.")
        return sum(
            1 for ev in events
            if (ev.get("request_tag") or "") not in run_tags
        )

    fallback = 0
    matched_fallback = set()
    for ev in untagged:
        if not ev.get("ts"):
            continue
        ts = parse_ts(ev["ts"])
        for run in runs:
            lo = parse_ts(run["t_start"]) - dt.timedelta(seconds=5)
            hi = parse_ts(run["t_end"]) + dt.timedelta(seconds=5)
            if lo <= ts <= hi:
                run["events"].append(ev)
                matched_fallback.add(id(ev))
                fallback += 1
                break
    if fallback:
        warns.append(f"{fallback} eventi senza tag attribuiti per finestra temporale "
                     "(--time-fallback attivo: rischio contaminazione da traffico concorrente)")
    orphans = [
        e for e in events
        if id(e) not in matched_fallback
        and (e.get("request_tag") or "") not in run_tags
    ]
    return len(orphans)


def utilization_deltas(events, runs, warns):
    """Incrementi per-richiesta di ogni chiave unified-*-utilization,
    attribuiti al ramo dell'evento. Robusto all'ordine abba; i reset
    (valore che scende) vengono scartati con WARN."""
    branch_of = {}
    for run in runs:
        for ev in run["events"]:
            branch_of[id(ev)] = run["branch"]

    keyed = defaultdict(list)  # key -> [(ts, value, branch)]
    for ev in events:
        rl = ev.get("ratelimit_headers") or {}
        b = branch_of.get(id(ev))
        for k, v in rl.items():
            if k.endswith("utilization") and b:
                try:
                    keyed[k].append((parse_ts(ev["ts"]), float(v), b))
                except (ValueError, KeyError):
                    continue

    out = defaultdict(dict)  # branch -> key -> delta
    for key, rows in keyed.items():
        rows.sort(key=lambda r: r[0])
        resets = 0
        for (_, prev, _), (_, cur, branch) in zip(rows, rows[1:]):
            inc = cur - prev
            if inc < 0:
                resets += 1
                continue
            out[branch][key] = out[branch].get(key, 0.0) + inc
        if resets:
            warns.append(f"{key}: {resets} reset di finestra durante la run, "
                         "incrementi negativi scartati")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("run_dir", type=Path)
    ap.add_argument("--pricing", type=Path, default=REPO_ROOT / "pricing.yaml")
    ap.add_argument("--classifier-model", default="brick-complexity-pro")
    ap.add_argument("--classifier-price-in", type=float, default=None,
                    help="EUR per 1M token input del classificatore Regolo")
    ap.add_argument("--classifier-price-out", type=float, default=None)
    ap.add_argument("--eur-usd", type=float, default=1.0)
    ap.add_argument("--time-fallback", action="store_true",
                    help="attribuisci per finestra temporale anche gli eventi "
                         "senza tag (rischioso con traffico Claude concorrente)")
    args = ap.parse_args()

    run_dir = args.run_dir
    meta = json.loads((run_dir / "meta.json").read_text())
    runs = load_jsonl(run_dir / "task_runs.jsonl")
    events = load_jsonl(run_dir / "events_snapshot_final.jsonl")
    if not runs or not events:
        sys.exit("task_runs.jsonl o events_snapshot_final.jsonl vuoti/assenti")
    pricing = load_pricing(args.pricing)

    warns = []
    orphans = join_events(runs, events, warns, args.time_fallback)
    util = utilization_deltas(events, runs, warns)

    # prezzo classificatore: pricing.yaml se presente, altrimenti flag, altrimenti 0
    cls = price_for(args.classifier_model, pricing)
    cls_in = args.classifier_price_in if args.classifier_price_in is not None else (cls[0] if cls else 0.0)
    cls_out = args.classifier_price_out if args.classifier_price_out is not None else (cls[1] if cls else 0.0)
    if cls_in == 0.0 and cls_out == 0.0:
        warns.append("prezzo classificatore Regolo = 0 (nessun flag e nessuna entry "
                     f"{args.classifier_model} in pricing.yaml): costo esterno sottostimato")

    # ------------------------------------------------ per task-run
    per_run_rows = []
    for run in runs:
        evs = run["events"]
        tok = {k: sum(e.get(k, 0) for e in evs) for k in (
            "fresh_input_tokens", "cache_read_tokens",
            "cache_creation_tokens", "output_tokens")}
        units = sum(plan_units(e, pricing, warns) for e in evs)
        cls_chars = sum(e.get("classifier_prompt_chars", 0) for e in evs)
        n_cls = sum(1 for e in evs if e.get("classifier_prompt_chars", 0) > 0)
        dur = (parse_ts(run["t_end"]) - parse_ts(run["t_start"])).total_seconds()
        per_run_rows.append({
            "branch": run["branch"], "task_id": run["task_id"],
            "category": run["category"], "rep": run["rep"],
            "check_passed": run["check_passed"], "timed_out": run["timed_out"],
            "duration_s": round(dur, 1), "n_requests": len(evs), **tok,
            "plan_units_usd": round(units, 6),
            "classifier_prompt_chars": cls_chars, "classifier_calls": n_cls,
            "served_models": ";".join(sorted({e.get("served_model", "?") for e in evs})),
        })

    # ------------------------------------------------ per ramo
    summary = {}
    for branch in meta["branches"]:
        rows = [r for r in per_run_rows if r["branch"] == branch]
        runs_b = [r for r in runs if r["branch"] == branch]
        evs_b = [e for r in runs_b for e in r["events"]]
        tok = {k: sum(r[k] for r in rows) for k in (
            "fresh_input_tokens", "cache_read_tokens",
            "cache_creation_tokens", "output_tokens")}
        durs = sorted(r["duration_s"] for r in rows)
        cls_tokens_in = sum(r["classifier_prompt_chars"] for r in rows) / 4.0
        n_cls = sum(r["classifier_calls"] for r in rows)
        regolo_eur = (cls_tokens_in * cls_in
                      + n_cls * CLASSIFIER_OUT_TOKENS * cls_out) / 1e6
        served = defaultdict(lambda: [0, 0.0])
        for e in evs_b:
            served[e.get("served_model", "?")][0] += 1
            served[e.get("served_model", "?")][1] += plan_units(e, pricing, [])
        summary[branch] = {
            "runs": len(rows),
            "pass_rate": sum(r["check_passed"] for r in rows) / max(len(rows), 1),
            "n_requests": sum(r["n_requests"] for r in rows),
            **tok,
            "plan_units_usd": sum(r["plan_units_usd"] for r in rows),
            "duration_p50_s": median(durs) if durs else 0,
            "duration_p95_s": durs[max(0, -(-95 * len(durs) // 100) - 1)] if durs else 0,
            "regolo_cost_eur": regolo_eur,
            "util_deltas": util.get(branch, {}),
            "served_models": dict(served),
        }

    on, off = summary.get("brick_on"), summary.get("brick_off")
    gross_units = gross_tokens = net_usd = None
    if on and off and off["plan_units_usd"] > 0:
        gross_units = 1 - on["plan_units_usd"] / off["plan_units_usd"]
        tot = lambda s: (s["fresh_input_tokens"] + s["cache_read_tokens"]  # noqa: E731
                         + s["cache_creation_tokens"] + s["output_tokens"])
        if tot(off) > 0:
            gross_tokens = 1 - tot(on) / tot(off)
        net_usd = (off["plan_units_usd"] - on["plan_units_usd"]
                   - on["regolo_cost_eur"] * args.eur_usd)

    # ------------------------------------------------ output CSV
    with (run_dir / "report_task_runs.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(per_run_rows[0].keys()))
        w.writeheader()
        w.writerows(sorted(per_run_rows, key=lambda r: (r["task_id"], r["branch"], r["rep"])))

    with (run_dir / "summary_by_branch.csv").open("w", newline="") as fh:
        fields = ["branch", "runs", "pass_rate", "n_requests",
                  "fresh_input_tokens", "cache_read_tokens",
                  "cache_creation_tokens", "output_tokens", "plan_units_usd",
                  "duration_p50_s", "duration_p95_s", "regolo_cost_eur",
                  "util_deltas", "gross_saving_units_pct", "net_saving_usd"]
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for branch, s in summary.items():
            w.writerow({
                "branch": branch,
                **{k: (round(v, 6) if isinstance(v, float) else v)
                   for k, v in s.items() if k not in ("served_models", "util_deltas")},
                "util_deltas": json.dumps(s["util_deltas"]),
                "gross_saving_units_pct":
                    round(gross_units * 100, 2) if branch == "brick_on" and gross_units is not None else "",
                "net_saving_usd":
                    round(net_usd, 4) if branch == "brick_on" and net_usd is not None else "",
            })

    # ------------------------------------------------ report.md
    md = [f"# Report suite A/B plan-savings: run {meta['run_id']}", ""]
    md += [f"Rami: ON = `{meta['branches']['brick_on']}`, "
           f"OFF = `{meta['branches']['brick_off']}`. "
           f"Task: {len(meta['tasks'])}, rep: {meta['reps']}, ordine: {meta['order']}.", ""]

    md += ["## Consumo piano per ramo", "",
           "| ramo | run | pass rate | richieste | fresh in | cache read | cache write | output | plan units (USD) | p50 (s) | p95 (s) |",
           "|---|---|---|---|---|---|---|---|---|---|---|"]
    for branch, s in summary.items():
        md.append(
            f"| {branch} | {s['runs']} | {s['pass_rate']:.0%} | {s['n_requests']} "
            f"| {s['fresh_input_tokens']:,} | {s['cache_read_tokens']:,} "
            f"| {s['cache_creation_tokens']:,} | {s['output_tokens']:,} "
            f"| {s['plan_units_usd']:.4f} | {s['duration_p50_s']:.0f} "
            f"| {s['duration_p95_s']:.0f} |")
    md.append("")

    if gross_units is not None:
        md += ["## Risparmio", "",
               f"- Risparmio lordo (plan units): **{gross_units:.1%}**"]
        if gross_tokens is not None:
            md.append(f"- Risparmio lordo (token totali): {gross_tokens:.1%}")
        md += [f"- Costo esterno stimato classificatore Regolo (ramo ON): "
               f"{on['regolo_cost_eur']:.4f} EUR",
               f"- Risparmio netto: **{net_usd:.4f} USD** sulla suite "
               f"(eur/usd = {args.eur_usd})", ""]

    md += ["## Delta utilization piano (header anthropic-ratelimit)", ""]
    any_util = any(s["util_deltas"] for s in summary.values())
    if any_util:
        keys = sorted({k for s in summary.values() for k in s["util_deltas"]})
        md += ["| ramo | " + " | ".join(keys) + " |",
               "|---|" + "---|" * len(keys)]
        for branch, s in summary.items():
            md.append(f"| {branch} | " + " | ".join(
                f"{s['util_deltas'].get(k, 0):.4g}" for k in keys) + " |")
        md += ["", "Incrementi per-richiesta attribuiti al ramo della richiesta "
               "(robusto all'ordine abba).", ""]
    else:
        md += ["Nessun header unified-*-utilization osservato: "
               "sezione non disponibile, fa fede plan_units.", ""]

    md += ["## Modelli serviti per ramo", ""]
    for branch, s in summary.items():
        md.append(f"**{branch}**")
        for model, (n, units) in sorted(s["served_models"].items(),
                                        key=lambda kv: -kv[1][1]):
            md.append(f"- {model}: {n} richieste, {units:.4f} plan units")
        md.append("")

    md += ["## Pass rate per categoria", "",
           "| categoria | brick_on | brick_off |", "|---|---|---|"]
    cats = sorted({r["category"] for r in per_run_rows})
    for cat in cats:
        cells = []
        for branch in summary:
            rows = [r for r in per_run_rows
                    if r["category"] == cat and r["branch"] == branch]
            cells.append(f"{sum(r['check_passed'] for r in rows)}/{len(rows)}")
        md.append(f"| {cat} | " + " | ".join(cells) + " |")
    md.append("")

    if orphans:
        warns.append(f"{orphans} eventi nel log non attribuiti ad alcun task-run "
                     "(traffico estraneo durante la suite?)")
    if warns:
        md += ["## Warning", ""] + [f"- {w}" for w in warns] + [""]

    md += ["## Note metodologiche", "",
           "- plan_units usa i prezzi API Anthropic come proxy del metering "
           "del piano (pesi cache 1.25x write, 0.10x read): il metering interno "
           "della subscription non e pubblico.",
           "- I token sono conteggi reali dalla usage Anthropic, catturati dal "
           "proxy per ogni risposta (routed e passthrough).",
           "- Il costo Regolo e una stima (chars/4) marcata come tale.", ""]

    (run_dir / "report.md").write_text("\n".join(md))
    print(f"report scritto in {run_dir}/report.md")
    print(f"  {run_dir}/summary_by_branch.csv")
    print(f"  {run_dir}/report_task_runs.csv")
    if gross_units is not None:
        print(f"\nrisparmio lordo plan_units: {gross_units:.1%}   "
              f"pass rate ON {on['pass_rate']:.0%} vs OFF {off['pass_rate']:.0%}")


if __name__ == "__main__":
    main()
