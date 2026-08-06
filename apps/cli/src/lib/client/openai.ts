import { readFile } from 'node:fs/promises';
import { paths, resolveProfile } from '../config/paths.js';
import { localBaseUrl } from '../net/local.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  content: string;
  reasoning?: string;
  selectedModel?: string;
  thinkingApplied?: string;
  raw: any;
  status: number;
  latencyMs: number;
}

const cachedKeyByEnvFile = new Map<string, string>();

export async function readApiKey(envFile?: string): Promise<string> {
  const target = envFile ?? (() => {
    try { return paths(resolveProfile()).env; } catch { return ''; }
  })();
  if (target && cachedKeyByEnvFile.has(target)) return cachedKeyByEnvFile.get(target)!;
  if (target) {
    try {
      const env = await readFile(target, 'utf8');
      const m = env.match(/REGOLO_API_KEY=([^\s]+)/);
      if (m) {
        cachedKeyByEnvFile.set(target, m[1]);
        return m[1];
      }
    } catch {}
  }
  const fallback = process.env.REGOLO_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
  if (target) cachedKeyByEnvFile.set(target, fallback);
  return fallback;
}

export interface StreamChunk {
  type: 'reasoning' | 'content' | 'done' | 'meta' | 'error';
  text?: string;
  selectedModel?: string;
  thinkingApplied?: string;
  finishReason?: string;
  usage?: any;
  status?: number;
  error?: string;
}

export type ThinkingMode = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

export async function* chatCompletionStream(opts: {
  baseUrl?: string;
  model?: string;
  messages: ChatMessage[];
  apiKey?: string;
  maxTokens?: number;
  timeoutMs?: number;
  thinking?: ThinkingMode | null;
  selectedModel?: string;
  signal?: AbortSignal;
}): AsyncGenerator<StreamChunk, void, unknown> {
  const baseUrl = opts.baseUrl ?? localBaseUrl(8000);
  const key = opts.apiKey ?? (await readApiKey());
  const externalSignal = opts.signal;
  const ctrl = externalSignal ? null : new AbortController();
  const timeout = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120000) : null;
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${key}`,
    };
    if (opts.thinking) headers['X-Brick-Thinking'] = opts.thinking;
    if (opts.selectedModel) headers['x-selected-model'] = opts.selectedModel;
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: opts.model ?? 'brick',
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 4096,
        stream: true,
      }),
      signal: externalSignal ?? ctrl!.signal,
    });
    const selectedModel =
      res.headers.get('x-vsr-selected-model') ??
      res.headers.get('x-selected-model') ??
      res.headers.get('x-litellm-model-group') ??
      undefined;
    const thinkingApplied = res.headers.get('x-brick-thinking-mode') ?? undefined;
    yield { type: 'meta', selectedModel, status: res.status, thinkingApplied };
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      yield { type: 'error', error: errText.slice(0, 400), status: res.status };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finishReason: string | undefined;
    let usage: any | undefined;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const evt: any = JSON.parse(payload);
          const delta = evt?.choices?.[0]?.delta ?? {};
          const fr = evt?.choices?.[0]?.finish_reason;
          if (fr) finishReason = fr;
          if (evt?.usage) usage = evt.usage;
          if (delta.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content };
          if (delta.content) yield { type: 'content', text: delta.content };
        } catch {
          // ignore parse errors mid-stream
        }
      }
    }
    yield { type: 'done', finishReason, usage };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: any;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessageWithTools {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export async function chatCompletion(opts: {
  baseUrl?: string;
  model?: string;
  messages: ChatMessage[] | ChatMessageWithTools[];
  apiKey?: string;
  stream?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
  thinking?: ThinkingMode | null;
  tools?: ToolDef[];
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}): Promise<ChatResult & { toolCalls?: ToolCall[]; assistantMessage?: ChatMessageWithTools }> {
  const baseUrl = opts.baseUrl ?? localBaseUrl(8000);
  const key = opts.apiKey ?? (await readApiKey());
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 180000);
  const t0 = performance.now();
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    };
    if (opts.thinking) headers['X-Brick-Thinking'] = opts.thinking;
    const body: any = {
      model: opts.model ?? 'brick',
      messages: opts.messages,
      max_tokens: opts.maxTokens ?? 512,
      stream: false,
    };
    if (opts.tools && opts.tools.length) {
      body.tools = opts.tools;
      body.tool_choice = opts.toolChoice ?? 'auto';
    }
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const selectedModel =
      res.headers.get('x-vsr-selected-model') ??
      res.headers.get('x-selected-model') ??
      res.headers.get('x-litellm-model-group') ??
      undefined;
    const thinkingApplied = res.headers.get('x-brick-thinking-mode') ?? undefined;
    const status = res.status;
    const json: any = await res.json().catch(() => ({}));
    const msg = json?.choices?.[0]?.message ?? {};
    const reasoning: string | undefined = msg.reasoning_content || msg.thinking || undefined;
    const content: string = msg.content ?? json?.error?.message ?? '';
    const toolCalls: ToolCall[] | undefined = Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : undefined;
    const latencyMs = Math.round(performance.now() - t0);
    return {
      content,
      reasoning,
      selectedModel,
      thinkingApplied,
      raw: json,
      status,
      latencyMs,
      toolCalls,
      assistantMessage: {
        role: 'assistant',
        content: msg.content ?? null,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}
