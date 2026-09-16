import { Box,Text,useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect,useState } from 'react';
import type { BablSession } from './babl-types.js';
import { BablPane } from './BablPane.js';

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function gridCols(width: number): number {
  if (width < 80) return 1;
  if (width < 120) return 2;
  if (width < 160) return 3;
  return 4;
}

export interface BablViewProps {
  session: BablSession;
  rowsAvailable: number;
  showThinking: boolean;
}

export function BablView({ session, rowsAvailable, showThinking }: BablViewProps) {
  const { stdout } = useStdout();
  const [width, setWidth] = useState<number>(stdout.columns ?? 80);

  useEffect(() => {
    const onResize = () => setWidth(stdout.columns ?? 80);
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);

  const cols = gridCols(width);
  const colGap = 2;
  const rowGap = 1;
  const paneW = Math.max(20, Math.floor((width - (cols - 1) * colGap) / cols) - 2);
  const numRows = Math.ceil(session.models.length / cols);

  const moderatorActive = session.moderator.status !== 'idle';
  const moderatorReserve = moderatorActive ? Math.max(10, Math.floor(rowsAvailable * 0.42)) : 0;
  const headerReserve = 3;
  const interRowReserve = (numRows - 1) * rowGap;
  const gridArea = Math.max(6, rowsAvailable - moderatorReserve - headerReserve - interRowReserve);
  const paneH = Math.max(8, Math.floor(gridArea / numRows));

  const currentTurn = session.turns[session.currentTurn - 1];
  const turnsRemaining = Math.max(0, session.totalTurns - session.currentTurn);
  const progressBar = '●'.repeat(session.currentTurn) + '○'.repeat(turnsRemaining);

  const rows = currentTurn ? chunk(session.models, cols) : [];

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box flexShrink={0} marginBottom={1}>
        <Text bold color="#f3722c">BABL</Text>
        <Text>  ·  turn </Text>
        <Text bold>{session.currentTurn}/{session.totalTurns}</Text>
        <Text>  ·  [{progressBar}]</Text>
        <Text>  ·  {session.models.length} agents</Text>
        {session.globalError && <Text color="red">  ·  {session.globalError}</Text>}
      </Box>
      {currentTurn && (
        <Box flexDirection="column" flexShrink={0} gap={rowGap}>
          {rows.map((rowModels, rIdx) => (
            <Box key={rIdx} flexDirection="row" flexShrink={0} gap={colGap}>
              {rowModels.map((m) => {
                const agent = currentTurn.agents.get(m);
                if (!agent) return null;
                return (
                  <BablPane
                    key={m}
                    agent={agent}
                    width={paneW}
                    height={paneH}
                    showThinking={showThinking}
                  />
                );
              })}
            </Box>
          ))}
        </Box>
      )}
      {moderatorActive && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={
            session.moderator.status === 'error' ? 'red' :
            session.moderator.status === 'done' ? 'gray' :
            '#f3722c'
          }
          paddingX={2}
          paddingY={0}
          marginTop={1}
          flexShrink={0}
          height={Math.max(8, moderatorReserve)}
        >
          <Box flexShrink={0} marginBottom={1}>
            {session.moderator.status === 'streaming' ? (
              <Text color="#f3722c"><Spinner type="dots" /></Text>
            ) : session.moderator.status === 'done' ? (
              <Text color="green">✓</Text>
            ) : session.moderator.status === 'error' ? (
              <Text color="red">✗</Text>
            ) : (
              <Text dimColor>·</Text>
            )}
            <Text> </Text>
            <Text bold color="#f3722c">moderator</Text>
            <Text dimColor>  ·  qwen3.5-122b  ·  regolo cloud</Text>
          </Box>
          <Box flexGrow={1} overflow="hidden">
            {session.moderator.status === 'error' ? (
              <Text color="red" wrap="wrap">{session.moderator.errorText ?? 'errore'}</Text>
            ) : (
              <Text wrap="wrap">{session.moderator.content}</Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
