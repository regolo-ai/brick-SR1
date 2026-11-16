import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import {
  fetchSnapshot,
  fetchEconomics,
  resetMetrics,
  unifyEconomy,
  totalRequests,
  routedRowsByModel,
  nativeRowsByModel,
  effortRowsForModel,
  routingLatency,
  fallbackPct,
  formatLatency,
  type Snapshot,
  type EconomicsResponse,
} from '../claude/metrics.js';
import { ACCENT, assignModelColors, colorForModel, colorForMode, shortModel } from '../ui/model-colors.js';
import { planLayout, type DashboardMode } from './layout.js';

// Palette cycled by the shimmer banner: the dashboard's accent plus the model
// hues, so the wave sweeps through every brand colour.
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
  attached?: boolean;
  intervalMs: number;
  mode?: string;
  connectionLabel?: string;
  disconnectedLabel?: string;
  unattachedLabel?: string;
  emptyRequestsLabel?: string;
  nativeLabel?: string;
  showEconomy?: boolean;
  economyBaselineModel?: string;
  models?: Array<{ provider: string; model: string }>;
}

export function Dashboard({
  baseUrl,
  envUrl,
  attached,
  intervalMs,
  mode,
  connectionLabel = 'ANTHROPIC_BASE_URL',
  disconnectedLabel = '(not set)',
  unattachedLabel = 'not pointing at this router',
  emptyRequestsLabel = 'no /v1/messages requests served yet',
  nativeLabel = 'subagents (native model, router bypass)',
  showEconomy = true,
  economyBaselineModel,
  models,
}: DashboardProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [econ, setEcon] = useState<EconomicsResponse | null>(null);
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [, setResizeTick] = useState(0);
  // Single confirmation for clearing the persistent call history: press `n` to
  // arm, `n` again to execute. Any other key cancels. `flash` shows the outcome.
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
          setFlash(ok ? '✓ call history cleared' : '✗ clear failed');
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
    if (input === 'n') { setFlash(null); setConfirmClear(true); } // arm clear-history
  });

  // Re-plan the layout when the terminal is resized, otherwise a window shrink
  // leaves a frame taller than the viewport until the next data tick.
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setResizeTick((value) => value + 1);
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      const [s, e] = await Promise.all([fetchSnapshot(baseUrl, envUrl, attached), fetchEconomics(baseUrl, economyBaselineModel)]);
      if (alive) { setSnap(s); setEcon(e); setLoading(false); }
    };
    run();
    const id = setInterval(run, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [baseUrl, envUrl, attached, intervalMs, tick, economyBaselineModel]);

  // Ink always draws at the bottom of the terminal, so a frame taller than the
  // viewport scrolls on every refresh and undoes the user's scroll-up. The plan
  // keeps the report inside `rows`, dropping sections by priority when short.
  const stats = snap?.stats ?? null;
  const routedModels = stats ? routedRowsByModel(stats) : [];
  const nativeModels = stats ? nativeRowsByModel(stats) : [];
  const modeRows = stats ? routedModels.reduce((sum, row) => sum + effortRowsForModel(stats, row.model).length, 0) : 0;
  // One shared assignment for every model we might draw, so the stacked bar,
  // the legend, the pool line and the per-model rows always agree.
  const colors = assignModelColors([
    ...(models ?? []).map((entry) => entry.model),
    ...(stats?.models ?? []).map((entry) => entry.model),
  ]);
  const layout = planLayout({
    rows: stdout?.rows ?? process.stdout.rows ?? 40,
    models: routedModels.length || 1,
    modes: modeRows,
    nativeModels: nativeModels.length,
    economyAvailable: econ?.pricing_available === true,
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      {layout.mode === 'micro' ? (
        <MicroSummary snap={snap} emptyRequestsLabel={emptyRequestsLabel} colors={colors} />
      ) : (
        <>
          <RoutingBox snap={snap} emptyRequestsLabel={emptyRequestsLabel} nativeLabel={nativeLabel} mode={layout.mode} legend={layout.legend} colors={colors} />
          {layout.pool && <ModelsPoolBox models={models} compact={layout.mode !== 'full'} colors={colors} />}
          {layout.economy && <EconomyBox snap={snap} econ={econ} enabled={showEconomy} baselineModel={economyBaselineModel} compact={layout.mode !== 'full'} />}
          {layout.connection && <ConnectionBox snap={snap} loading={loading} mode={mode} connectionLabel={connectionLabel} disconnectedLabel={disconnectedLabel} unattachedLabel={unattachedLabel} compact={layout.mode !== 'full'} />}
          {layout.systemOne && <SystemOneBox snap={snap} compact={layout.mode !== 'full'} />}
        </>
      )}

      <Box marginTop={1}>
        {confirmClear ? (
          <Text color="yellow" bold>
            Clear call history? Press <Text color="red" bold>n</Text> to confirm · any other key cancels
          </Text>
        ) : flash ? (
          <Text color={flash.startsWith('✓') ? 'green' : 'red'} bold>{flash}</Text>
        ) : (
          <Text dimColor>{`↻ ${(intervalMs / 1000).toFixed(0)}s  ·  r refresh  ·  n clear history  ·  q quit`}</Text>
        )}
      </Box>
    </Box>
  );
}

