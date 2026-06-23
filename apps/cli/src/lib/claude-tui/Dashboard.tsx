import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import {
  fetchSnapshot,
  routingRows,
  totalRequests,
  classifierPercentiles,
  classifierMean,
  fallbackPct,
  formatLatency,
  type Snapshot,
} from '../claude/metrics.js';

const ACCENT = '#00d4aa';

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
      <Box>
        <Text color={ACCENT} bold>{'  brick · claude dashboard'}</Text>
      </Box>

      <ConnectionBox snap={snap} loading={loading} />
      <ClassifierBox snap={snap} />
      <RoutingBox snap={snap} />

      <Box marginTop={1}>
        <Text dimColor>{`refresh ${(intervalMs / 1000).toFixed(0)}s · r=refresh now · q=quit`}</Text>
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
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color={ACCENT} bold>Classifier</Text>
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
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color={ACCENT} bold>Routing</Text>
        <Text dimColor>metrics endpoint not reachable (port 9190/19190)</Text>
      </Box>
    );
  }
  if (!m) return null;

  const total = totalRequests(m);
  const rows = routingRows(m);
  const mean = classifierMean(m);
  const { p50, p95 } = classifierPercentiles(m);
  const fb = fallbackPct(m);
  const fbColor = fb > 5 ? 'red' : fb > 1 ? 'yellow' : 'green';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color={ACCENT} bold>Routing</Text>
      {total === 0 ? (
        <Text dimColor>no /v1/messages requests served yet</Text>
      ) : (
        <>
          <Row label="total requests"><Text bold>{String(total)}</Text></Row>
          {rows.map((r) => (
            <Box key={`${r.label}|${r.model}`}>
              <Box width={20}><Text dimColor>{`${r.label} → ${r.model}`}</Text></Box>
              <Bar pct={r.pct} />
              <Text>{`  ${r.count} (${r.pct.toFixed(0)}%)`}</Text>
            </Box>
          ))}
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

function Bar({ pct, width = 16 }: { pct: number; width?: number }) {
  const filled = Math.round((pct / 100) * width);
  return <Text color={ACCENT}>{'█'.repeat(filled)}<Text dimColor>{'░'.repeat(Math.max(0, width - filled))}</Text></Text>;
}
