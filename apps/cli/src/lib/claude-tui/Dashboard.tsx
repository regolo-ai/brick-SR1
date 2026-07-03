import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import {
  fetchSnapshot,
  fetchEconomics,
  resetMetrics,
  routedRowsByModel,
  nativeRowsByModel,
  difficultyDistribution,
  effortRowsForModel,
  unifyEconomy,
  totalRequests,
  classifierPercentiles,
  classifierMean,
  fallbackPct,
  formatLatency,
  type Snapshot,
  type EconomicsResponse,
} from '../claude/metrics.js';

const ACCENT = '#00d4aa';

// Fixed colour per model family so a model keeps the same hue across the stacked
// bar, the per-model bars and the legend. Matched by prefix so version bumps
// (sonnet-4-6 -> 4-7) don't need a new entry.
const MODEL_COLORS: Array<[string, string]> = [
  ['claude-haiku', '#7aa2f7'],
  ['claude-sonnet', '#bb9af7'],
  ['claude-opus', '#f7768e'],
  ['gpt-', '#7aa2f7'],
  ['o3', '#bb9af7'],
  ['o4', '#f7768e'],
];

function colorForModel(model: string): string {
  for (const [prefix, color] of MODEL_COLORS) {
    if (model.startsWith(prefix)) return color;
  }
  return ACCENT;
}

// Trims the trailing date stamp (e.g. claude-haiku-4-5-20251001 -> claude-haiku-4-5)
// so model names stay short enough not to wrap the dashboard rows.
function shortModel(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: 'green',
  medium: 'yellow',
  hard: 'red',
};

function colorForDifficulty(label: string): string {
  return DIFFICULTY_COLORS[label] ?? 'gray';
}

const EFFORT_COLORS: Record<string, string> = {
  low: 'gray',
  medium: 'cyan',
  high: 'green',
  xhigh: 'yellow',
  max: 'red',
};

function colorForEffort(effort: string): string {
  return EFFORT_COLORS[effort] ?? 'gray';
}

// Palette cycled by the shimmer banner: the dashboard's accent plus the three
// model hues, so the wave sweeps through every brand colour.
const SHIMMER_PALETTE = ['#00d4aa', '#7aa2f7', '#bb9af7', '#f7768e'];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

// Colour of one banner character: a palette gradient scrolling along the text,
// modulated by a travelling brightness wave (the "ultrathink" sweep). `pos` is
// the char index in [0,1), `phase` advances every animation frame.
function shimmerColorAt(pos: number, phase: number): string {
  // Gradient: map (pos + phase) onto the palette, interpolating between stops.
  const t = ((pos * 2 + phase) % 1 + 1) % 1;
  const scaled = t * SHIMMER_PALETTE.length;
  const i = Math.floor(scaled) % SHIMMER_PALETTE.length;
  const j = (i + 1) % SHIMMER_PALETTE.length;
  const f = scaled - Math.floor(scaled);
  const [r1, g1, b1] = hexToRgb(SHIMMER_PALETTE[i]);
  const [r2, g2, b2] = hexToRgb(SHIMMER_PALETTE[j]);
  let r = r1 + (r2 - r1) * f;
  let g = g1 + (g2 - g1) * f;
  let b = b1 + (b2 - b1) * f;
  // Brightness wave: a soft peak travelling left→right lifts a band to full,
  // the rest sits dimmed, giving the shimmer that runs along the text.
  const dist = Math.abs(((pos - phase) % 1 + 1) % 1 - 0.5); // 0 at the peak, 0.5 farthest
  const lift = 0.45 + 0.55 * (1 - dist / 0.5); // 0.45..1.0
  r *= lift; g *= lift; b *= lift;
  return rgbToHex(r, g, b);
}

// Full-width animated banner shown while Brick is live: a field of Braille dot
// matrices whose fill density ripples left→right while a colour wave sweeps the
// dashboard palette across them (the Claude Code "ultrathink" effect). Purely
// decorative, driven by its own ~12fps timer.
//
// Braille ramp from empty to full (each glyph is a 2x4 dot matrix), so the wave
// reads as dots lighting up and dying down rather than a flat bar.
const DOT_RAMP = ['⠀', '⢀', '⢠', '⢤', '⢴', '⢶', '⣶', '⣷', '⣿'];

