#!/usr/bin/env python3
"""Generate a self-hosted star history chart (light + dark SVG).

Fetches the full stargazer timeline for a repo (timestamps included) and draws a
star-history-style area chart as two static SVGs committed into the repo. Runs in
a GitHub Action where GITHUB_TOKEN is a collaborator on the repo, so the
stargazers endpoint (restricted to admins/collaborators since 2026-06-30) is
readable. No third-party service, no runtime timeouts.

Usage:
    GITHUB_TOKEN=... python scripts/gen_star_history.py \
        --repo regolo-ai/brick-SR1 --out docs/assets/star-history
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

API = "https://api.github.com"
STAR_ACCEPT = "application/vnd.github.star+json"  # includes starred_at timestamps


def gh_get(url: str, token: str, accept: str = "application/vnd.github+json"):
    req = urllib.request.Request(url)
    req.add_header("Accept", accept)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "brick-star-history")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read()), resp.headers


def fetch_stargazers(repo: str, token: str) -> list[datetime]:
    """Return sorted starred_at timestamps for every stargazer."""
    times: list[datetime] = []
    page = 1
    while True:
        url = f"{API}/repos/{repo}/stargazers?per_page=100&page={page}"
        data, _ = gh_get(url, token, accept=STAR_ACCEPT)
        if not data:
            break
        for entry in data:
            ts = entry.get("starred_at")
            if ts:
                times.append(datetime.fromisoformat(ts.replace("Z", "+00:00")))
        if len(data) < 100:
            break
        page += 1
        if page > 400:  # 40k stars hard stop, safety
            break
    times.sort()
    return times


def build_series(times: list[datetime]) -> list[tuple[datetime, int]]:
    """Cumulative (timestamp, count) series, one point per star plus endpoints."""
    if not times:
        now = datetime.now(timezone.utc)
        return [(now, 0)]
    series = [(t, i + 1) for i, t in enumerate(times)]
    # anchor the curve to "now" so the last segment reaches today
    series.append((datetime.now(timezone.utc), len(times)))
    return series


def nice_ticks(vmax: int, target: int = 4) -> list[int]:
    if vmax <= 0:
        return [0]
    raw = vmax / target
    mag = 10 ** (len(str(int(raw))) - 1)
    for step in (1, 2, 2.5, 5, 10):
        s = step * mag
        if raw <= s:
            step_val = int(s) if s >= 1 else 1
            break
    else:
        step_val = int(10 * mag)
    ticks = list(range(0, vmax + step_val, step_val))
    return ticks


THEMES = {
    "light": dict(
        bg="transparent",
        axis="#57606a",
        grid="#d0d7de",
        text="#57606a",
        line="#e3b341",
        fill_top="#e3b341",
        fill_bot="#e3b341",
        fill_top_op="0.35",
        fill_bot_op="0.02",
        dot="#d4a017",
    ),
    "dark": dict(
        bg="transparent",
        axis="#8b949e",
        grid="#30363d",
        text="#8b949e",
        line="#e3b341",
        fill_top="#e3b341",
        fill_bot="#e3b341",
        fill_top_op="0.30",
        fill_bot_op="0.02",
        dot="#f0c419",
    ),
}


def render_svg(series: list[tuple[datetime, int]], theme: str, repo: str) -> str:
    W, H = 800, 420
    ml, mr, mt, mb = 64, 52, 46, 52  # margins
    pw, ph = W - ml - mr, H - mt - mb
    c = THEMES[theme]

    t0 = series[0][0].timestamp()
    t1 = series[-1][0].timestamp()
    span = max(t1 - t0, 1)
    vmax = max(v for _, v in series)
    ticks = nice_ticks(vmax)
    ytop = ticks[-1]

    def px(t):
        return ml + (t.timestamp() - t0) / span * pw

    def py(v):
        return mt + ph - (v / ytop * ph if ytop else 0)

    pts = [(px(t), py(v)) for t, v in series]

    # step line (star history uses a stepped curve: value jumps at each star)
    line_cmds = [f"M {pts[0][0]:.1f} {pts[0][1]:.1f}"]
    for i in range(1, len(pts)):
        line_cmds.append(f"L {pts[i][0]:.1f} {pts[i - 1][1]:.1f}")
        line_cmds.append(f"L {pts[i][0]:.1f} {pts[i][1]:.1f}")
    line_path = " ".join(line_cmds)
    base_y = mt + ph
    area_path = f"{line_path} L {pts[-1][0]:.1f} {base_y:.1f} L {pts[0][0]:.1f} {base_y:.1f} Z"

    # x ticks: 5 evenly spaced dates
    xticks = []
    for i in range(5):
        frac = i / 4
        tt = datetime.fromtimestamp(t0 + span * frac, tz=timezone.utc)
        xticks.append((ml + frac * pw, tt.strftime("%Y-%m-%d")))

    grid_lines, y_labels = [], []
    for tk in ticks:
        y = py(tk)
        grid_lines.append(
            f'<line x1="{ml}" y1="{y:.1f}" x2="{ml + pw}" y2="{y:.1f}" '
            f'stroke="{c["grid"]}" stroke-width="1" stroke-dasharray="3 3"/>'
        )
        y_labels.append(
            f'<text x="{ml - 10}" y="{y + 4:.1f}" text-anchor="end" font-size="12" fill="{c["text"]}">{tk}</text>'
        )
    x_labels = []
    for x, lbl in xticks:
        x_labels.append(
            f'<text x="{x:.1f}" y="{mt + ph + 22}" text-anchor="middle" font-size="12" fill="{c["text"]}">{lbl}</text>'
        )

    lx, ly = pts[-1]
    grad = f"grad-{theme}"
    font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="{font}" role="img" aria-label="Star history chart for {repo}">
  <defs>
    <linearGradient id="{grad}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{c["fill_top"]}" stop-opacity="{c["fill_top_op"]}"/>
      <stop offset="100%" stop-color="{c["fill_bot"]}" stop-opacity="{c["fill_bot_op"]}"/>
    </linearGradient>
  </defs>
  <text x="{ml}" y="26" font-size="15" font-weight="600" fill="{c["text"]}">{repo} · star history</text>
  <line x1="{ml}" y1="{mt + ph}" x2="{ml + pw}" y2="{mt + ph}" stroke="{c["axis"]}" stroke-width="1.2"/>
  <line x1="{ml}" y1="{mt}" x2="{ml}" y2="{mt + ph}" stroke="{c["axis"]}" stroke-width="1.2"/>
  {"".join(grid_lines)}
  <path d="{area_path}" fill="url(#{grad})"/>
  <path d="{line_path}" fill="none" stroke="{c["line"]}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="{lx:.1f}" cy="{ly:.1f}" r="4.5" fill="{c["dot"]}"/>
  {"".join(y_labels)}
  {"".join(x_labels)}
</svg>
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--mock", help="path to JSON list of ISO timestamps (test)")
    args = ap.parse_args()

    if args.mock:
        with open(args.mock) as f:
            times = sorted(datetime.fromisoformat(s.replace("Z", "+00:00")) for s in json.load(f))
    else:
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        if not token:
            print("ERROR: GITHUB_TOKEN not set", file=sys.stderr)
            return 1
        try:
            times = fetch_stargazers(args.repo, token)
        except urllib.error.HTTPError as e:
            print(f"ERROR: GitHub API {e.code}: {e.read().decode()[:200]}", file=sys.stderr)
            return 1

    series = build_series(times)
    os.makedirs(args.out, exist_ok=True)
    for theme in ("light", "dark"):
        svg = render_svg(series, theme, args.repo)
        path = os.path.join(args.out, f"star-history-{theme}.svg")
        with open(path, "w") as f:
            f.write(svg)
        print(f"wrote {path} ({len(times)} stars)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
