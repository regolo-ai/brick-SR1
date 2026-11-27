"""Generate 4 PNG figures embedded in paper.tex.

Outputs in docs/figures/:
  cost_pareto.png       Pareto front cost vs response accuracy on Dataset A
  modernbert_training.png  W&B sweep summary (loss / pearson_macro best run)
  latency_cdf.png       End-to-end latency CDF: Brick vs always-{qwen,ds4,kimi}

Requires: matplotlib (>=3.5), numpy, wandb (optional, fallback if no access).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

FIG = Path(__file__).parent
STATS = json.loads((FIG / "latency_stats.json").read_text())

plt.rcParams.update({
    "font.size": 9,
    "axes.titlesize": 10,
    "axes.labelsize": 9,
    "legend.fontsize": 8,
    "figure.dpi": 150,
})

LOGO_DIR = FIG / "logos"
LOGO_PATH = {
    "qwen":   LOGO_DIR / "qwen_logo.png",
    "ds4":    LOGO_DIR / "ds4_logo.png",
    "kimi":   LOGO_DIR / "kimi_logo.png",
    "regolo": LOGO_DIR / "regolo_logo.jpg",
}
# Per-logo zoom calibration so the rendered image is visually the same size
# regardless of the source PNG resolution (qwen=1553px, ds4=1626px, kimi=320px,
# regolo=1080px). All values produce ~14-pixel-tall logos at default DPI.
LOGO_BASE_ZOOM = {
    "qwen":   0.012,
    "ds4":    0.012,
    "kimi":   0.060,
    "regolo": 0.018,
}


def _load_logo(name, scale=1.0):
    """Return OffsetImage normalized to a consistent visual size.

    scale=1.0 produces the calibrated baseline; pass scale=0.8 for slightly
    smaller, scale=1.2 for larger. The per-logo zoom factor compensates for the
    very different source-image resolutions.
    """
    from matplotlib.offsetbox import OffsetImage
    p = LOGO_PATH.get(name)
    if not p or not p.exists():
        return None
    z = LOGO_BASE_ZOOM.get(name, 0.04) * scale
    try:
        img = plt.imread(str(p))
        return OffsetImage(img, zoom=z)
    except Exception:
        return None


def _annotate_logo(ax, x, y, name, scale=1.0, offset=(0, 0), frameon=False):
    from matplotlib.offsetbox import AnnotationBbox
    oi = _load_logo(name, scale=scale)
    if oi is None:
        return
    ab = AnnotationBbox(oi, (x, y), xybox=offset, xycoords="data",
                        boxcoords="offset points", frameon=frameon, pad=0.0, zorder=10)
    ax.add_artist(ab)


def fig_cost_pareto():
    """Cost vs response accuracy.

    Singles  = SQUARES marked with model logos.
    Externals = TRIANGLES, one distinct color each.
    Brick    = CIRCLES, one distinct color per profile (max=star).
    All twelve points appear individually in the legend.
    """
    # Costs are USD per call, full Dataset A mean.
    # Source: scientificv1/data/reports/cost_audit/router_costs.md (OpenRouter 2026-05-26).
    # Accuracy figures preserved from paper (HF dataset re-graded post publication;
    # paper accuracy remains authoritative per author).
    singles = [
        ("always-qwen",  0.001386, 63.17, "#EC407A", "qwen"),
        ("always-ds4",   0.002895, 73.69, "#4FC3F7", "ds4"),
        ("always-kimi",  0.030703, 75.02, "#0D47A1", "kimi"),
    ]
    externals = [
        # RouteLLM binary/tournament dispatch ~100% to kimi → cost = always-kimi.
        # Tiny x-jitter so points remain visible.
        ("RouteLLM binary",     0.030700, 75.02, "#FDD835"),
        ("RouteLLM tournament", 0.030706, 75.02, "#FB8C00"),
        ("FrugalGPT cascade",   0.004114, 69.42, "#E53935"),  # cumulative incl. rejected stages
        ("Cascade Routing",     0.006113, 73.40, "#B71C1C"),  # cascade_calls=1 in artifact → no rejected
    ]
    # Brick profiles: cost = linear plug-in of dispatch% × per-model mean cost.
    bricks = [
        ("Brick min ($r{=}{-}1.0$)",     0.001386, 63.17, "#C8E6C9", "o"),
        ("Brick low ($r{=}{-}0.5$)",     0.003557, 71.62, "#A5D6A7", "o"),
        ("Brick neutral ($r{=}0$)",       0.006513, 74.11, "#66BB6A", "o"),
        ("Brick high ($r{=}{+}0.5$)",    0.014905, 76.24, "#2E7D32", "o"),
        ("Brick max ($r{=}{+}1.0$)",     0.022083, 76.98, "#1B5E20", "*"),
    ]

    fig, ax = plt.subplots(figsize=(6.8, 3.6))
    legend_handles = []
    from matplotlib.lines import Line2D
    # --- Singles: scatter with logo overlay above the marker ---
    for name, cost, acc, color, lname in singles:
        ax.scatter(cost, acc, c=color, marker="s", s=80, edgecolors="black",
                   linewidths=0.6, zorder=4)
        _annotate_logo(ax, cost, acc, lname, scale=0.85, offset=(0, 18))
        legend_handles.append(
            Line2D([0], [0], marker="s", color="w", markerfacecolor=color,
                   markeredgecolor="black", markersize=8, label=name)
        )
    # --- Externals ---
    for name, cost, acc, color in externals:
        ax.scatter(cost, acc, c=color, marker="^", s=80, edgecolors="black",
                   linewidths=0.5, zorder=4)
        legend_handles.append(
            Line2D([0], [0], marker="^", color="w", markerfacecolor=color,
                   markeredgecolor="black", markersize=8, label=name)
        )
    # --- Brick profiles (Regolo logo on the max profile, scaled to match singles) ---
    for name, cost, acc, color, marker in bricks:
        size = 200 if marker == "*" else 80
        ax.scatter(cost, acc, c=color, marker=marker, s=size, edgecolors="black",
                   linewidths=0.6, zorder=5)
        if marker == "*":
            _annotate_logo(ax, cost, acc, "regolo", scale=0.85, offset=(0, 20))
        legend_handles.append(
            Line2D([0], [0], marker=marker, color="w", markerfacecolor=color,
                   markeredgecolor="black", markersize=11 if marker == "*" else 8,
                   label=name)
        )
    # Brick Pareto trace
    bx = [b[1] for b in bricks]
    by = [b[2] for b in bricks]
    ax.plot(bx, by, color="#2C2C2C", linewidth=0.9, alpha=0.5, linestyle="-", zorder=2)
    # Oracle ceiling
    ax.axhline(83.25, color="black", linestyle="--", linewidth=1.0, alpha=0.6)
    legend_handles.append(
        Line2D([0], [0], color="black", linestyle="--", linewidth=1.0, label=r"oracle ceiling (83.25\%)")
    )

    ax.set_xlabel(r"Average cost per query (USD)")
    ax.set_ylabel(r"Response accuracy (\%)")
    ax.set_title(r"Cost vs accuracy on Dataset~A ($N{=}5{,}504$)")
    ax.set_xlim(0.0008, 0.035)
    ax.set_ylim(60, 88)
    ax.set_xscale("log")
    ax.grid(True, linestyle=":", alpha=0.45)
    ax.legend(handles=legend_handles, loc="upper left", ncol=1,
              framealpha=0.95, fontsize=6.8, borderaxespad=0.5,
              handletextpad=0.4, labelspacing=0.28)
    fig.tight_layout()
    out = FIG / "cost_pareto.png"
    fig.savefig(out, bbox_inches="tight", dpi=190)
    plt.close(fig)
    print(f"[ok] {out}")


def fig_modernbert_training():
    """W&B-style dashboard: top-10 runs across 5 metrics in a 2x3 grid."""
    out = FIG / "modernbert_training.png"
    sweep_path = "massa-industries/dataset-b-modernbert/0srgzjrg"

    metric_keys = ["train/loss", "train/learning_rate", "train/grad_norm",
                   "eval/loss", "eval/pearson_macro"]
    metric_titles = {
        "train/loss":          "train/loss",
        "train/learning_rate": "train/learning_rate",
        "train/grad_norm":     "train/grad_norm",
        "eval/loss":           "eval/loss",
        "eval/pearson_macro":  "eval/pearson_macro",
    }

    runs_data = []  # list of dict: {name, pm, series: {metric -> (steps, vals)}}
    cache_path = FIG / "_wandb_cache_modernbert.json"
    refresh = os.environ.get("REFRESH_WANDB", "0") == "1"
    if cache_path.exists() and not refresh:
        try:
            cached = json.loads(cache_path.read_text())
            runs_data = [
                {"name": r["name"], "pm": r["pm"],
                 "series": {k: (v[0], v[1]) for k, v in r["series"].items()}}
                for r in cached
            ]
            print(f"  [wandb cache] loaded {len(runs_data)} runs from {cache_path.name}")
        except Exception as e:
            print(f"  [wandb cache] invalid ({e}), refetching")
            runs_data = []
    try:
        if not runs_data:
            os.environ.setdefault("WANDB_API_KEY", (Path.home() / ".wandb_key").read_text().strip())
            import wandb
            api = wandb.Api(timeout=30)
            sweep = api.sweep(sweep_path)
            all_sweep_runs = list(sweep.runs)
            print(f"  W&B sweep total runs: {len(all_sweep_runs)}")
            scored = []
            for run in all_sweep_runs:
                pm = run.summary.get("eval/pearson_macro", None)
                if pm is None:
                    continue
                scored.append((float(pm), run))
            scored.sort(key=lambda kv: -kv[0])
            top_runs = scored[:10]
            for pm, run in top_runs:
                series = {}
                for k in metric_keys:
                    try:
                        rows = list(run.scan_history(keys=[k, "_step"], page_size=1000))
                    except Exception:
                        rows = []
                    xs, ys = [], []
                    for h in rows:
                        s = h.get("_step"); v = h.get(k)
                        if s is None or v is None:
                            continue
                        xs.append(s); ys.append(v)
                    series[k] = (xs, ys)
                if all(len(s[0]) == 0 for s in series.values()):
                    print(f"  skip run={run.name} (no history)")
                    continue
                runs_data.append({"name": run.name, "pm": pm, "series": series})
                print(f"  run={run.name} pm={pm:.3f} points={[len(s[0]) for s in series.values()]}")
            if not runs_data:
                raise RuntimeError("no runs with history")
            try:
                cache_path.write_text(json.dumps(runs_data))
                print(f"  [wandb cache] wrote {cache_path.name}")
            except Exception as e:
                print(f"  [wandb cache] write failed: {e}")
    except Exception as e:
        print(f"  [wandb fallback] {e}")
        # Tiny illustrative single-run fallback
        runs_data = [{"name": "illustrative", "pm": 0.85, "series": {
            "train/loss": (list(range(0, 1600, 40)),
                           [0.32 * np.exp(-s / 280) + 0.05 for s in range(0, 1600, 40)]),
            "train/learning_rate": (list(range(0, 1600, 40)),
                                    [5e-5 * (1 - s / 1600) for s in range(0, 1600, 40)]),
            "train/grad_norm": (list(range(0, 1600, 40)),
                                [1.5 * np.exp(-s / 400) + 0.5 for s in range(0, 1600, 40)]),
            "eval/loss": (list(range(0, 1600, 200)),
                          [0.4 * np.exp(-s / 300) + 0.05 for s in range(0, 1600, 200)]),
            "eval/pearson_macro": (list(range(0, 1600, 200)),
                                   [0.4 + 0.5 * (1 - np.exp(-s / 300)) for s in range(0, 1600, 200)]),
        }}]

    # W&B-like qualitative palette (10 distinct colors).
    palette = ["#E45756", "#4C78A8", "#54A24B", "#B279A2", "#9D755D",
               "#72B7B2", "#F58518", "#EECA3B", "#FF9DA6", "#BAB0AC"]

    fig, axes = plt.subplots(2, 3, figsize=(10.0, 5.4))
    flat = axes.flatten()
    handles_for_legend = {}
    for ax_idx, mkey in enumerate(metric_keys):
        ax = flat[ax_idx]
        for ri, rd in enumerate(runs_data):
            color = palette[ri % len(palette)]
            xs, ys = rd["series"].get(mkey, ([], []))
            if not xs:
                continue
            (ln,) = ax.plot(xs, ys, color=color, linewidth=1.2, alpha=0.95)
            handles_for_legend.setdefault(rd["name"], (ln, color))
        ax.set_title(metric_titles[mkey], fontsize=9.5, loc="left",
                     color="#333333", family="sans-serif", pad=4)
        ax.set_facecolor("white")
        for sp in ("top", "right"):
            ax.spines[sp].set_visible(False)
        for sp in ("left", "bottom"):
            ax.spines[sp].set_color("#BBBBBB"); ax.spines[sp].set_linewidth(0.8)
        ax.grid(True, axis="y", linestyle="-", color="#E5E5E5", linewidth=0.7, zorder=0)
        ax.tick_params(labelsize=8, colors="#555555", length=3, width=0.6)
        ax.set_xlabel("train/global_step", fontsize=7.5, color="#777777", labelpad=1)
        if mkey == "train/learning_rate":
            ax.ticklabel_format(axis="y", style="sci", scilimits=(-5, -5))
            ax.yaxis.get_offset_text().set_fontsize(7)
    # Hide unused 6th axis
    flat[5].set_visible(False)

    # Shared legend at top
    leg_handles = [h for h, _ in handles_for_legend.values()]
    leg_labels = list(handles_for_legend.keys())
    fig.legend(leg_handles, leg_labels, loc="upper center", ncol=5, fontsize=8,
               frameon=False, bbox_to_anchor=(0.5, 1.02), columnspacing=1.2,
               handlelength=1.5, handletextpad=0.4)
    fig.suptitle("")
    fig.tight_layout(rect=(0, 0, 1, 0.96))
    fig.savefig(out, bbox_inches="tight", dpi=170, facecolor="white")
    plt.close(fig)
    print(f"[ok] {out}  ({len(runs_data)} runs)")


def fig_latency_cdf():
    """CDF end-to-end latency: Brick MoM vs always-X. Legend rows include the model logo."""
    samples = STATS["per_model_samples"]
    brick = STATS["brick_e2e_samples"]
    fig, ax = plt.subplots(figsize=(5.2, 3.2))

    def cdf(values, color, ls="-"):
        v = sorted(float(x) for x in values if x is not None and x > 0)
        if not v:
            return None, None
        ys = np.arange(1, len(v) + 1) / len(v)
        return np.array(v) / 1000.0, ys

    entries = [
        ("always-qwen",  samples["qwen3.5-9b"],         "#1F77B4", "qwen"),
        ("always-ds4",   samples["deepseek-v4-flash"],  "#FF7F0E", "ds4"),
        ("always-kimi",  samples["kimi2.6"],            "#D62728", "kimi"),
        ("Brick (MoM)",  brick,                          "#2CA02C", "regolo"),
    ]
    line_objs = []
    for name, vals, color, lname in entries:
        xs, ys = cdf(vals, color)
        if xs is None:
            continue
        (line,) = ax.plot(xs, ys, color=color, linewidth=1.6, label=name)
        line_objs.append((line, lname, name))
    ax.set_xscale("log")
    ax.set_xlabel("End-to-end latency (seconds, log scale)")
    ax.set_ylabel("Cumulative fraction of queries")
    ax.set_title(r"End-to-end latency CDF on Dataset~A")
    ax.grid(True, which="both", linestyle=":", alpha=0.45)
    # Custom legend with mini-logo as marker handle
    from matplotlib.legend_handler import HandlerBase
    from matplotlib.offsetbox import OffsetImage

    class HandlerLogo(HandlerBase):
        def __init__(self, lname):
            super().__init__()
            self.lname = lname

        def create_artists(self, legend, orig_handle, xdescent, ydescent,
                            width, height, fontsize, trans):
            from matplotlib.offsetbox import AnnotationBbox
            oi = _load_logo(self.lname, scale=0.35)
            line = plt.Line2D([xdescent, xdescent + width],
                              [ydescent + height / 2, ydescent + height / 2],
                              color=orig_handle.get_color(), linewidth=2.0)
            artists = [line]
            if oi is not None:
                ab = AnnotationBbox(oi, (xdescent + width + 14, ydescent + height / 2),
                                    xycoords=trans, boxcoords=trans,
                                    frameon=False, pad=0.0)
                artists.append(ab)
            return artists

    handler_map = {}
    proxies = []
    labels = []
    for line, lname, name in line_objs:
        if lname:
            handler_map[line] = HandlerLogo(lname)
        proxies.append(line)
        labels.append(name)
    ax.legend(proxies, labels, handler_map=handler_map, loc="lower right",
              framealpha=0.97, fontsize=9, handlelength=2.6, handletextpad=2.2)
    out = FIG / "latency_cdf.png"
    fig.tight_layout()
    fig.savefig(out, bbox_inches="tight", dpi=180)
    plt.close(fig)
    print(f"[ok] {out}")


if __name__ == "__main__":
    fig_cost_pareto()
    fig_modernbert_training()
    fig_latency_cdf()
