import type { App } from "@slack/bolt";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { logInputClassification } from "../agent/classifier.js";
import { requestConfig } from "../agent/gateway.js";
import { askAgent, createQaAgent } from "../agent/index.js";
import { COMPACTION_THRESHOLD, maybeCompactThread } from "../memory/compaction.js";
import {
  recordAgentResponse,
  recordFeedback,
  removeFeedback,
  type Sentiment,
} from "../memory/feedback-store.js";
import { appendThreadMessage, getThreadState, toAgentMessages } from "../memory/thread-store.js";
import { escapeBroadcasts, normalizeUserInput, stripBotMention } from "./text.js";

const agent = createQaAgent();

// Socrates posts one of these the instant a question lands, then edits it into the real answer once
// the agent finishes — so the user gets an immediate, on-brand acknowledgement instead of silence.
const THINKING_LINES: [string, ...string[]] = [
  "Let me examine the records — the unexamined query is not worth answering. :hourglass_flowing_sand:",
  "One moment while I interrogate the database… questioning things is rather my whole method. :thinking_face:",
  "I know that I know nothing — give me a moment to remedy that. Consulting the archives. :scroll:",
  "A worthy question. Let me go find out what I actually know about it. :mag:",
  "Buzzing around your database like the gadfly of Athens until it admits what it knows. :honeybee:",
  "My inner daimonion whispered 'check the artifacts table,' and one does not argue with a divine voice. :sparkles:",
  "I never wrote any of this down — that was Plato's job — so allow me a moment to look it all up again. :scroll:",
  "But what IS an 'implementation,' really? I'll ask the database until it weeps, then get back to you. :thinking_face:",
];

function pickThinkingLine(): string {
  return THINKING_LINES[Math.floor(Math.random() * THINKING_LINES.length)] ?? THINKING_LINES[0];
}

// Progress edits to the placeholder while the agent works: a running tool-call count plus a
// rotating Socratic remark, cycled deterministically so consecutive updates never repeat.
const PROGRESS_LINES: [string, ...string[]] = [
  "The first answer only deepens the question, as is tradition.",
  "Cross-examining the records; they hold up better than most of my interlocutors.",
  "Each table refers me to another. Very Athenian of them.",
  "The evidence assembles; I merely supply the annoying questions.",
  "Wisdom begins in wonder and ends, apparently, in SQL.",
  "We have reached the part of the dialogue where the database contradicts itself.",
  "A few more questions and the truth will have nowhere left to hide.",
];

export function progressLine(toolCalls: number): string {
  const blurb = PROGRESS_LINES[(toolCalls - 1) % PROGRESS_LINES.length] ?? PROGRESS_LINES[0];
  return `:hourglass_flowing_sand: Inquiry ${toolCalls}: ${blurb}`;
}

// Watches the agent run via LangChain callbacks and edits the placeholder message as tool calls
// happen. Updates are queued so they land in order, throttled so Slack's rate limit is respected,
// and finish() must be awaited before posting the real answer so a stale progress edit can never
// overwrite it.
export class SlackProgressHandler extends BaseCallbackHandler {
  name = "slack_progress";
  private toolCalls = 0;
  private lastUpdateMs = 0;
  private done = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly update: (text: string) => Promise<unknown>,
    private readonly minIntervalMs = 1000,
  ) {
    super();
  }

  handleToolStart(): void {
    this.toolCalls += 1;
    const n = this.toolCalls;
    if (this.done) return;
    const now = Date.now();
    if (now - this.lastUpdateMs < this.minIntervalMs) return;
    this.lastUpdateMs = now;
    this.queue = this.queue
      .then(() => this.update(progressLine(n)))
      .then(
        () => undefined,
        () => undefined,
      );
  }

  async finish(): Promise<void> {
    this.done = true;
    await this.queue;
  }
}

// Maps a Slack reaction name to human feedback. Skin-tone suffixes (`+1::skin-tone-3`) and the
// `thumbsup`/`thumbsdown` aliases all count; every other reaction is ignored.
export function reactionSentiment(reaction: string): Sentiment | null {
  const base = reaction.split("::")[0];
  if (base === "+1" || base === "thumbsup") return "up";
  if (base === "-1" || base === "thumbsdown") return "down";
  return null;
}

type ThreadReplies = {
  messages?: { text?: string; user?: string; ts?: string; subtype?: string; bot_id?: string }[];
  response_metadata?: { next_cursor?: string };
};

