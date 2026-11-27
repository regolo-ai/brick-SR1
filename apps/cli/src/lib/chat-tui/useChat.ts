import { useCallback,useEffect,useRef,useState } from 'react';
import { chatCompletionStream,type ChatMessage,type ThinkingMode } from '../client/openai.js';
import type { AssistantMessage,Message,SystemMessage,UserMessage } from './types.js';

let nextId = 1;

interface UseChatOpts {
  baseUrl: string;
  model: string;
  systemPrompt?: string;
  maxTokens: number;
  initialThinking: ThinkingMode | null;
  initialShowThinking: boolean;
}

export function useChat(opts: UseChatOpts) {
  const [messages, setMessages] = useState<Message[]>(() => {
    if (opts.systemPrompt) {
      return [{ id: nextId++, role: 'system', content: `system: ${opts.systemPrompt}` } as SystemMessage];
    }
    return [];
  });
  const [showThinking, setShowThinking] = useState(opts.initialShowThinking);
  const [thinking, setThinking] = useState<ThinkingMode | null>(opts.initialThinking);
  const [stream, setStream] = useState(true);
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const showThinkingRef = useRef(showThinking);
  showThinkingRef.current = showThinking;

  const sysHistory = useRef<string[]>([]);

  const sendNow = useCallback(async (text: string) => {
    setBusy(true);
    const userMsg: UserMessage = { id: nextId++, role: 'user', content: text, ts: Date.now() };
    sysHistory.current.push(text);
    const assistantId = nextId++;
    const placeholder: AssistantMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      reasoning: '',
      status: 'streaming',
      startedAt: Date.now(),
    };
    setMessages((m) => [...m, userMsg, placeholder]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const history = buildHistoryWith(messages, opts.systemPrompt, [{ role: 'user', content: text }]);
      const iter = chatCompletionStream({
        baseUrl: opts.baseUrl,
        model: opts.model,
        messages: history,
        maxTokens: opts.maxTokens,
        thinking: thinking ?? null,
      });
      let firstTokenAt: number | undefined;
      for await (const chunk of iter) {
        if (ctrl.signal.aborted) {
          setMessages((m) => m.map((x) => x.id === assistantId && x.role === 'assistant' ? { ...x, status: 'aborted', finishedAt: Date.now() } : x));
          break;
        }
        if (chunk.type === 'meta') {
          setMessages((m) => m.map((x) => x.id === assistantId && x.role === 'assistant' ? { ...x, selectedModel: chunk.selectedModel, thinkingApplied: chunk.thinkingApplied } : x));
        } else if (chunk.type === 'reasoning') {
          if (!firstTokenAt) firstTokenAt = Date.now();
          const ft = firstTokenAt;
          setMessages((m) => m.map((x) => x.id === assistantId && x.role === 'assistant' ? { ...x, reasoning: x.reasoning + (chunk.text ?? ''), firstTokenAt: x.firstTokenAt ?? ft } : x));
        } else if (chunk.type === 'content') {
          if (!firstTokenAt) firstTokenAt = Date.now();
          const ft = firstTokenAt;
          setMessages((m) => m.map((x) => x.id === assistantId && x.role === 'assistant' ? { ...x, content: x.content + (chunk.text ?? ''), firstTokenAt: x.firstTokenAt ?? ft } : x));
        } else if (chunk.type === 'error') {
          setMessages((m) => m.map((x) => x.id === assistantId && x.role === 'assistant' ? { ...x, status: 'error', errorText: `status=${chunk.status}: ${chunk.error}`, finishedAt: Date.now() } : x));
        } else if (chunk.type === 'done') {
          setMessages((m) => m.map((x) => x.id === assistantId && x.role === 'assistant' ? { ...x, status: 'done', finishedAt: Date.now(), finishReason: chunk.finishReason, completionTokens: chunk.usage?.completion_tokens } : x));
        }
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setMessages((m) => m.map((x) => x.id === assistantId && x.role === 'assistant' ? { ...x, status: 'error', errorText: msg, finishedAt: Date.now() } : x));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }, [messages, thinking, opts]);

  // Drain queue when becoming idle
  useEffect(() => {
    if (!busy && queue.length > 0) {
      const [next, ...rest] = queue;
      setQueue(rest);
      sendNow(next);
    }
  }, [busy, queue, sendNow]);

  const enqueueOrSend = useCallback((text: string) => {
    if (!text.trim()) return;
    if (busy) setQueue((q) => [...q, text]);
    else sendNow(text);
  }, [busy, sendNow]);

  const interrupt = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  const reset = useCallback(() => {
    setMessages(opts.systemPrompt ? [{ id: nextId++, role: 'system', content: `system: ${opts.systemPrompt}` } as SystemMessage] : []);
  }, [opts.systemPrompt]);

  const pushSystemNote = useCallback((text: string) => {
    setMessages((m) => [...m, { id: nextId++, role: 'system', content: text } as SystemMessage]);
  }, []);

  const pushUserMessage = useCallback((text: string) => {
    sysHistory.current.push(text);
    setMessages((m) => [...m, { id: nextId++, role: 'user', content: text, ts: Date.now() } as UserMessage]);
  }, []);

  const pushAssistantMessage = useCallback((content: string, model?: string) => {
    const now = Date.now();
    const msg: AssistantMessage = {
      id: nextId++,
      role: 'assistant',
      content,
      reasoning: '',
      selectedModel: model,
      status: 'done',
      startedAt: now,
      finishedAt: now,
    };
    setMessages((m) => [...m, msg]);
  }, []);

  const buildHistorySnapshot = useCallback((): ChatMessage[] => {
    return buildHistoryWith(messages, opts.systemPrompt, []);
  }, [messages, opts.systemPrompt]);

  return {
    messages,
    queue,
    busy,
    showThinking, setShowThinking,
    thinking, setThinking,
    stream, setStream,
    enqueueOrSend,
    interrupt,
    reset,
    pushSystemNote,
    pushUserMessage,
    pushAssistantMessage,
    buildHistorySnapshot,
    history: sysHistory.current,
  };
}

function buildHistoryWith(messages: Message[], systemPrompt: string | undefined, extra: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant' && m.status === 'done' && m.content) out.push({ role: 'assistant', content: m.content });
  }
  out.push(...extra);
  return out;
}
