import { Box,Text } from 'ink';
import TextInput from 'ink-text-input';

const accent = '#00d4aa';

export function InputBox(props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  busy: boolean;
  queueLen: number;
  hint: string;
}) {
  return (
    <Box flexDirection="column">
      <Text dimColor>{'─'.repeat(80)}</Text>
      <Box>
        <Text color={accent}>{props.busy ? '⠿ ' : '▷ '}</Text>
        <TextInput
          value={props.value}
          onChange={props.onChange}
          onSubmit={props.onSubmit}
          placeholder={props.busy ? 'streaming… type to queue, Esc to interrupt' : 'send a message…  (/ for commands, ↑/↓ history)'}
          showCursor
        />
      </Box>
      <Box>
        <Text dimColor>{props.hint}{props.queueLen > 0 ? `  ·  ${props.queueLen} queued` : ''}</Text>
      </Box>
    </Box>
  );
}
