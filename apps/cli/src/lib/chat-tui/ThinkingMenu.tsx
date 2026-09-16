import { Box,Text,useInput } from 'ink';
import { useState } from 'react';
import type { ThinkingMode } from '../client/openai.js';

const accent = '#00d4aa';

type Action = 'visibility' | 'mode' | 'cancel';

const ACTIONS: { value: Action; label: string; hint: (state: { showThinking: boolean; mode: ThinkingMode | null }) => string }[] = [
  { value: 'visibility', label: 'Visibility', hint: (s) => `currently: ${s.showThinking ? 'show' : 'hidden'}` },
  { value: 'mode', label: 'Brick-thinking mode', hint: (s) => `currently: ${s.mode ?? 'router-default'}` },
  { value: 'cancel', label: '← back', hint: () => '' },
];

const MODES: { value: ThinkingMode | 'unset'; label: string; hint: string }[] = [
  { value: 'unset', label: 'router-default', hint: 'no override; pipeline decides per decision' },
  { value: 'off', label: 'off', hint: 'enable_thinking=false on every backend' },
  { value: 'low', label: 'low effort', hint: '' },
  { value: 'medium', label: 'medium effort', hint: '' },
  { value: 'high', label: 'high effort', hint: '' },
  { value: 'auto', label: 'auto (brick-thinking)', hint: 'effort chosen by complexity classifier per query' },
];

export function ThinkingMenu(props: {
  showThinking: boolean;
  mode: ThinkingMode | null;
  onPick: (next: { showThinking?: boolean; mode?: ThinkingMode | null }) => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<'top' | 'mode'>('top');
  const [topIdx, setTopIdx] = useState(0);
  const [modeIdx, setModeIdx] = useState(() => {
    const i = MODES.findIndex((m) => m.value === (props.mode ?? 'unset'));
    return i < 0 ? 0 : i;
  });

  useInput((_input, key) => {
    if (key.escape) {
      if (stage === 'mode') setStage('top');
      else props.onClose();
      return;
    }
    if (stage === 'top') {
      if (key.upArrow) setTopIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow) setTopIdx((i) => Math.min(ACTIONS.length - 1, i + 1));
      else if (key.return) {
        const a = ACTIONS[topIdx].value;
        if (a === 'cancel') props.onClose();
        else if (a === 'visibility') { props.onPick({ showThinking: !props.showThinking }); props.onClose(); }
        else if (a === 'mode') setStage('mode');
      }
    } else {
      if (key.upArrow) setModeIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow) setModeIdx((i) => Math.min(MODES.length - 1, i + 1));
      else if (key.return) {
        const v = MODES[modeIdx].value;
        props.onPick({ mode: v === 'unset' ? null : (v as ThinkingMode) });
        props.onClose();
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} marginTop={1}>
      <Text color={accent} bold>/thinking</Text>
      {stage === 'top' ? (
        <Box flexDirection="column">
          {ACTIONS.map((a, i) => (
            <Text key={a.value} color={i === topIdx ? accent : undefined}>
              {i === topIdx ? '› ' : '  '}{a.label}  {a.hint({ showThinking: props.showThinking, mode: props.mode }) ? <Text dimColor>— {a.hint({ showThinking: props.showThinking, mode: props.mode })}</Text> : null}
            </Text>
          ))}
          <Text dimColor>↑/↓ + Enter · Esc to close</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>Pick brick-thinking mode for next turns:</Text>
          {MODES.map((m, i) => (
            <Text key={m.value} color={i === modeIdx ? accent : undefined}>
              {i === modeIdx ? '› ' : '  '}{m.label}  {m.hint ? <Text dimColor>— {m.hint}</Text> : null}
            </Text>
          ))}
          <Text dimColor>↑/↓ + Enter · Esc to back</Text>
        </Box>
      )}
    </Box>
  );
}
