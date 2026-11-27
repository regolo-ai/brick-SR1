#!/usr/bin/env python3
"""T3-01b: Genera HTML interattivo per manual review.

Output: data/reports/quality/sample_review.html — apri in browser, clicca le label per ogni
sample, alla fine clicca "Download CSV" → salva sample_review.csv compilato.
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.io_utils import data_dir

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Dataset A — Manual Review (Tier 3)</title>
<style>
  :root {
    --bg: #fafafa;
    --card: #ffffff;
    --border: #e0e0e0;
    --primary: #2563eb;
    --ok: #16a34a;
    --low: #ca8a04;
    --amb: #9333ea;
    --bad: #dc2626;
    --text: #1f2937;
    --muted: #6b7280;
  }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 20px; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .meta { color: var(--muted); font-size: 14px; margin-bottom: 18px; }
  .progress { position: sticky; top: 0; background: var(--bg); padding: 10px 0; z-index: 10; border-bottom: 1px solid var(--border); margin-bottom: 14px; }
  .bar { width: 100%; height: 6px; background: #e5e7eb; border-radius: 3px; overflow: hidden; }
  .bar > div { height: 100%; background: var(--primary); transition: width 0.3s; }
  .stats { display: flex; gap: 14px; font-size: 13px; margin-top: 6px; }
  .stat { display: flex; align-items: center; gap: 4px; }
  .stat-dot { width: 10px; height: 10px; border-radius: 50%; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 14px; }
  .card.done { border-color: #d1fae5; background: #f0fdf4; }
  .row-meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: 12px; color: var(--muted); margin-bottom: 10px; }
  .chip { background: #f3f4f6; padding: 3px 8px; border-radius: 4px; }
  .query { background: #f9fafb; border-left: 3px solid var(--primary); padding: 10px 12px; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; white-space: pre-wrap; word-break: break-word; max-height: 280px; overflow-y: auto; margin-bottom: 8px; }
  .expected { font-size: 12px; color: var(--muted); padding: 8px 10px; background: #fefce8; border-left: 3px solid #eab308; margin-bottom: 12px; word-break: break-word; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .btn { border: 1px solid var(--border); background: white; padding: 6px 14px; border-radius: 6px; font-size: 14px; cursor: pointer; transition: all 0.15s; }
  .btn:hover { transform: translateY(-1px); box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .btn.selected.ok { background: var(--ok); color: white; border-color: var(--ok); }
  .btn.selected.low_quality { background: var(--low); color: white; border-color: var(--low); }
  .btn.selected.ambiguous { background: var(--amb); color: white; border-color: var(--amb); }
  .btn.selected.broken { background: var(--bad); color: white; border-color: var(--bad); }
  .notes { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; margin-top: 8px; font-size: 13px; font-family: inherit; }
  .toolbar { position: fixed; bottom: 20px; right: 20px; background: white; padding: 10px 14px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); display: flex; gap: 8px; align-items: center; }
  .download { background: var(--primary); color: white; border: none; padding: 8px 16px; border-radius: 6px; font-size: 14px; cursor: pointer; font-weight: 600; }
  .download:disabled { background: #d1d5db; cursor: not-allowed; }
  details summary { cursor: pointer; font-size: 13px; color: var(--muted); }
  .legend { display: flex; gap: 12px; margin: 8px 0; font-size: 12px; flex-wrap: wrap; }
  .legend-item { display: flex; gap: 4px; align-items: center; }
</style>
</head>
<body>

<h1>Dataset A — Manual Review</h1>
<div class="meta">__N__ sample stratified per dimension × source × length_band. Clicca un'etichetta per ogni riga, poi "Download CSV".</div>

<div class="legend">
  <div class="legend-item"><span class="btn ok selected" style="font-size:10px;padding:2px 6px;">ok</span> ok = senso compiuto + expected coerente</div>
  <div class="legend-item"><span class="btn low_quality selected" style="font-size:10px;padding:2px 6px;">low_quality</span> low_quality = ambiguous/truncated ma riconoscibile</div>
  <div class="legend-item"><span class="btn ambiguous selected" style="font-size:10px;padding:2px 6px;">ambiguous</span> ambiguous = non chiaro cosa chiede</div>
  <div class="legend-item"><span class="btn broken selected" style="font-size:10px;padding:2px 6px;">broken</span> broken = rotto/fuori topic</div>
</div>

<div class="progress">
  <div class="bar"><div id="pbar" style="width: 0%;"></div></div>
  <div class="stats">
    <span class="stat" id="s-progress">0 / __N__</span>
    <span class="stat"><span class="stat-dot" style="background: var(--ok)"></span><span id="s-ok">0</span> ok</span>
    <span class="stat"><span class="stat-dot" style="background: var(--low)"></span><span id="s-low">0</span> low</span>
    <span class="stat"><span class="stat-dot" style="background: var(--amb)"></span><span id="s-amb">0</span> amb</span>
    <span class="stat"><span class="stat-dot" style="background: var(--bad)"></span><span id="s-bad">0</span> broken</span>
  </div>
</div>

<div id="cards"></div>

<div class="toolbar">
  <span id="counter">0 / __N__</span>
  <button class="download" id="dl-btn" disabled>Download CSV</button>
</div>

<script>
const ROWS = __ROWS_JSON__;
const STATE = {};  // query_id -> {label, notes}

function escape(s) { return String(s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }

function render() {
  const c = document.getElementById('cards');
  c.innerHTML = '';
  ROWS.forEach((r, i) => {
    const st = STATE[r.query_id] || {};
    const card = document.createElement('div');
    card.className = 'card' + (st.label ? ' done' : '');
    card.innerHTML = `
      <div class="row-meta">
        <span class="chip">#${i+1}/${ROWS.length}</span>
        <span class="chip"><b>${r.query_id}</b></span>
        <span class="chip">${r.dimension}</span>
        <span class="chip">${r.source}</span>
        <span class="chip">${r.length_band} (${r.shots}-shot)</span>
        <span class="chip">expected: ${r.expected_type}</span>
      </div>
      <div class="query">${escape(r.actual_query)}</div>
      <details>
        <summary>Expected answer</summary>
        <div class="expected">${escape(r.expected_summary)}</div>
      </details>
      <div class="actions">
        ${['ok','low_quality','ambiguous','broken'].map(l =>
          `<button class="btn ${l}${st.label===l?' selected':''}" data-id="${r.query_id}" data-label="${l}">${l}</button>`
        ).join('')}
        <input class="notes" data-id="${r.query_id}" placeholder="notes (optional)" value="${escape(st.notes||'')}">
      </div>
    `;
    c.appendChild(card);
  });
  bindEvents();
  updateStats();
}

function bindEvents() {
  document.querySelectorAll('.btn[data-label]').forEach(b => {
    b.onclick = () => {
      const id = b.dataset.id;
      STATE[id] = STATE[id] || {};
      STATE[id].label = b.dataset.label;
      saveLocal();
      render();
    };
  });
  document.querySelectorAll('.notes[data-id]').forEach(n => {
    n.oninput = () => {
      const id = n.dataset.id;
      STATE[id] = STATE[id] || {};
      STATE[id].notes = n.value;
      saveLocal();
    };
  });
}

function updateStats() {
  const total = ROWS.length;
  let done = 0, ok=0, low=0, amb=0, bad=0;
  Object.values(STATE).forEach(s => {
    if (!s.label) return;
    done++;
    if (s.label==='ok') ok++;
    else if (s.label==='low_quality') low++;
    else if (s.label==='ambiguous') amb++;
    else if (s.label==='broken') bad++;
  });
  document.getElementById('pbar').style.width = (done/total*100) + '%';
  document.getElementById('s-progress').textContent = `${done} / ${total}`;
  document.getElementById('counter').textContent = `${done} / ${total}`;
  document.getElementById('s-ok').textContent = ok;
  document.getElementById('s-low').textContent = low;
  document.getElementById('s-amb').textContent = amb;
  document.getElementById('s-bad').textContent = bad;
  document.getElementById('dl-btn').disabled = (done < total);
}

function saveLocal() {
  localStorage.setItem('datasetA_review', JSON.stringify(STATE));
}

function loadLocal() {
  const s = localStorage.getItem('datasetA_review');
  if (s) Object.assign(STATE, JSON.parse(s));
}

function csvEscape(s) {
  s = String(s||'');
  if (s.includes(',') || s.includes('"') || s.includes('\\n')) {
    return '"' + s.replaceAll('"', '""') + '"';
  }
  return s;
}

function downloadCSV() {
  const headers = ['query_id','dimension','source','length_band','shots','expected_type','expected_summary','actual_query','reviewer1_label','reviewer1_notes','reviewer2_label','reviewer2_notes'];
  const lines = [headers.join(',')];
  ROWS.forEach(r => {
    const st = STATE[r.query_id] || {};
    lines.push([
      r.query_id, r.dimension, r.source, r.length_band, r.shots,
      r.expected_type, r.expected_summary, r.actual_query,
      st.label || '', st.notes || '', '', ''
    ].map(csvEscape).join(','));
  });
  const blob = new Blob([lines.join('\\n')], {type: 'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'sample_review.csv';
  a.click();
}

document.getElementById('dl-btn').onclick = downloadCSV;
loadLocal();
render();
</script>
</body>
</html>
"""