/** Borderless summary for terminals too short for any box. */
function MicroSummary({ snap, emptyRequestsLabel, colors }: { snap: Snapshot | null; emptyRequestsLabel: string; colors: Map<string, string> }) {
  const colorOf = (model: string) => colors.get(model) ?? colorForModel(model);
  const s = snap?.stats;
  if (!s || totalRequests(s) === 0) {
    return (
      <Box>
        <Text color={ACCENT} bold>◆ Routing</Text>
        <Text dimColor>{`  ${emptyRequestsLabel}`}</Text>
      </Box>
    );
  }
  const routed = routedRowsByModel(s);
  const total = totalRequests(s);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={ACCENT} bold>◆ Routing </Text>
        <Text bold>{String(total)}</Text>
        <Text dimColor>{` · ${s.overall.completed_calls} completed`}</Text>
        {s.overall.failed_calls > 0 && <Text color="red">{` · ${s.overall.failed_calls} failed`}</Text>}
      </Box>
      <Box marginTop={0}>
        <StackedBar segments={routed.map((r) => ({ pct: r.pct, color: colorOf(r.model) }))} width={Math.max(8, (process.stdout.columns ?? 40) - 12)} />
      </Box>
      <Box flexWrap="wrap">
        {routed.map((r) => (
          <Box key={`micro|${r.model}`} marginRight={2}>
            <Text color={colorOf(r.model)}>■ </Text>
            <Text color={colorOf(r.model)} bold>{shortModel(r.model)}</Text>
            <Text dimColor>{` ${r.count}`}</Text>
          </Box>
        ))}
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
  disconnectedLabel,
  unattachedLabel,
  compact,
}: {
  snap: Snapshot | null;
  loading: boolean;
  mode?: string;
  connectionLabel: string;
  disconnectedLabel: string;
  unattachedLabel: string;
  compact?: boolean;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginTop={compact ? 0 : 1}>
      <Text color={ACCENT} bold>Connection</Text>
      {loading && !snap ? (
        <Text dimColor>probing…</Text>
      ) : (
        <>
          <Row label={connectionLabel}>
            {snap?.envUrl ? (
              snap.attached ? <Text color="green">{snap.envUrl} ✓ attached</Text>
                : <Text color="yellow">{snap.envUrl} ✗ {unattachedLabel}</Text>
            ) : <Text color="yellow">{disconnectedLabel}</Text>}
          </Row>
          <Row label="brick router">
            <Text color={snap?.health ? 'green' : 'red'}>
              {snap?.baseUrl} {snap?.health ? '✓ healthy' : '✗ unavailable'}
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

function ModelsPoolBox({ models, compact, colors }: { models?: Array<{ provider: string; model: string }>; compact?: boolean; colors: Map<string, string> }) {
  const items = (models ?? []).map((m) => (
    <Box key={`${m.provider}:${m.model}`} marginRight={2}>
      <Text dimColor>{`${m.provider} › `}</Text>
      <Text color={colors.get(m.model) ?? colorForModel(m.model)} bold>{shortModel(m.model)}</Text>
    </Box>
  ));
  if (compact) {
    return (
      <Box paddingX={1}>
        <Text color={ACCENT} bold>{'◆ pool  '}</Text>
        {items.length > 0 ? <Box flexWrap="wrap">{items}</Box> : <Text dimColor>no models selected</Text>}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginTop={1}>
      <Text color={ACCENT} bold>◆ Models Pool</Text>
      {items.length > 0 ? (
        <Box flexWrap="wrap">{items}</Box>
      ) : (
        <Text dimColor>no models selected</Text>
      )}
    </Box>
  );
}

function SystemOneBox({ snap, compact }: { snap: Snapshot | null; compact?: boolean }) {
  const d = snap?.diag;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={compact ? 0 : 1}>
      <Text color={ACCENT} bold>◆ SystemOne</Text>
      {!d ? (
        <Text dimColor>no diagnostics</Text>
      ) : !d.enabled ? (
        <Text dimColor>disabled in config</Text>
      ) : d.ready ? (
        <Row label="status">
          <Text color="green">✓ healthy</Text>
          <Text dimColor>{`  ${d.engine ?? 'pytorch-transformers'} · ${d.device ?? 'local'}${d.dtype ? ` · ${d.dtype.replace('torch.', '')}` : ''}${d.threads ? ` · ${d.threads} threads` : ''}${d.max_tokens ? ` · ${d.max_tokens} tok` : ''}`}</Text>
        </Row>
      ) : (
        <Row label="status"><Text color="red">{`✗ unavailable${d.error ? ` — ${d.error}` : ''}`}</Text></Row>
      )}
    </Box>
  );
}

function RoutingBox({
  snap,
  emptyRequestsLabel,
  nativeLabel,
  mode,
  legend,
  colors,
}: {
  snap: Snapshot | null;
  emptyRequestsLabel: string;
  nativeLabel: string;
  mode: DashboardMode;
  legend: boolean;
  colors: Map<string, string>;
}) {
  const compact = mode !== 'full';
  const colorOf = (model: string) => colors.get(model) ?? colorForModel(model);
  const s = snap?.stats;
  if (snap?.health && !s) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginTop={1}>
        <Text color={ACCENT} bold>◆ Routing</Text>
        <Text dimColor>stats API not reachable</Text>
      </Box>
    );
  }
  if (!s) return null;

  const total = totalRequests(s);
  if (total === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginTop={1}>
        <Text color={ACCENT} bold>◆ Routing</Text>
        <Text dimColor>{emptyRequestsLabel}</Text>
      </Box>
    );
  }

  const routed = routedRowsByModel(s);
  const native = nativeRowsByModel(s);
  const lat = routingLatency(s);
  const fallback = fallbackPct(s);
  const fallbackColor = fallback > 5 ? 'red' : fallback > 1 ? 'yellow' : 'green';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginTop={1}>
      <Text color={ACCENT} bold>◆ Routing</Text>
      <Row label="total requests">
        <Text bold>{String(total)}</Text>
        <Text dimColor>{` · ${s.overall.completed_calls} completed`}</Text>
        <Text color={s.overall.failed_calls > 0 ? 'red' : undefined}>{` · ${s.overall.failed_calls} failed`}</Text>
      </Row>
      {!compact && (
        <>
          <Text> </Text>
          <ShimmerBanner />
          <Text> </Text>
        </>
      )}
      {routed.length > 0 && (
        <>
          {!compact && <Text dimColor>routed by model</Text>}
          <Box marginBottom={compact ? 0 : 1}>
            <StackedBar segments={routed.map((r) => ({ pct: r.pct, color: colorOf(r.model) }))} />
          </Box>
          {legend && (
            <Box>
              <Legend items={routed.map((r) => ({ label: shortModel(r.model), color: colorOf(r.model), pct: r.pct }))} />
            </Box>
          )}
        </>
      )}
      {routed.map((r) => {
        const modes = effortRowsForModel(s, r.model);
        const modeSummary = modes.map((e) => `${e.label} ${e.count}`).join(' · ');
        return (
          <Box key={`routed|${r.model}`} flexDirection="column" marginTop={compact ? 0 : 1}>
            <Box>
              <Box width={22} flexShrink={0}><Text color={colorOf(r.model)} bold>{shortModel(r.model)}</Text></Box>
              <ColoredBar pct={r.pct} color={colorOf(r.model)} />
              <Text>{`  ${r.count} (${r.pct.toFixed(0)}%)`}</Text>
              {compact && modeSummary !== '' && <Text dimColor>{`  ${modeSummary}`}</Text>}
            </Box>
            {!compact && modes.map((e) => (
              <Box key={`mode|${r.model}|${e.label}`} paddingLeft={2}>
                <Box width={20} flexShrink={0}><Text color={colorForMode(colorOf(r.model), e.label)}>{`└ ${e.label}`}</Text></Box>
                <ColoredBar pct={e.pct} color={colorForMode(colorOf(r.model), e.label)} width={10} />
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
      <Text> </Text>
      {lat.mean !== null && lat.p50 !== null && lat.p95 !== null && (
        <Row label="routing latency">{`avg ${formatLatency(lat.mean)} · p50 ${formatLatency(lat.p50)} · p95 ${formatLatency(lat.p95)}`}</Row>
      )}
      <Row label="fallback rate">
        <Text color={fallbackColor}>{`${fallback.toFixed(1)}% (${s.overall.failed_calls} failed of ${total})`}</Text>
      </Row>
    </Box>
  );
}

function EconomyBox({
  snap,
  econ,
  enabled,
  baselineModel,
  compact,
}: {
  snap: Snapshot | null;
  econ: EconomicsResponse | null;
  enabled: boolean;
  baselineModel?: string;
  compact?: boolean;
}) {
  if (!enabled) return null;
  const stats = snap?.stats;
  if (!stats && !econ && !baselineModel) return null;
  const ue = unifyEconomy(econ, stats ?? {
    overall: { calls: 0, completed_calls: 0, failed_calls: 0 }, models: [],
  }, baselineModel);
  const hasData = ue.source === 'real' || ue.source === 'unavailable' || (ue.totalRoutedReqs ?? 0) > 0;
  if (!hasData) return null;

  const spentPct = Math.max(0, Math.min(100, 100 - ue.savedPct));
  const savedColor = ue.savedPct > 50 ? 'green' : ue.savedPct > 20 ? 'yellow' : 'gray';
  const baselineLabel = ue.source === 'real' ? `all-${ue.baselineModel ?? ue.mostExpensiveModel}` : baselineModel ? `all-${baselineModel}` : 'all-opus';
  // Show the opus-anchored line only when the primary baseline is a pricier
  // model than opus (e.g. Fable); when opus already IS the most expensive
  // model the router returns an equal figure, so the extra row is redundant.
  const showVsOpus =
    ue.source === 'real' &&
    ue.savedPctVsOpus !== undefined &&
    !(ue.mostExpensiveModel ?? '').includes('opus');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginTop={compact ? 0 : 1}>
      <Text color={ACCENT} bold>◆ Economy</Text>
      <Text dimColor>{`spent vs ${baselineLabel} baseline`}</Text>
      {ue.source === 'unavailable' ? (
        <>
          <Text color="yellow">pricing unavailable — savings cannot be calculated</Text>
          {compact ? (
            <Text dimColor>{ue.note ?? `no pricing data for ${baselineModel}`}</Text>
          ) : (
            <>
              <Text dimColor>token-based, cache-read-aware</Text>
              <Text dimColor>{ue.note ?? `no pricing data for ${baselineModel}`}</Text>
              <Text dimColor>{`tokens: ${ue.totalInputTokens?.toLocaleString() ?? 0} fresh in + ${ue.totalCacheReadTokens?.toLocaleString() ?? 0} cached in / ${ue.totalOutputTokens?.toLocaleString() ?? 0} out`}</Text>
            </>
          )}
        </>
      ) : <>
      <Box>
        <StackedBar
          segments={[
            { pct: spentPct, color: 'green' },
            { pct: Math.max(0, 100 - spentPct), color: 'gray' },
          ]}
        />
        <Text>{'  '}</Text>
        <Text color={savedColor} bold>{ue.savedPct >= 0 ? `saved ${ue.savedPct.toFixed(0)}%` : `${Math.abs(ue.savedPct).toFixed(0)}% more`}</Text>
      </Box>
      {ue.source === 'real' ? (
        <>
          <Text dimColor>{ue.savedPct >= 0 ? `${ue.savedPct.toFixed(0)}% saved vs ${baselineLabel}` : `${Math.abs(ue.savedPct).toFixed(0)}% more than ${baselineLabel}`}<Text>{' · '}</Text><Text dimColor>token-based, cache-read-aware</Text></Text>
          {showVsOpus && (
            <Text dimColor>{`~${ue.savedPctVsOpus!.toFixed(0)}% cheaper than all-opus`}</Text>
          )}
          <Text dimColor>{`tokens: ${ue.totalInputTokens?.toLocaleString()} fresh in + ${ue.totalCacheReadTokens?.toLocaleString()} cached in / ${ue.totalOutputTokens?.toLocaleString()} out`}</Text>
        </>
      ) : (
        <>
          <Text dimColor>{`${ue.totalRoutedReqs} routed reqs · ~${ue.savedPct.toFixed(0)}% cheaper than all-opus (estimate)`}</Text>
          <Text dimColor>relative estimate from request mix; excludes real token counts &amp; caching</Text>
        </>
      )}
      </>}
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
