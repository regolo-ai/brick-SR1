import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import {
  fetchSnapshot,
  fetchEconomics,
  resetMetrics,
  unifyEconomy,
  type Snapshot,
  type EconomicsResponse,
} from '../claude/metrics.js';

const ACCENT = '#00d4aa';

// Trims the trailing date stamp (e.g. claude-haiku-4-5-20251001 -> claude-haiku-4-5)
// so model names stay short enough not to wrap the dashboard rows.
function shortModel(model: string): string {
  return model.replace(/-\d{8}$/, '');
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
      const [s, e] = await Promise.all([fetchSnapshot(baseUrl, envUrl, attached), fetchEconomics(baseUrl, economyBaselineModel)]);
      if (alive) { setSnap(s); setEcon(e); setLoading(false); }
    };
    run();
    const id = setInterval(run, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [baseUrl, envUrl, attached, intervalMs, tick, economyBaselineModel]);

  return (
    <Box flexDirection="column" paddingX={1}>
      <RoutingBox snap={snap} emptyRequestsLabel={emptyRequestsLabel} nativeLabel={nativeLabel} />
      <EconomyBox snap={snap} econ={econ} enabled={showEconomy} baselineModel={economyBaselineModel} />
      <ConnectionBox snap={snap} loading={loading} mode={mode} connectionLabel={connectionLabel} disconnectedLabel={disconnectedLabel} unattachedLabel={unattachedLabel} />
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
  disconnectedLabel,
  unattachedLabel,
}: {
  snap: Snapshot | null;
  loading: boolean;
  mode?: string;
  connectionLabel: string;
  disconnectedLabel: string;
  unattachedLabel: string;
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
                : <Text color="yellow">{snap.envUrl} ✗ {unattachedLabel}</Text>
            ) : <Text color="yellow">{disconnectedLabel}</Text>}
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
  const stats = snap?.stats;
  const m = snap?.metrics ?? { requestsByLabelModel: new Map(), effortByModelEffort: new Map(), routingByDiffEffortModel: new Map(), fallbackTotal: 0, classifyDurationCount: 0, classifyDurationSum: 0, classifyDurationBuckets: [] };
  if (snap?.health && !stats) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginTop={1}>
        <Text color={ACCENT} bold>◆ Routing</Text>
        <Text dimColor>stats API not reachable</Text>
      </Box>
    );
  }
  if (!stats) return null;
  if (stats.overall.calls === 0) return <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginTop={1}><Text color={ACCENT} bold>◆ Routing</Text><Text dimColor>{emptyRequestsLabel}</Text></Box>;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginTop={1}>
      <Text color={ACCENT} bold>◆ Routing</Text>
      <Row label="total requests"><Text bold>{String(stats.overall.calls)}</Text><Text dimColor>{` · ${stats.overall.completed_calls} completed · ${stats.overall.failed_calls} failed`}</Text></Row>
      {stats.models.map((row) => <Box key={row.model} flexDirection="column" marginTop={1}><Row label={shortModel(row.model)}><Text>{`${row.routed_calls} routed · ${row.native_calls} ${nativeLabel}`}</Text></Row><Row label="thinking"><Text dimColor>{row.reasoning_modes.map((mode) => `${mode.mode}: ${mode.calls}`).join(' · ') || 'default'}</Text></Row></Box>)}
    </Box>
  );

}

function EconomyBox({
  snap,
  econ,
  enabled,
  baselineModel,
}: {
  snap: Snapshot | null;
  econ: EconomicsResponse | null;
  enabled: boolean;
  baselineModel?: string;
}) {
  if (!enabled) return null;
  const m = snap?.metrics;
  if (!m && !baselineModel) return null;
  const metrics = m ?? {
    requestsByLabelModel: new Map(), effortByModelEffort: new Map(), routingByDiffEffortModel: new Map(),
    fallbackTotal: 0, classifyDurationCount: 0, classifyDurationSum: 0, classifyDurationBuckets: [],
  };
  const ue = unifyEconomy(econ, metrics, baselineModel);
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
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginTop={1}>
      <Text color={ACCENT} bold>◆ Economy</Text>
      <Text dimColor>{`spent vs ${baselineLabel} baseline`}</Text>
      {ue.source === 'unavailable' ? (
        <>
          <Text color="yellow">pricing unavailable — savings cannot be calculated</Text>
          <Text dimColor>token-based, cache-read-aware</Text>
          <Text dimColor>{ue.note ?? `no pricing data for ${baselineModel}`}</Text>
          <Text dimColor>{`tokens: ${ue.totalInputTokens?.toLocaleString() ?? 0} fresh in + ${ue.totalCacheReadTokens?.toLocaleString() ?? 0} cached in / ${ue.totalOutputTokens?.toLocaleString() ?? 0} out`}</Text>
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

function StackedBar({ segments, width = 28 }: { segments: Array<{ pct: number; color: string }>; width?: number }) {
  const total = segments.reduce((sum, segment) => sum + segment.pct, 0) || 1;
  return <Text>{segments.map((segment, index) => <Text key={index} color={segment.color}>{'█'.repeat(Math.round((segment.pct / total) * width))}</Text>)}</Text>;
}