function ShimmerBanner() {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPhase((p) => (p + 0.02) % 1), 100);
    return () => clearInterval(id);
  }, []);

  const cols = process.stdout.columns ?? 80;
  const inner = Math.max(20, Math.min(120, cols - 6));
  const label = ' brick is routing requests ';
  // Centre the phrase; the dot matrices fill the rest of the full-width banner.
  const pad = Math.max(0, Math.floor((inner - label.length) / 2));
  const leftLen = pad;
  const rightLen = Math.max(0, inner - pad - label.length);

  // A run of Braille dot cells whose density follows a travelling wave; `offset`
  // keeps the wave continuous across the left field, label gap and right field.
  const dotCell = (i: number, offset: number) => {
    const pos = (i + offset) / inner;
    // Distance from the moving wave crest → 0 at crest (full), 0.5 farthest (empty).
    const dist = Math.abs(((pos - phase) % 1 + 1) % 1 - 0.5);
    const level = Math.round((1 - dist / 0.5) * (DOT_RAMP.length - 1));
    return (
      <Text key={`d${offset}-${i}`} color={shimmerColorAt(pos, phase)}>
        {DOT_RAMP[Math.max(0, Math.min(DOT_RAMP.length - 1, level))]}
      </Text>
    );
  };

  const labelChars = [...label];
  return (
    <Box>
      <Text>
        {Array.from({ length: leftLen }, (_, i) => dotCell(i, 0))}
        {labelChars.map((ch, i) => (
          <Text key={`l${i}`} color={shimmerColorAt((leftLen + i) / inner, phase)} bold>
            {ch}
          </Text>
        ))}
        {Array.from({ length: rightLen }, (_, i) => dotCell(i, leftLen + label.length))}
      </Text>
    </Box>
  );
}

export interface DashboardProps {
  baseUrl: string;
  envUrl?: string;
  intervalMs: number;
  mode?: string;
  connectionLabel?: string;
  emptyRequestsLabel?: string;
  nativeLabel?: string;
  showEconomy?: boolean;
}

