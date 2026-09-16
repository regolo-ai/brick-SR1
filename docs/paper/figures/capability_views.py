"""Two-panel composite figure for the routing decision on q_03563.

Panel A: heatmap 4x6 (query p(x) + 3 model skill rows).
Panel B: 3D vector view on (crea, cod, wld) with model logos and winning arc.

The vector view uses quivers from origin, logo at each vector tip, white-bordered labels. All
numerical values come from the worked example (sec:brick-example) so the
figure stays in sync with Steps 1-6.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.gridspec import GridSpec
from matplotlib.offsetbox import AnnotationBbox, OffsetImage
from matplotlib.patches import Rectangle
from mpl_toolkits.mplot3d.proj3d import proj_transform  # noqa: F401

FIG = Path(__file__).resolve().parent
LOGO_DIR = FIG / "logos"

LOGO_PATH = {
    "qwen": LOGO_DIR / "qwen_logo.png",
    "ds4":  LOGO_DIR / "ds4_logo.png",
    "kimi": LOGO_DIR / "kimi_logo.png",
}
# Calibrated per-logo zoom to compensate for the very different source resolutions
# (qwen 1553px, ds4 1626px, kimi 320px). Aligned with generate_figures.py.
LOGO_BASE_ZOOM = {"qwen": 0.012, "ds4": 0.012, "kimi": 0.060}

# Brand-ish colors, matching the original 3D schematic palette.
COLOR_QWEN = "#9A9A9A"
COLOR_DS4 = "#4D6BFE"
COLOR_KIMI = "#5A5A5A"
COLOR_QUERY = "#2CA02C"

CAP_LABELS_SHORT = ["cod", "crea", "ifo", "math", "plan", "wld"]

# q_03563 p(x) full-precision, same source as extract_example_query.py
# (external_comparison/predictions/brick_debug_gpu.jsonl, brick_debug.capability).
# Step 1 of the paper rounds these to 2 decimals for display (0.09 / 0.53),
# but Step 3/4 use the full-precision values, so the heatmap must too.
P_Q = np.array([
    0.09461796216688048,  # coding
    0.5269101891655977,   # creative_synthesis
    0.09461796216688048,  # instruction_following
    0.09461796216688048,  # math_reasoning
    0.09461796216688048,  # planning_agentic
    0.09461796216688048,  # world_knowledge
])

# Production skill matrix at full precision (mirrors extract_example_query.py
# SKILL_MATRIX so Panel A matches Step 4 of the tex worked example exactly).
S_QWEN = np.array([0.714788, 0.511538, 0.810109, 0.912146, 0.577072, 0.179876])
S_DS4 = np.array([0.820939, 0.657845, 0.863112, 0.934963, 0.620550, 0.488518])
S_KIMI = np.array([0.904272, 0.751595, 0.870180, 0.943892, 0.641863, 0.344074])

# Effective difficulty logit z_q = b + mu * logit(tau_q), computed in Step 2 with
# b=0.15, mu=1.07, tau_q=0.802272 (also from the brick_debug record above).
Z_Q = 1.649


def logit(s: np.ndarray) -> np.ndarray:
    s_clipped = np.clip(s, 1e-6, 1 - 1e-6)
    return np.log(s_clipped / (1.0 - s_clipped))


def _load_logo(name: str, scale: float = 1.0) -> OffsetImage | None:
    p = LOGO_PATH.get(name)
    if p is None or not p.exists():
        return None
    z = LOGO_BASE_ZOOM.get(name, 0.04) * scale
    try:
        img = plt.imread(str(p))
        return OffsetImage(img, zoom=z)
    except Exception:
        return None


# ---------- Panel A: heatmap 4x6 of post-projection values (Step 3-4) ----------
def panel_heatmap(ax: plt.Axes) -> None:
    # Row 0: per-capability requirement r_{q,c} = p_c * z_q (Step 3).
    # Rows 1-3: per-model capacity v_{m,c} = p_c * logit(s_{m,c}) (Step 4).
    # These are the SAME values the 3D panel plots — what the router actually compares.
    r_q = P_Q * Z_Q
    v_qwen = P_Q * logit(S_QWEN)
    v_ds4 = P_Q * logit(S_DS4)
    v_kimi = P_Q * logit(S_KIMI)

    matrix = np.vstack([r_q, v_qwen, v_ds4, v_kimi])  # 4 x 6
    row_labels = [r"query $r_{q,c}$", "qwen $v_{m,c}$", "ds4 $v_{m,c}$", "kimi $v_{m,c}$"]

    vmin = float(matrix.min())
    vmax = float(matrix.max())
    im = ax.imshow(matrix, cmap="YlGnBu", vmin=vmin, vmax=vmax, aspect="auto")

    light_threshold = vmin + 0.6 * (vmax - vmin)
    for i in range(matrix.shape[0]):
        for j in range(matrix.shape[1]):
            val = matrix[i, j]
            txt_color = "white" if val > light_threshold else "black"
            ax.text(j, i, f"{val:.2f}", ha="center", va="center",
                    color=txt_color, fontsize=7)

    # Red boxes mark the model whose capacity v_{m,c} is closest to the query
    # requirement r_{q,c} from below (smallest under-capacity gap) on that column;
    # this is the per-dimension "least deficient" model for the query.
    model_block = matrix[1:, :]
    closest_idx = np.argmax(model_block, axis=0) + 1
    for j, i in enumerate(closest_idx):
        ax.add_patch(Rectangle((j - 0.5, i - 0.5), 1.0, 1.0,
                               fill=False, edgecolor="red", linewidth=1.6))

    ax.axhline(y=0.5, color="black", linewidth=0.5)

    ax.set_xticks(range(len(CAP_LABELS_SHORT)))
    ax.set_xticklabels(CAP_LABELS_SHORT, rotation=30, ha="right", fontsize=8)
    ax.set_yticks(range(len(row_labels)))
    ax.set_yticklabels(row_labels, fontsize=8)
    ax.tick_params(axis="both", which="both", length=0)
    ax.set_title("(A) Per-capability requirement vs capacity", fontsize=10)

    cbar = plt.colorbar(im, ax=ax, fraction=0.040, pad=0.04)
    cbar.ax.tick_params(labelsize=7)


# ---------- Panel B: 3D vector view ----------
def panel_3d(ax, fig: plt.Figure) -> None:
    # Three axes for the projection: (crea, cod, wld).
    # crea -> dominant capability (p=0.53), cod -> informative competition axis,
    # wld -> discriminator (refusal-relevant in §11).
    idx_crea, idx_cod, idx_wld = 1, 0, 5
    axis_idx = [idx_cod, idx_crea, idx_wld]
    axis_labels = ["cod", "crea", r"world\_kn."]

    # Per-capability requirement r_q,c = p_c * z_q (Step 3).
    r_q = P_Q * Z_Q
    # Per-model capacity v_m,c = p_c * logit(s_m,c) (Step 4).
    v_qwen = P_Q * logit(S_QWEN)
    v_ds4 = P_Q * logit(S_DS4)
    v_kimi = P_Q * logit(S_KIMI)

    def take(v: np.ndarray) -> tuple[float, float, float]:
        return v[axis_idx[0]], v[axis_idx[1]], v[axis_idx[2]]

    items = [
        (take(v_qwen), "qwen3.5-9b", COLOR_QWEN, "qwen"),
        (take(v_ds4), "deepseek-v4-flash", COLOR_DS4, "ds4"),
        (take(v_kimi), "kimi2.6", COLOR_KIMI, "kimi"),
        (take(r_q), r"query $r_q$", COLOR_QUERY, None),
    ]
    for vec, _name, color, _lname in items:
        ax.quiver(0, 0, 0, vec[0], vec[1], vec[2],
                  color=color, linewidth=1.6, arrow_length_ratio=0.07, zorder=3)
        ax.scatter(*vec, color=color, s=55, edgecolors="black", linewidths=0.5, zorder=6)

    # Winning distance arc: query -> kimi (the selected model in §8.2 Step 7).
    q_pt = take(r_q)
    k_pt = take(v_kimi)
    ax.plot([q_pt[0], k_pt[0]], [q_pt[1], k_pt[1]], [q_pt[2], k_pt[2]],
            color=COLOR_QUERY, linestyle="--", linewidth=1.6, zorder=4, alpha=0.85)
    mid = ((q_pt[0] + k_pt[0]) / 2, (q_pt[1] + k_pt[1]) / 2, (q_pt[2] + k_pt[2]) / 2)
    ax.text(mid[0] + 0.02, mid[1] - 0.06, mid[2] - 0.15,
            r"$D_{\mathrm{kimi}}$ (winner)", fontsize=9, color="#1F4E79", style="italic",
            bbox=dict(facecolor="white", alpha=0.85, edgecolor="none", pad=1.5), zorder=7)

    # Query label.
    ax.text(q_pt[0] - 0.05, q_pt[1] + 0.04, q_pt[2] + 0.05,
            r"query $r_q$", fontsize=10, color=COLOR_QUERY, weight="bold",
            bbox=dict(facecolor="white", alpha=0.85, edgecolor="none", pad=1.8), zorder=7)

    ax.set_xlabel(axis_labels[0], fontsize=10, labelpad=6)
    ax.set_ylabel(axis_labels[1], fontsize=10, labelpad=6)
    ax.set_zlabel(axis_labels[2], fontsize=10, labelpad=4)

    # Axis ranges chosen to keep all 4 vectors visible without clipping.
    ax.set_xlim(0, 0.30); ax.set_ylim(0, 1.00); ax.set_zlim(-0.20, 0.25)
    ax.set_xticks([0, 0.15, 0.30])
    ax.set_yticks([0, 0.5, 1.0])
    ax.set_zticks([-0.2, 0, 0.2])
    ax.tick_params(labelsize=7)
    for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
        axis.pane.set_facecolor((1, 1, 1, 0.0))
        axis.pane.set_edgecolor((0.6, 0.6, 0.6, 0.4))
    ax.grid(True, linestyle=":", alpha=0.35)
    try:
        ax.set_box_aspect((1, 1, 0.9))
    except Exception:
        pass
    ax.view_init(elev=18, azim=-50)
    ax.set_title("(B) 3D requirement vs capacity", fontsize=10)

    # Overlay 2D logos at projected vector tips.
    fig.canvas.draw()
    for vec, _name, _color, lname in items:
        if not lname:
            continue
        oi = _load_logo(lname, scale=1.0)
        if oi is None:
            continue
        x2, y2, _ = proj_transform(vec[0], vec[1], vec[2], ax.get_proj())
        ab = AnnotationBbox(oi, (x2, y2), xybox=(24, 12), xycoords="data",
                            boxcoords="offset points", frameon=False, pad=0.0, zorder=10)
        ax.add_artist(ab)


def main() -> None:
    fig = plt.figure(figsize=(12.0, 4.6))
    gs = GridSpec(1, 2, figure=fig, width_ratios=[1.0, 1.1], wspace=0.25)

    ax_a = fig.add_subplot(gs[0, 0])
    panel_heatmap(ax_a)

    ax_b = fig.add_subplot(gs[0, 1], projection="3d")
    panel_3d(ax_b, fig)

    FIG.mkdir(parents=True, exist_ok=True)
    for ext in ("png", "pdf"):
        out = FIG / f"capability_views.{ext}"
        fig.savefig(out, dpi=220, bbox_inches="tight")
        print(f"[ok] {out}")
    plt.close(fig)


if __name__ == "__main__":
    main()