// Posts the answer by editing the placeholder when one exists, or as a fresh message otherwise.
// Either way the answer is logged under the message ts it ended up at, so a 👍/👎 reaction on it
// can be traced to its Q&A.
export async function deliverAnswer(args: {
  channel: string;
  threadTs: string;
  question: string;
  answer: string;
  replyTs: string | undefined;
  update: (args: { channel: string; ts: string; text: string }) => Promise<unknown>;
  say: (message: { text: string; thread_ts?: string }) => Promise<unknown>;
}): Promise<void> {
  const { channel, threadTs, question, answer, replyTs, update, say } = args;
  let messageTs = replyTs;
  if (messageTs) {
    await update({ channel, ts: messageTs, text: answer });
  } else {
    const posted = (await say({ text: answer, thread_ts: threadTs })) as { ts?: unknown } | undefined;
    messageTs = typeof posted?.ts === "string" ? posted.ts : undefined;
  }
  if (messageTs) {
    recordAgentResponse({ messageTs, channel, threadTs, question, answer });
  }
}

// First mention in a thread that started as user-to-user talk: import the discussion so far so
// the bot doesn't referee an argument it never saw. Capped at the newest COMPACTION_THRESHOLD
// human messages, so a giant pre-existing thread can never blow past the compaction contract.
export async function backfillThread(
  fetchReplies: (args: { channel: string; ts: string; limit?: number; cursor?: string }) => Promise<ThreadReplies>,
  channel: string,
  threadTs: string,
  triggerTs: string,
): Promise<void> {
  let window: { text: string; user: string }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await fetchReplies({ channel, ts: threadTs, limit: 200, cursor });
    const eligible = (result.messages ?? []).filter(
      (m): m is { text: string; user: string; ts?: string } =>
        typeof m.text === "string" && m.text.length > 0 && typeof m.user === "string" &&
        !m.subtype && !m.bot_id && m.ts !== triggerTs,
    );
    window = [...window, ...eligible].slice(-COMPACTION_THRESHOLD);
    cursor = result.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  for (const m of window) {
    const content = normalizeUserInput(m.text);
    if (!content) continue;
    appendThreadMessage(channel, threadTs, { role: "user", content, author: m.user });
  }
}

async function handleUserQuestion(args: {
  channel: string;
  threadTs?: string;
  userId: string;
  userText: string;
  say: (message: { text: string; thread_ts?: string }) => Promise<unknown>;
  client: {
    reactions: {
      add: (args: { channel: string; timestamp: string; name: string }) => Promise<unknown>;
      remove: (args: { channel: string; timestamp: string; name: string }) => Promise<unknown>;
    };
    chat: {
      postMessage: (args: { channel: string; thread_ts?: string; text: string }) => Promise<{ ts?: string }>;
      update: (args: { channel: string; ts: string; text: string }) => Promise<unknown>;
    };
    conversations: {
      replies: (args: { channel: string; ts: string; limit?: number; cursor?: string }) => Promise<ThreadReplies>;
    };
  };
  messageTs: string;
}): Promise<void> {
  const { channel, threadTs, userId, userText, say, client, messageTs } = args;
  // A top-level mention has no thread_ts yet, but our reply creates a thread rooted at the
  // triggering message — so that message's ts is the conversation key follow-ups will carry.
  const conversationTs = threadTs ?? messageTs;
  const question = normalizeUserInput(stripBotMention(userText));

  if (!question) {
    await say({
      text: "Ask me a question about customers, implementations, or internal records in the database.",
      thread_ts: threadTs,
    });
    return;
  }

  logInputClassification(question, { userId, channel, threadTs: conversationTs });

  await client.reactions.add({ channel, timestamp: messageTs, name: "eyes" });

  // Reply instantly with a placeholder, then edit that same message into the final answer. If the
  // placeholder post fails, replyTs stays undefined and we fall back to posting the answer fresh.
  const placeholder = await client.chat
    .postMessage({ channel, thread_ts: conversationTs, text: pickThinkingLine() })
    .catch(() => undefined);
  const replyTs = typeof placeholder?.ts === "string" ? placeholder.ts : undefined;

  const deliver = (text: string): Promise<void> =>
    deliverAnswer({
      channel,
      threadTs: conversationTs,
      question,
      answer: text,
      replyTs,
      update: client.chat.update,
      say,
    });

  // Swap the "thinking" reaction for a permanent outcome marker so Socrates' acknowledgement stays
  // visible on the question: :classical_building: when he answers, :warning: when something went wrong.
  const settleReaction = async (name: string): Promise<void> => {
    await client.reactions.remove({ channel, timestamp: messageTs, name: "eyes" }).catch(() => undefined);
    await client.reactions.add({ channel, timestamp: messageTs, name }).catch(() => undefined);
  };

  let state = getThreadState(channel, conversationTs);
  if (threadTs && !state.summary && state.messages.length === 0) {
    await backfillThread(client.conversations.replies, channel, conversationTs, messageTs).catch(
      (error) => console.error("Thread backfill failed:", error),
    );
    state = getThreadState(channel, conversationTs);
  }
  const history = toAgentMessages(state);
  appendThreadMessage(channel, conversationTs, { role: "user", content: question, author: userId });

  const progress = replyTs
    ? new SlackProgressHandler((text) => client.chat.update({ channel, ts: replyTs, text }))
    : undefined;
  const agentConfig = {
    ...requestConfig({ userId, channel, threadTs: conversationTs }),
    ...(progress ? { callbacks: [progress] } : {}),
  };

  try {
    const messages = [...history, { role: "user" as const, content: `@${userId}: ${question}` }];
    const answer = escapeBroadcasts(await askAgent(agent, messages, agentConfig));

    appendThreadMessage(channel, conversationTs, { role: "assistant", content: answer });
    await progress?.finish();
    await deliver(answer);
    await settleReaction("classical_building");
  } catch (error) {
    // Raw error text (SQL fragments, provider request ids, zod internals) stays in the server log;
    // the channel gets a generic apology traceable back here via the thread ts.
    console.error(`Agent error in ${channel}/${conversationTs}:`, error);
    const reply = "Apologies — I stumbled while reasoning that one through. Try rephrasing, or ask again in a moment.";
    appendThreadMessage(channel, conversationTs, { role: "assistant", content: reply });
    await progress?.finish();
    await deliver(reply);
    await settleReaction("warning");
  } finally {
    maybeCompactThread(channel, conversationTs).catch((error) => {
      console.error("Thread compaction failed:", error);
    });
  }
}

