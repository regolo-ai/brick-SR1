import React from 'react';
import { Box, Text } from 'ink';
import type { ThinkingMode } from '../client/openai.js';
import { REGOLO_WORDMARK, BABL_WORDMARK } from './mascot.js';

const accent = '#00d4aa';
const regoloGreen = '#5ee6a1';

// Gradient palette for BABL wordmark: red → orange → yellow.
const BABL_GRADIENT_STOPS = ['#e63946', '#f3722c', '#f8961e', '#f9c74f', '#fcbf49'];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function lerpAlongStops(stops: string[], t: number): string {
  if (stops.length === 0) return '#ffffff';
  if (stops.length === 1) return stops[0];
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (stops.length - 1);
  const lo = Math.floor(scaled);
  const hi = Math.min(stops.length - 1, lo + 1);
  const local = scaled - lo;
  const [ar, ag, ab] = hexToRgb(stops[lo]);
  const [br, bg, bb] = hexToRgb(stops[hi]);
  return rgbToHex(ar + (br - ar) * local, ag + (bg - ag) * local, ab + (bb - ab) * local);
}

function GradientLine({ line, stops, segments = 12 }: { line: string; stops: string[]; segments?: number }) {
  const chars = Array.from(line);
  const n = Math.max(1, Math.min(segments, chars.length));
  const segLen = Math.ceil(chars.length / n);
  const parts: React.ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    const piece = chars.slice(i * segLen, (i + 1) * segLen).join('');
    if (!piece) continue;
    const t = n === 1 ? 0 : i / (n - 1);
    parts.push(<Text key={i} bold color={lerpAlongStops(stops, t)}>{piece}</Text>);
  }
  return <Text>{parts}</Text>;
}

export function Welcome(props: {
  baseUrl: string;
  model: string;
  thinking: ThinkingMode | null;
  stream: boolean;
  showThinking: boolean;
  bablEnabled?: boolean;
  bablModelsCount?: number;
  bablTurns?: number;
}) {
  const babl = !!props.bablEnabled;
  return (
    <Box flexDirection="column" flexShrink={0} borderStyle="round" borderColor={babl ? '#f3722c' : accent} paddingX={2} paddingY={1} marginTop={1} marginBottom={0}>
      <Box>
        {babl ? (
          <Text dimColor>multi-agent debate · powered by Regolo · BABEL mode</Text>
        ) : (
          <Text dimColor>self-hosted spatial router · Brick gateway, powered by</Text>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {babl
          ? BABL_WORDMARK.map((line, i) => (
              <GradientLine key={i} line={line} stops={BABL_GRADIENT_STOPS} segments={12} />
            ))
          : REGOLO_WORDMARK.map((line, i) => (
              <Text key={i} color={regoloGreen}>{line}</Text>
            ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text dimColor>endpoint  </Text>
          <Text>{props.baseUrl}</Text>
        </Box>
        <Box>
          <Text dimColor>model     </Text>
          <Text>{props.model}</Text>
        </Box>
        <Box>
          <Text dimColor>thinking  </Text>
          <Text>{props.thinking ?? 'router-default'}</Text>
          <Text dimColor>  · visibility </Text>
          <Text>{props.showThinking ? 'show' : 'hidden'}</Text>
        </Box>
        <Box>
          <Text dimColor>stream    </Text>
          <Text>{props.stream ? 'on' : 'off'}</Text>
        </Box>
        {babl && (
          <Box>
            <Text dimColor>babl      </Text>
            <Text color="#f3722c" bold>ON</Text>
            <Text dimColor>  · {props.bablModelsCount ?? 0} agents · {props.bablTurns ?? 3} turns</Text>
          </Box>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={accent}>tips</Text>
        <Text dimColor>· type <Text color={accent}>/</Text> to see available commands (/thinking /stream /BABL /reset /quit)</Text>
        <Text dimColor>· ↑/↓ navigate prompt history</Text>
        <Text dimColor>· <Text color={accent}>Ctrl+T</Text> toggle reasoning visibility · <Text color={accent}>Esc</Text> interrupt stream · <Text color={accent}>Esc Esc</Text> clear input</Text>
        <Text dimColor>· keep typing while a response streams: messages queue up</Text>
      </Box>
    </Box>
  );
}
