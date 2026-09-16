import { Box,Static,Text,useApp,useInput,useStdout } from 'ink';
import { useCallback,useEffect,useMemo,useRef,useState } from 'react';
import { readApiKey,type ThinkingMode } from '../client/openai.js';
import { BablView } from './BablView.js';
import { InputBox } from './InputBox.js';
import { MessageView } from './MessageView.js';
import { SLASH_COMMANDS,SlashPopup,filterCommands } from './SlashPopup.js';
import { ThinkingMenu } from './ThinkingMenu.js';
import { Welcome } from './Welcome.js';
import type { Message } from './types.js';
import { useBabl } from './useBabl.js';
import { useChat } from './useChat.js';
const MODERATOR_MODEL = 'qwen3.5-122b';
const REGOLO_BASE_URL = 'https://api.regolo.ai';
const BABL_DEFAULT_TURNS = 3;
const BABL_MIN_TURNS = 1;
const BABL_MAX_TURNS = 10;
// Modelli esclusi dalla rosa BABL: non-LLM (apertus/brick), broken (qwen3.5-9b timeout), moderatore qwen3.6-27b sostituito.
const BABL_BLOCKLIST = new Set<string>([
  'apertus-70b',
  'brick-v1-beta',
  'qwen3.5-9b',
  'qwen3.6-27b',
]);
// Pattern per escludere modelli non-LLM dalla lista /v1/models (embedding, ocr, image, asr, reranker).
const NON_LLM_PATTERN = /embedding|reranker|whisper|ocr|gte-|-image$|^Qwen-Image$/i;

export interface AppProps {
  baseUrl: string;
  model: string;
  systemPrompt?: string;
  maxTokens: number;
  initialThinking: ThinkingMode | null;
  initialShowThinking: boolean;
}