export function registerSlackHandlers(app: App): void {
  app.event("app_mention", async ({ event, say, client }) => {
    await handleUserQuestion({
      channel: event.channel,
      threadTs: event.thread_ts,
      userId: event.user ?? "unknown",
      userText: event.text,
      say,
      client,
      messageTs: event.ts,
    });
  });

  // Passive capture: replies in a thread the bot is already conversing in get stored as context
  // so the next mention sees the discussion that happened in between. The bot only ever answers
  // mentions (handled above); it never interjects into user-to-user talk.
  app.message(async ({ message, context }) => {
    if (message.subtype || !("text" in message) || !message.text || !message.user) {
      return;
    }
    if ("bot_id" in message && message.bot_id) {
      return;
    }
    if (!message.thread_ts || message.thread_ts === message.ts) {
      return;
    }
    // Mentions also fire app_mention; capturing them here too would store the question twice.
    if (context.botUserId && message.text.includes(`<@${context.botUserId}>`)) {
      return;
    }

    const state = getThreadState(message.channel, message.thread_ts);
    if (!state.summary && state.messages.length === 0) {
      return;
    }

    const content = normalizeUserInput(message.text);
    if (!content) {
      return;
    }

    // Store only; no compaction here. DB writes are cheap, summarization is not — captured
    // chatter gets folded in one pass the next time the bot is actually tagged.
    appendThreadMessage(message.channel, message.thread_ts, {
      role: "user",
      content,
      author: message.user,
    });
  });

  // Capture 👍/👎 on Socrates' own answers as human feedback for the eval dataset. We only care about
  // thumbs reactions landing on a message Socrates authored (item_user === the bot).
  app.event("reaction_added", async ({ event, context }) => {
    if (event.item.type !== "message") return;
    if (event.item_user !== context.botUserId) {
      console.log(`Reaction ignored (not on a bot message): :${event.reaction}: on ${event.item.ts} authored by ${event.item_user ?? "unknown"}`);
      return;
    }
    const sentiment = reactionSentiment(event.reaction);
    if (!sentiment) {
      console.log(`Reaction ignored (not a thumbs signal): :${event.reaction}: on ${event.item.ts}`);
      return;
    }

    const recorded = recordFeedback({
      responseTs: event.item.ts,
      channel: event.item.channel,
      userId: event.user,
      sentiment,
    });
    console.log(
      recorded
        ? `Feedback: ${sentiment} on ${event.item.ts} from ${event.user}`
        : `Feedback ignored: ${event.item.ts} is not a recorded agent answer`,
    );
  });

  app.event("reaction_removed", async ({ event, context }) => {
    if (event.item.type !== "message" || event.item_user !== context.botUserId) return;
    const sentiment = reactionSentiment(event.reaction);
    if (!sentiment) return;

    removeFeedback({ responseTs: event.item.ts, userId: event.user, sentiment });
  });
}