export function Dashboard({
  baseUrl,
  envUrl,
  intervalMs,
  mode,
  connectionLabel = 'ANTHROPIC_BASE_URL',
  emptyRequestsLabel = 'no /v1/messages requests served yet',
  nativeLabel = 'subagents (native model, router bypass)',
  showEconomy = true,
}: DashboardProps) {
  const { exit } = useApp();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [econ, setEcon] = useState<EconomicsResponse | null>(null);
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(true);
  // Single confirmation for clearing the routing cache: press `n` to arm, `n`
  // again to execute. Any other key cancels. `flash` shows the outcome.
  const [confirmClear, setConfirmClear] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  useInput((input, key) => {
    // Ctrl-C always exits, even mid-confirmation.
    if (key.ctrl && input === 'c') { exit(); return; }
    if (confirmClear) {
      if (input === 'n') {
        setConfirmClear(false);
        void (async () => {
          const ok = await resetMetrics(baseUrl);
          setFlash(ok ? '✓ routing cache cleared' : '✗ reset failed');
          setTick((t) => t + 1); // refresh immediately
          setTimeout(() => setFlash(null), 2500);
        })();
      } else {
        setConfirmClear(false); // any other key cancels
      }
      return;
    }
    if (input === 'q' || key.escape) { exit(); return; }
    if (input === 'r') setTick((t) => t + 1); // manual refresh
    if (input === 'n') { setFlash(null); setConfirmClear(true); } // arm clear-cache
  });

  useEffect(() => {
    let alive = true;
    const run = async () => {
      const [s, e] = await Promise.all([fetchSnapshot(baseUrl, envUrl), fetchEconomics(baseUrl)]);
      if (alive) { setSnap(s); setEcon(e); setLoading(false); }
    };
    run();
    const id = setInterval(run, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [baseUrl, envUrl, intervalMs, tick]);

  return (
    <Box flexDirection="column" paddingX={1}>
      <RoutingBox snap={snap} emptyRequestsLabel={emptyRequestsLabel} nativeLabel={nativeLabel} />
      <EconomyBox snap={snap} econ={econ} enabled={showEconomy} />
      <ConnectionBox snap={snap} loading={loading} mode={mode} connectionLabel={connectionLabel} />
      <ClassifierBox snap={snap} />

      <Box marginTop={1}>
        {confirmClear ? (
          <Text color="yellow" bold>
            Clear routing cache? Press <Text color="red" bold>n</Text> to confirm · any other key cancels
          </Text>
        ) : flash ? (
          <Text color={flash.startsWith('✓') ? 'green' : 'red'} bold>{flash}</Text>
        ) : (
          <Text dimColor>{`↻ ${(intervalMs / 1000).toFixed(0)}s  ·  r refresh  ·  n clear cache  ·  q quit`}</Text>
        )}
      </Box>
    </Box>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Box width={20}><Text dimColor>{label}</Text></Box>
      <Text>{children}</Text>
    </Box>
  );
}

function ConnectionBox({
  snap,
  loading,
  mode,
  connectionLabel,
}: {
  snap: Snapshot | null;
  loading: boolean;
  mode?: string;
  connectionLabel: string;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginTop={1}>
      <Text color={ACCENT} bold>Connection</Text>
      {loading && !snap ? (
        <Text dimColor>probing…</Text>
      ) : (
        <>
          <Row label={connectionLabel}>
            {snap?.envUrl ? (
              snap.attached ? <Text color="green">{snap.envUrl} ✓ attached</Text>
                : <Text color="yellow">{snap.envUrl} ✗ not pointing at this router</Text>
            ) : <Text dimColor>(not set)</Text>}
          </Row>
          <Row label="brick router">
            <Text color={snap?.health ? 'green' : 'red'}>
              {snap?.baseUrl} {snap?.health ? '✓ healthy' : '✗ unreachable'}
            </Text>
          </Row>
          {mode && (
            <Row label="mode"><Text color={ACCENT} bold>{mode}</Text></Row>
          )}
        </>
      )}
    </Box>
  );
}

function ClassifierBox({ snap }: { snap: Snapshot | null }) {
  const d = snap?.diag;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
      <Text color={ACCENT} bold>◆ Classifier</Text>
      {!d ? (
        <Text dimColor>no diagnostics</Text>
      ) : !d.enabled ? (
        <Text dimColor>disabled in config</Text>
      ) : d.reachable ? (
        <Row label="status">
          <Text color="green">✓ healthy</Text>
          <Text dimColor>{`  ${d.device ?? '?'} · last ${d.latency_ms ?? '?'}ms · ${d.endpoint ?? ''}`}</Text>
        </Row>
      ) : (
        <Row label="status"><Text color="red">{`✗ unreachable${d.error ? ` — ${d.error}` : ''}`}</Text></Row>
      )}
    </Box>
  );
}

function RoutingBox({
  snap,
  emptyRequestsLabel,
  nativeLabel,
}: {
  snap: Snapshot | null;
  emptyRequestsLabel: string;
  nativeLabel: string;
}) {
  const m = snap?.metrics;
  if (snap?.health && !m) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginTop={1}>
        <Text color={ACCENT} bold>◆ Routing</Text>
        <Text dimColor>metrics endpoint not reachable (port 9190/19190)</Text>
      </Box>
    );
  }
  if (!m) return null;

  const total = totalRequests(m);
  const routed = routedRowsByModel(m);
  const native = nativeRowsByModel(m);
  const difficulty = difficultyDistribution(m);
  const mean = classifierMean(m);
  const { p50, p95 } = classifierPercentiles(m);
  const fb = fallbackPct(m);
  const fbColor = fb > 5 ? 'red' : fb > 1 ? 'yellow' : 'green';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginTop={1}>
      <Text color={ACCENT} bold>◆ Routing</Text>
      {total === 0 ? (
        <Text dimColor>{emptyRequestsLabel}</Text>
      ) : (
        <>
          <Row label="total requests"><Text bold>{String(total)}</Text></Row>
          <Text> </Text>
          <ShimmerBanner />
          <Text> </Text>
          <Text dimColor>routed by model</Text>
          {routed.length > 0 && (
            <>
              <Box marginBottom={1}>
                <StackedBar segments={routed.map((r) => ({ pct: r.pct, color: colorForModel(r.model) }))} />
              </Box>
              <Box>
                <Legend items={routed.map((r) => ({ label: shortModel(r.model), color: colorForModel(r.model), pct: r.pct }))} />
              </Box>
            </>
          )}
          {routed.map((r) => {
            const efforts = effortRowsForModel(m, r.model);
            return (
              <Box key={`routed|${r.model}`} flexDirection="column" marginTop={1}>
                <Box>
                  <Box width={22} flexShrink={0}><Text color={colorForModel(r.model)} bold>{shortModel(r.model)}</Text></Box>
                  <ColoredBar pct={r.pct} color={colorForModel(r.model)} />
                  <Text>{`  ${r.count} (${r.pct.toFixed(0)}%)`}</Text>
                </Box>
                {efforts.map((e) => (
                  <Box key={`eff|${r.model}|${e.label}`} paddingLeft={2}>
                    <Box width={20} flexShrink={0}><Text color={colorForEffort(e.label)} dimColor>{`└ ${e.label}`}</Text></Box>
                    <ColoredBar pct={e.pct} color={colorForEffort(e.label)} width={10} />
                    <Text dimColor>{`  ${e.count} (${e.pct.toFixed(0)}%)`}</Text>
                  </Box>
                ))}
              </Box>
            );
          })}
          {native.length > 0 && (
            <>
              <Text> </Text>
              <Text dimColor>{nativeLabel}</Text>
              {native.map((r) => (
                <Box key={`native|${r.model}`} paddingLeft={2}>
                  <Box width={22}><Text dimColor>{shortModel(r.model)}</Text></Box>
                  <ColoredBar pct={r.pct} color="gray" />
                  <Text dimColor>{`  ${r.count} (${r.pct.toFixed(0)}%)`}</Text>
                </Box>
              ))}
            </>
          )}
          {difficulty.length > 0 && (
            <>
              <Text> </Text>
              <Text dimColor>difficulty mix (routed only)</Text>
              <Box>
                <StackedBar segments={difficulty.map((r) => ({ pct: r.pct, color: colorForDifficulty(r.label) }))} />
              </Box>
              <Box>
                <Legend items={difficulty.map((r) => ({ label: r.label, color: colorForDifficulty(r.label), pct: r.pct }))} />
              </Box>
            </>
          )}
          <Text> </Text>
          {mean !== null && p50 !== null && p95 !== null && (
            <Row label="classifier latency">{`avg ${formatLatency(mean)} · p50 ${formatLatency(p50)} · p95 ${formatLatency(p95)}`}</Row>
          )}
          <Row label="fallback rate">
            <Text color={fbColor}>{`${fb.toFixed(1)}% (${m.fallbackTotal})`}</Text>
          </Row>
        </>
      )}
    </Box>
  );
}

