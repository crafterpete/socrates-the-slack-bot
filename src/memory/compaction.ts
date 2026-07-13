import { ChatAnthropic } from "@langchain/anthropic";
import { env } from "../config/env.js";
import type { ChatMessage } from "../shared/chat.js";
import { compactThread, getThreadState } from "./thread-store.js";

export const COMPACTION_THRESHOLD = 24;
export const KEEP_RECENT = 8;

const SUMMARY_PROMPT = `You maintain a running summary of a Slack conversation between users and a
database Q&A assistant. Merge the previous summary (if any) with the new messages into a single
updated summary. Preserve concrete facts the assistant reported (names, ids, numbers, dates),
what the users asked about, and any open questions or corrections. Drop pleasantries and
repetition. Respond with only the updated summary, in at most 200 words.`;

export type Summarizer = (
  previousSummary: string | undefined,
  messages: ChatMessage[],
) => Promise<string>;

let summaryModel: ChatAnthropic | undefined;

async function summarizeWithModel(
  previousSummary: string | undefined,
  messages: ChatMessage[],
): Promise<string> {
  summaryModel ??= new ChatAnthropic({ model: env.ANTHROPIC_MODEL, maxTokens: 512 });
  const transcript = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  const input = previousSummary
    ? `Previous summary:\n${previousSummary}\n\nNew messages to fold in:\n${transcript}`
    : `Messages to summarize:\n${transcript}`;
  const response = await summaryModel.invoke([
    ["system", SUMMARY_PROMPT],
    ["human", input],
  ]);
  return response.text;
}

export async function maybeCompactThread(
  channelId: string,
  threadTs: string | undefined,
  summarize: Summarizer = summarizeWithModel,
): Promise<boolean> {
  const { summary, messages } = getThreadState(channelId, threadTs);
  if (messages.length < COMPACTION_THRESHOLD) return false;

  const toFold = messages.slice(0, messages.length - KEEP_RECENT);
  const lastFolded = toFold.at(-1);
  if (!lastFolded) return false;

  const nextSummary = await summarize(summary, toFold);
  compactThread(channelId, threadTs, { summary: nextSummary, throughId: lastFolded.id });
  return true;
}
