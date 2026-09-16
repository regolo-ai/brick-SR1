import type { ChatMessage } from '../client/openai.js';

export interface BuildAgentPromptArgs {
  query: string;
  history: ChatMessage[];
  turn: number;
  selfModel: string;
  previousResponses?: Map<string, string>;
}

export function buildAgentPrompt(args: BuildAgentPromptArgs): ChatMessage[] {
  const { query, history, turn, selfModel, previousResponses } = args;

  if (turn === 1 || !previousResponses || previousResponses.size === 0) {
    return [...history, { role: 'user', content: query }];
  }

  const others = Array.from(previousResponses.entries()).filter(([m]) => m !== selfModel);

  if (others.length === 0) {
    return [...history, { role: 'user', content: query }];
  }

  const othersBlock = others
    .map(([m, r]) => `--- Model ${m} ---\n${r.trim()}`)
    .join('\n\n');

  const myPrev = previousResponses.get(selfModel);

  const systemAddendum: ChatMessage = {
    role: 'system',
    content:
      `You are model "${selfModel}" in a multi-model discussion (BABL/Babele mode).\n` +
      `You are participating in turn ${turn}. In the previous turn, the other models answered the user query.\n\n` +
      `OTHER MODELS’ RESPONSES IN TURN ${turn - 1}:\n\n${othersBlock}\n\n` +
      (myPrev ? `YOUR PREVIOUS RESPONSE:\n${myPrev.trim()}\n\n` : '') +
      `Now produce an improved response that:\n` +
      `1. Integrates valid points from the other responses\n` +
      `2. Critiques or corrects any errors you notice\n` +
      `3. Adds missing perspectives\n` +
      `Do not simply repeat your previous response. Be concise and direct.`,
  };

  return [...history, systemAddendum, { role: 'user', content: query }];
}

export function buildModeratorPrompt(query: string, finalResponses: Map<string, string>): ChatMessage[] {
  const responsesBlock = Array.from(finalResponses.entries())
    .map(([m, r]) => `--- Model ${m} ---\n${r.trim()}`)
    .join('\n\n');

  return [
    {
      role: 'system',
      content:
        `You are an expert moderator. You received ${finalResponses.size} responses from different models to the same user query.\n` +
        `Synthesize a single coherent, accurate, high-quality response.\n` +
        `Resolve contradictions, combine strengths and ignore obvious errors.\n` +
        `Do not mention individual models or multiple responses: produce a complete response as your own.`,
    },
    {
      role: 'user',
      content:
        `Original user query:\n"${query}"\n\nModel responses:\n\n${responsesBlock}\n\nProduce the final synthesis now.`,
    },
  ];
}