function EconomyBox({
  snap,
  econ,
  enabled,
}: {
  snap: Snapshot | null;
  econ: EconomicsResponse | null;
  enabled: boolean;
}) {
  if (!enabled) return null;
  const m = snap?.metrics;
  if (!m) return null;
  const ue = unifyEconomy(econ, m);
  const hasData = ue.source === 'real' || (ue.totalRoutedReqs ?? 0) > 0;
  if (!hasData) return null;

  const spentPct = Math.max(0, Math.min(100, 100 - ue.savedPct));
  const savedColor = ue.savedPct > 50 ? 'green' : ue.savedPct > 20 ? 'yellow' : 'gray';
  const baselineLabel = ue.source === 'real' ? `all-${ue.mostExpensiveModel}` : 'all-opus';
  // Show the opus-anchored line only when the primary baseline is a pricier
  // model than opus (e.g. Fable); when opus already IS the most expensive
  // model the router returns an equal figure, so the extra row is redundant.
  const showVsOpus =
    ue.source === 'real' &&
    ue.savedPctVsOpus !== undefined &&
    !(ue.mostExpensiveModel ?? '').includes('opus');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginTop={1}>
      <Text color={ACCENT} bold>◆ Economy</Text>
      <Text dimColor>{`spent vs ${baselineLabel} baseline`}</Text>
      <Box>
        <StackedBar
          segments={[
            { pct: spentPct, color: 'green' },
            { pct: Math.max(0, 100 - spentPct), color: 'gray' },
          ]}
        />
        <Text>{'  '}</Text>
        <Text color={savedColor} bold>{`saved ${ue.savedPct.toFixed(0)}%`}</Text>
      </Box>
      {ue.source === 'real' ? (
        <>
          <Text dimColor>{`~${ue.savedPct.toFixed(0)}% cheaper than ${baselineLabel} (real token counts, cache-aware)`}</Text>
          {showVsOpus && (
            <Text dimColor>{`~${ue.savedPctVsOpus!.toFixed(0)}% cheaper than all-opus`}</Text>
          )}
          <Text dimColor>{`tokens: ${ue.totalInputTokens?.toLocaleString()} in + ${((ue.totalCacheReadTokens ?? 0) + (ue.totalCacheCreationTokens ?? 0)).toLocaleString()} cache / ${ue.totalOutputTokens?.toLocaleString()} out`}</Text>
        </>
      ) : (
        <>
          <Text dimColor>{`${ue.totalRoutedReqs} routed reqs · ~${ue.savedPct.toFixed(0)}% cheaper than all-opus (estimate)`}</Text>
          <Text dimColor>relative estimate from request mix; excludes real token counts &amp; caching</Text>
        </>
      )}
    </Box>
  );
}

