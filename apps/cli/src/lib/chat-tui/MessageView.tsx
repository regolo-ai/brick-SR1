import { Box,Text } from 'ink';
import Spinner from 'ink-spinner';
import type { AssistantMessage,Message } from './types.js';

const accent = '#00d4aa';

export function MessageView({ msg, showThinking }: { msg: Message; showThinking: boolean }) {
  if (msg.role === 'user') {
    return (
      <Box marginTop={1} flexDirection="column" flexShrink={0}>
        <Text color="cyan">▌ you</Text>
        <Text>{msg.content}</Text>
      </Box>
    );
  }
  if (msg.role === 'system') {
    return (
      <Box marginTop={1} flexShrink={0}>
        <Text dimColor italic>· {msg.content}</Text>
      </Box>
    );
  }
  return <AssistantView msg={msg} showThinking={showThinking} />;
}

function AssistantView({ msg, showThinking }: { msg: AssistantMessage; showThinking: boolean }) {
  const ttft = msg.firstTokenAt ? Math.round(msg.firstTokenAt - msg.startedAt) : 0;
  const total = msg.finishedAt ? Math.round(msg.finishedAt - msg.startedAt) : Math.round(Date.now() - msg.startedAt);
  const tag = `[${msg.selectedModel ?? '?'}]  ${ttft}ms ttft · ${total}ms total${msg.completionTokens ? ` · ${msg.completionTokens} tok` : ''}${msg.thinkingApplied ? ` · think=${msg.thinkingApplied}` : ''}`;
  const reasoningChars = msg.reasoning.length;
  const reasoningTokApprox = Math.round(reasoningChars / 4);

  return (
    <Box marginTop={1} flexDirection="column" flexShrink={0}>
      {/* Reasoning section */}
      {msg.reasoning.length > 0 && showThinking && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="green" dimColor>thinking</Text>
          <Text color="green" dimColor italic>{msg.reasoning}</Text>
        </Box>
      )}

      {/* Reasoning summary line when hidden */}
      {msg.reasoning.length > 0 && !showThinking && (
        <Box marginBottom={msg.content.length > 0 ? 0 : 1}>
          {msg.status === 'streaming' && msg.content.length === 0 ? (
            <Text color={accent}>
              <Spinner type="dots" /> reasoning… ~{reasoningTokApprox} tok hidden  <Text dimColor>(Ctrl+T to toggle)</Text>
            </Text>
          ) : (
            <Text color={accent}>✓ reasoning ({((msg.finishedAt ?? Date.now()) - msg.startedAt) / 1000 < 60 ? `${(((msg.finishedAt ?? Date.now()) - msg.startedAt) / 1000).toFixed(1)}s` : '...'}, ~{reasoningTokApprox} tok hidden)</Text>
          )}
        </Box>
      )}

      {/* Bot label */}
      <Text color="green" bold>▌ brick</Text>

      {/* Content body */}
      {msg.content.length > 0 && <Text>{msg.content}</Text>}
      {msg.content.length === 0 && msg.status === 'streaming' && msg.reasoning.length === 0 && (
        <Text color={accent}><Spinner type="dots" /> waiting…</Text>
      )}
      {msg.status === 'aborted' && (
        <Text color="yellow">[aborted by user]</Text>
      )}
      {msg.status === 'error' && (
        <Text color="red">error: {msg.errorText}</Text>
      )}

      {/* Footer tag */}
      {(msg.status === 'done' || msg.status === 'aborted' || msg.status === 'error') && (
        <Text dimColor>{tag}</Text>
      )}
    </Box>
  );
}