def main():
    csv_path = data_dir("reports", "quality") / "sample_review.csv"
    if not csv_path.exists():
        print(f"missing {csv_path} — run scripts/quality/t3_01_sample_review.py first")
        sys.exit(1)

    rows = list(csv.DictReader(open(csv_path)))
    # Build clean rows for HTML
    clean = []
    for r in rows:
        clean.append(
            {
                "query_id": r["query_id"],
                "dimension": r["dimension"],
                "source": r["source"],
                "length_band": r["length_band"],
                "shots": r["shots"],
                "expected_type": r["expected_type"],
                "expected_summary": r["expected_summary"][:600],
                "actual_query": r["actual_query_truncated"],
            }
        )

    html_out = HTML_TEMPLATE.replace("__N__", str(len(clean))).replace(
        "__ROWS_JSON__", json.dumps(clean, ensure_ascii=False)
    )
    out_path = data_dir("reports", "quality") / "sample_review.html"
    out_path.write_text(html_out, encoding="utf-8")
    print(f"saved {len(clean)} rows → {out_path}")
    print(f"\nApri in browser: file://{out_path}")
    print("\nWorkflow:")
    print("  1. Apri il file HTML nel browser (doppio click)")
    print("  2. Per ogni sample clicca una label (ok/low_quality/ambiguous/broken)")
    print("  3. Quando 57/57 done, click 'Download CSV' (in basso destra)")
    print("  4. Sposta il CSV scaricato in:")
    print(f"     {data_dir('reports', 'quality')}/sample_review.csv")
    print("  5. Esegui: PYTHONPATH=src python3 scripts/quality/t3_02_kappa_calc.py")


if __name__ == "__main__":
    main()