function ColoredBar({ pct, color = ACCENT, width = 16 }: { pct: number; color?: string; width?: number }) {
  const filled = Math.round((pct / 100) * width);
  return (
    <Text color={color}>
      {'█'.repeat(filled)}
      <Text dimColor>{'░'.repeat(Math.max(0, width - filled))}</Text>
    </Text>
  );
}

// Splits a bar of `width` cells across segments proportional to their pct,
// using largest-remainder rounding so the cell counts always sum to exactly
// `width` (no drift, no overflow). Pure + exported so it can be unit-tested
// without rendering Ink.
export function stackedWidths(pcts: number[], width: number): number[] {
  const raw = pcts.map((p) => (p / 100) * width);
  const counts = raw.map((r) => Math.floor(r));
  let used = counts.reduce((a, c) => a + c, 0);
  const byRemainder = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; used < width && k < byRemainder.length; k++, used++) {
    counts[byRemainder[k].i] += 1;
  }
  return counts;
}

// "Pie chart for the terminal": a single fixed-width bar split into coloured
// segments whose lengths are proportional to each segment's pct.
function StackedBar({ segments, width = 28 }: { segments: Array<{ pct: number; color: string }>; width?: number }) {
  const widths = stackedWidths(segments.map((s) => s.pct), width);
  return (
    <Text>
      {segments.map((s, i) => (
        <Text key={i} color={s.color}>{'█'.repeat(widths[i])}</Text>
      ))}
    </Text>
  );
}

function Legend({ items, hidePct }: { items: Array<{ label: string; color: string; pct: number }>; hidePct?: boolean }) {
  return (
    <Box flexWrap="wrap">
      {items.map((it, i) => (
        <Box key={i} marginRight={2}>
          <Text color={it.color}>■ </Text>
          <Text dimColor>{hidePct ? it.label : `${it.label} ${it.pct.toFixed(0)}%`}</Text>
        </Box>
      ))}
    </Box>
  );
}
