import { Box,Text } from 'ink';

const accent = '#00d4aa';

export interface SlashCommand {
  name: string;       // including leading slash, e.g. "/thinking"
  description: string;
  aliases?: string[];
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/thinking', description: 'visibility · mode (off/low/medium/high/auto/router-default)' },
  { name: '/stream', description: 'toggle streaming on/off' },
  { name: '/BABL', description: 'Babele mode: N models debate · on/off · turns N', aliases: ['/babl', '/babel'] },
  { name: '/turns', description: 'BABL: set number of debate turns (1..10) — only when BABL on' },
  { name: '/clear', description: 'clear screen and reset chat to welcome', aliases: ['/cls'] },
  { name: '/reset', description: 'clear chat history (keep screen)' },
  { name: '/quit', description: 'exit chat', aliases: ['/exit'] },
];

export function filterCommands(input: string): SlashCommand[] {
  // Matches any command (or alias) whose name starts with the typed prefix
  // (case-insensitive). Empty input => all commands.
  const q = input.toLowerCase();
  if (q === '' || q === '/') return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((c) => {
    if (c.name.toLowerCase().startsWith(q)) return true;
    return (c.aliases ?? []).some((a) => a.toLowerCase().startsWith(q));
  });
}

export function SlashPopup({ items, selected }: { items: SlashCommand[]; selected: number }) {
  if (items.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
        <Text color="yellow">no matching command</Text>
        <Text dimColor>type /quit /clear /reset /thinking /stream</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} marginTop={1}>
      <Text color={accent} bold>commands</Text>
      {items.map((c, i) => (
        <Box key={c.name}>
          <Text color={i === selected ? accent : undefined}>
            {i === selected ? '› ' : '  '}
            <Text bold={i === selected}>{c.name}</Text>
            <Text dimColor>  — {c.description}</Text>
            {c.aliases && c.aliases.length > 0 && <Text dimColor>  (alias: {c.aliases.join(', ')})</Text>}
          </Text>
        </Box>
      ))}
      <Text dimColor>↑/↓ navigate · Tab autocomplete · Enter run · Esc dismiss</Text>
    </Box>
  );
}
