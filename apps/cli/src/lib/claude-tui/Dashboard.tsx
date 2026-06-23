import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import {
  fetchSnapshot,
  routedRowsByModel,
  nativeRowsByModel,
  difficultyDistribution,
  effortRowsForModel,
  economy,
  totalRequests,
  classifierPercentiles,
  classifierMean,
  fallbackPct,
  formatLatency,
  type Snapshot,
} from '../claude/metrics.js';

const ACCENT = '#00d4aa';

// Fixed colour per model family so a model keeps the same hue across the stacked
// bar, the per-model bars and the legend. Matched by prefix so version bumps
// (sonnet-4-6 -> 4-7) don't need a new entry.
const MODEL_COLORS: Array<[string, string]> = [
  ['claude-haiku', '#7aa2f7'],
  ['claude-sonnet', '#bb9af7'],
  ['claude-opus', '#f7768e'],
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

export interface DashboardProps {
  baseUrl: string;
  envUrl?: string;
  intervalMs: number;
}

export function Dashboard({ baseUrl, envUrl, intervalMs }: DashboardProps) {
  const { exit } = useApp();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(true);

  useInput((input, key) => {
    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) exit();
    if (input === 'r') setTick((t) => t + 1); // manual refresh
  });

  useEffect(() => {
    let alive = true;
    const run = async () => {
      const s = await fetchSnapshot(baseUrl, envUrl);
      if (alive) { setSnap(s); setLoading(false); }
    };
    run();
    const id = setInterval(run, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [baseUrl, envUrl, intervalMs, tick]);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginTop={1}>
        <Text color={ACCENT} bold>{'▸ brick'}</Text>
        <Text dimColor>{'  ·  claude routing dashboard'}</Text>
      </Box>

      <ConnectionBox snap={snap} loading={loading} />
      <ClassifierBox snap={snap} />
      <RoutingBox snap={snap} />
      <EconomyBox snap={snap} />

      <Box marginTop={1}>
        <Text dimColor>{`↻ ${(intervalMs / 1000).toFixed(0)}s  ·  r refresh  ·  q quit`}</Text>
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

function ConnectionBox({ snap, loading }: { snap: Snapshot | null; loading: boolean }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginTop={1}>
      <Text color={ACCENT} bold>Connection</Text>
      {loading && !snap ? (
        <Text dimColor>probing…</Text>
      ) : (
        <>
          <Row label="ANTHROPIC_BASE_URL">
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

function RoutingBox({ snap }: { snap: Snapshot | null }) {
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
        <Text dimColor>no /v1/messages requests served yet</Text>
      ) : (
        <>
          <Row label="total requests"><Text bold>{String(total)}</Text></Row>
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
              <Box key={`routed|${r.model}`} flexDirection="column" paddingLeft={2}>
                <Box>
                  <Box width={22}><Text color={colorForModel(r.model)}>{shortModel(r.model)}</Text></Box>
                  <ColoredBar pct={r.pct} color={colorForModel(r.model)} />
                  <Text>{`  ${r.count} (${r.pct.toFixed(0)}%)`}</Text>
                </Box>
                {efforts.map((e) => (
                  <Box key={`eff|${r.model}|${e.label}`} paddingLeft={2}>
                    <Box width={20}><Text color={colorForEffort(e.label)} dimColor>{`└ ${e.label}`}</Text></Box>
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
              <Text dimColor>native (router bypass)</Text>
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

function EconomyBox({ snap }: { snap: Snapshot | null }) {
  const m = snap?.metrics;
  if (!m) return null;
  const e = economy(m);
  if (e.totalRoutedReqs === 0) return null;

  const spentPct = e.opusUnits === 0 ? 0 : (e.actualUnits / e.opusUnits) * 100;
  const savedColor = e.savedPct > 50 ? 'green' : e.savedPct > 20 ? 'yellow' : 'gray';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginTop={1}>
      <Text color={ACCENT} bold>◆ Economy</Text>
      <Text dimColor>spent vs all-opus baseline</Text>
      <Box>
        <StackedBar
          segments={[
            { pct: spentPct, color: 'green' },
            { pct: Math.max(0, 100 - spentPct), color: 'gray' },
          ]}
        />
        <Text>{'  '}</Text>
        <Text color={savedColor} bold>{`saved ${e.savedPct.toFixed(0)}%`}</Text>
      </Box>
      <Text dimColor>{`${e.totalRoutedReqs} routed reqs · ~${e.savedPct.toFixed(0)}% cheaper than all-opus (estimate)`}</Text>
      <Text dimColor>relative estimate from request mix; excludes real token counts &amp; caching</Text>
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

function Legend({ items }: { items: Array<{ label: string; color: string; pct: number }> }) {
  return (
    <Box flexWrap="wrap">
      {items.map((it, i) => (
        <Box key={i} marginRight={2}>
          <Text color={it.color}>■ </Text>
          <Text dimColor>{`${it.label} ${it.pct.toFixed(0)}%`}</Text>
        </Box>
      ))}
    </Box>
  );
}

