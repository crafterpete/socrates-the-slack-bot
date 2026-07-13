import type { ChatMessage } from "../shared/chat.js";

export type { ChatMessage };

type ThreadState = {
  messages: ChatMessage[];
  updatedAt: number;
};

const threadStore = new Map<string, ThreadState>();
const MAX_MESSAGES_PER_THREAD = 20;

function getThreadKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}:${threadTs}` : channelId;
}

export function getThreadHistory(channelId: string, threadTs?: string): ChatMessage[] {
  const key = getThreadKey(channelId, threadTs);
  return threadStore.get(key)?.messages ?? [];
}

export function appendThreadMessage(
  channelId: string,
  threadTs: string | undefined,
  message: ChatMessage,
): ChatMessage[] {
  const key = getThreadKey(channelId, threadTs);
  const existing = threadStore.get(key)?.messages ?? [];
  const next = [...existing, message].slice(-MAX_MESSAGES_PER_THREAD);

  threadStore.set(key, { messages: next, updatedAt: Date.now() });
  return next;
}