export function App(props: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout.rows ?? 24);

  useEffect(() => {
    const onResize = () => setRows(stdout.rows ?? 24);
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);

  const chat = useChat(props);

  const [input, setInput] = useState('');
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const lastEscRef = useRef(0);

  const [bablEnabled, setBablEnabled] = useState(false);
  const [bablTurns, setBablTurns] = useState(BABL_DEFAULT_TURNS);
  const [bablModels, setBablModels] = useState<string[]>([]);
  const [clearKey, setClearKey] = useState(0);

  const babl = useBabl({
    agentsBaseUrl: REGOLO_BASE_URL,
    models: bablModels,
    totalTurns: bablTurns,
    moderatorModel: MODERATOR_MODEL,
    moderatorBaseUrl: REGOLO_BASE_URL,
    maxTokens: props.maxTokens,
    thinking: chat.thinking,
  });

  const slashOpen = input.startsWith('/') && !menuOpen;
  const slashItems = useMemo(() => slashOpen ? filterCommands(input) : [], [slashOpen, input]);

  // Reset selection when filtered list changes
  useEffect(() => {
    if (slashIdx >= slashItems.length) setSlashIdx(0);
  }, [slashItems.length, slashIdx]);

  const enableBabl = useCallback(async () => {
    try {
      const key = await readApiKey().catch(() => '');
      if (!key) {
        chat.pushSystemNote(`BABL: REGOLO_API_KEY mancante (necessaria per agenti + moderatore)`);
        return;
      }
      const res = await fetch(`${REGOLO_BASE_URL}/v1/models`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) {
        chat.pushSystemNote(`BABL: fetch /v1/models fallito (status ${res.status})`);
        return;
      }
      const data = await res.json() as { data?: Array<{ id: string }> };
      const all = (data.data ?? []).map((m) => m.id);
      const models = all.filter((id) =>
        id &&
        id !== MODERATOR_MODEL &&
        !BABL_BLOCKLIST.has(id) &&
        !NON_LLM_PATTERN.test(id)
      );
      if (models.length < 2) {
        chat.pushSystemNote(`BABL: serve ≥2 modelli LLM disponibili, trovati ${models.length}`);
        return;
      }
      setBablModels(models);
      setBablEnabled(true);
      chat.pushSystemNote(`BABL on · ${models.length} models · ${bablTurns} turns · moderator=${MODERATOR_MODEL} · models=[${models.join(', ')}]`);
    } catch (e: any) {
      chat.pushSystemNote(`BABL: errore fetch modelli Regolo: ${(e?.message ?? String(e)).slice(0, 200)}`);
    }
  }, [chat, bablTurns]);

  const handleBablCommand = useCallback((args: string[]): boolean => {
    setInput('');
    if (args.length === 0) {
      if (bablEnabled) {
        chat.pushSystemNote(`BABL: ON · ${bablModels.length} models · ${bablTurns} turns · moderator=${MODERATOR_MODEL}`);
      } else {
        void enableBabl();
      }
      return true;
    }
    const sub = args[0].toLowerCase();
    if (sub === 'on') { void enableBabl(); return true; }
    if (sub === 'off') {
      babl.abort();
      babl.reset();
      setBablEnabled(false);
      chat.pushSystemNote('BABL off');
      return true;
    }
    if (sub === 'turns') {
      const n = Number(args[1]);
      if (!Number.isInteger(n) || n < BABL_MIN_TURNS || n > BABL_MAX_TURNS) {
        chat.pushSystemNote(`BABL: turns deve essere intero ${BABL_MIN_TURNS}..${BABL_MAX_TURNS}`);
        return true;
      }
      setBablTurns(n);
      chat.pushSystemNote(`BABL turns=${n}`);
      return true;
    }
    chat.pushSystemNote(`BABL: sotto-comando sconosciuto "${sub}" · usa: on | off | turns N`);
    return true;
  }, [babl, bablEnabled, bablModels, bablTurns, chat, enableBabl]);

  // Run a command (returns true if handled). Args after first token are passed through.
  const runCommand = useCallback((cmd: string): boolean => {
    const tokens = cmd.split(/\s+/).filter(Boolean);
    const head = tokens[0] ?? '';
    const args = tokens.slice(1);
    if (head === '/quit' || head === '/exit') { setInput(''); exit(); return true; }
    if (head === '/reset') {
      setInput('');
      babl.reset();
      chat.reset();
      chat.pushSystemNote('history cleared');
      return true;
    }
    if (head === '/clear' || head === '/cls') {
      setInput('');
      babl.reset();
      chat.reset();
      stdout.write('\x1b[3J\x1b[2J\x1b[H');
      setClearKey((k) => k + 1);
      return true;
    }
    if (head === '/thinking') { setInput(''); setMenuOpen(true); return true; }
    if (head === '/stream') {
      chat.setStream(!chat.stream);
      chat.pushSystemNote(`stream ${!chat.stream ? 'on' : 'off'}`);
      setInput('');
      return true;
    }
    if (head === '/BABL' || head === '/babl' || head === '/babel') {
      return handleBablCommand(args);
    }
    if (head === '/turns') {
      setInput('');
      if (!bablEnabled) {
        chat.pushSystemNote('/turns: enable BABL first (use /BABL)');
        return true;
      }
      const n = Number(args[0]);
      if (!Number.isInteger(n) || n < BABL_MIN_TURNS || n > BABL_MAX_TURNS) {
        chat.pushSystemNote(`/turns: serve intero ${BABL_MIN_TURNS}..${BABL_MAX_TURNS} · attuale=${bablTurns}`);
        return true;
      }
      setBablTurns(n);
      chat.pushSystemNote(`BABL turns=${n}`);
      return true;
    }
    return false;
  }, [babl, bablEnabled, bablTurns, chat, exit, handleBablCommand, stdout]);

  // Slash command handling
  const handleSubmit = useCallback((value: string) => {
    if (!value) return;
    if (babl.active) return; // input disabled durante BABL run
    const trimmed = value.trim();
    const headTok = trimmed.split(/\s+/)[0] ?? '';
    // If the popup is open and the head does NOT exactly match a known command,
    // treat Enter as autocomplete: replace input with the highlighted command.
    if (slashOpen && slashItems.length > 0) {
      const exact = SLASH_COMMANDS.find((c) => c.name === headTok || (c.aliases ?? []).includes(headTok));
      if (!exact) {
        setInput(slashItems[slashIdx].name + ' ');
        return;
      }
      runCommand(trimmed);
      return;
    }
    if (trimmed.startsWith('/')) {
      if (!runCommand(trimmed)) {
        chat.pushSystemNote(`unknown command: ${trimmed}`);
        setInput('');
      }
      return;
    }
    if (bablEnabled) {
      const query = trimmed;
      setInput('');
      setHistoryIdx(-1);
      chat.pushUserMessage(query);
      const history = chat.buildHistorySnapshot();
      void babl.runQuery(query, history).then((synth) => {
        if (synth) chat.pushAssistantMessage(synth, MODERATOR_MODEL);
        else chat.pushSystemNote('BABL: nessuna sintesi prodotta (vedi errori sopra)');
      });
      return;
    }
    chat.enqueueOrSend(value);
    setInput('');
    setHistoryIdx(-1);
  }, [babl, bablEnabled, chat, runCommand, slashOpen, slashItems, slashIdx]);

  // Keyboard handlers (ink useInput cannot run while TextInput's own listener is active —
  // ink-text-input only handles printable + arrows + return, so most special keys still reach us)
  useInput((inputKey, key) => {
    if (menuOpen) return; // menu has its own input
    if (key.escape) {
      // Esc dismisses the slash popup first if it's showing
      if (slashOpen) { setInput(''); return; }
      const now = Date.now();
      if (now - lastEscRef.current < 500) {
        setInput('');
        lastEscRef.current = 0;
      } else {
        lastEscRef.current = now;
        if (babl.active) babl.abort();
        else if (chat.busy) chat.interrupt();
      }
      return;
    }
    if (key.ctrl && inputKey === 't') {
      chat.setShowThinking(!chat.showThinking);
      chat.pushSystemNote(`thinking visibility ${!chat.showThinking ? 'on' : 'off'}`);
      return;
    }
    if (key.ctrl && inputKey === 'c') {
      if (babl.active) babl.abort();
      else if (chat.busy) chat.interrupt();
      else exit();
      return;
    }
    // Slash popup navigation takes priority over history navigation
    if (slashOpen && slashItems.length > 0) {
      if (key.upArrow) { setSlashIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setSlashIdx((i) => Math.min(slashItems.length - 1, i + 1)); return; }
      if (key.tab) { setInput(slashItems[slashIdx].name + ' '); return; }
    }
    if (key.upArrow && !chat.busy) {
      const list = chat.history;
      if (list.length === 0) return;
      const next = historyIdx < 0 ? list.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(next);
      setInput(list[next] ?? '');
      return;
    }
    if (key.downArrow && !chat.busy) {
      const list = chat.history;
      if (list.length === 0) return;
      if (historyIdx < 0) return;
      const next = historyIdx + 1;
      if (next >= list.length) { setHistoryIdx(-1); setInput(''); }
      else { setHistoryIdx(next); setInput(list[next]); }
      return;
    }
  });

  const hint = `Enter send · ↑/↓ history · Ctrl+T toggle thinking · Esc interrupt · Esc Esc clear input · /quit /clear /reset /thinking /stream /BABL${bablEnabled ? ' /turns' : ''}`;

  const isStreaming = (m: Message) => m.role === 'assistant' && m.status === 'streaming';

  const settledMessages = useMemo(
    () => chat.messages.filter((m) => !isStreaming(m)),
    [chat.messages]
  );

  const streamingMsg = useMemo(
    () => chat.messages.find(isStreaming),
    [chat.messages]
  );

  const userHasSpoken = chat.messages.some((m) => m.role === 'user');

  return (
    <Box flexDirection="column">
      <Static key={clearKey} items={settledMessages}>
        {(msg) => (
          <Box key={`m-${msg.id}`} paddingX={4}>
            <MessageView msg={msg} showThinking={chat.showThinking} />
          </Box>
        )}
      </Static>

      <Box flexDirection="column" paddingX={4}>
        {!userHasSpoken && (
          <Welcome
            baseUrl={props.baseUrl}
            model={props.model}
            thinking={chat.thinking}
            stream={chat.stream}
            showThinking={chat.showThinking}
            bablEnabled={bablEnabled}
            bablModelsCount={bablModels.length}
            bablTurns={bablTurns}
          />
        )}

        {/* Dynamic area: BABL session OR streaming assistant msg */}
        {babl.active && babl.session ? (
          <Box flexDirection="column" flexShrink={0}>
            <BablView session={babl.session} rowsAvailable={Math.max(8, rows - 6)} showThinking={chat.showThinking} />
          </Box>
        ) : streamingMsg ? (
          <MessageView msg={streamingMsg} showThinking={chat.showThinking} />
        ) : null}

        {/* Status line */}
        <Box flexShrink={0} marginTop={1}>
          <Text dimColor>{props.baseUrl}</Text>
          <Text dimColor>  · model={props.model}</Text>
          <Text dimColor>  · stream={chat.stream ? 'on' : 'off'}</Text>
          <Text dimColor>  · thinking={chat.thinking ?? 'router-default'}</Text>
          {chat.busy && <Text color="yellow">  · streaming…</Text>}
          {bablEnabled && (
            <Text color="#f3722c" bold>  · BABL ON ({bablModels.length}a, {bablTurns}t)</Text>
          )}
        </Box>

        {/* Input */}
        <Box flexShrink={0} flexDirection="column">
        {menuOpen ? (
          <ThinkingMenu
            showThinking={chat.showThinking}
            mode={chat.thinking}
            onPick={(next) => {
              if (next.showThinking !== undefined) chat.setShowThinking(next.showThinking);
              if (next.mode !== undefined) chat.setThinking(next.mode);
              chat.pushSystemNote(
                [
                  next.showThinking !== undefined ? `thinking visibility=${next.showThinking ? 'on' : 'off'}` : '',
                  next.mode !== undefined ? `thinking mode=${next.mode ?? 'router-default'}` : '',
                ].filter(Boolean).join(' · ') || 'no change'
              );
            }}
            onClose={() => setMenuOpen(false)}
          />
        ) : (
          <>
            {slashOpen && <SlashPopup items={slashItems} selected={slashIdx} />}
            <InputBox
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              busy={chat.busy || babl.active}
              queueLen={chat.queue.length}
              hint={hint}
            />
          </>
        )}
        </Box>
      </Box>
    </Box>
  );
}
