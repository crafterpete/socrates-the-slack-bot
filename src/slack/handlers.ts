import type { App } from "@slack/bolt";
import { requestConfig } from "../agent/gateway.js";
import { askAgent, createQaAgent } from "../agent/index.js";
import { maybeCompactThread } from "../memory/compaction.js";
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
const THINKING_LINES = [
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
  return THINKING_LINES[Math.floor(Math.random() * THINKING_LINES.length)]!;
}

// Maps a Slack reaction name to human feedback. Skin-tone suffixes (`+1::skin-tone-3`) and the
// `thumbsup`/`thumbsdown` aliases all count; every other reaction is ignored.
function reactionSentiment(reaction: string): Sentiment | null {
  const base = reaction.split("::")[0];
  if (base === "+1" || base === "thumbsup") return "up";
  if (base === "-1" || base === "thumbsdown") return "down";
  return null;
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

  await client.reactions.add({ channel, timestamp: messageTs, name: "eyes" });

  // Reply instantly with a placeholder, then edit that same message into the final answer. If the
  // placeholder post fails, replyTs stays undefined and we fall back to posting the answer fresh.
  const placeholder = await client.chat
    .postMessage({ channel, thread_ts: conversationTs, text: pickThinkingLine() })
    .catch(() => undefined);
  const replyTs = typeof placeholder?.ts === "string" ? placeholder.ts : undefined;

  const deliver = async (text: string): Promise<void> => {
    if (replyTs) {
      await client.chat.update({ channel, ts: replyTs, text });
      // Log what was said under this message ts so a 👍/👎 reaction on it can be traced to its Q&A.
      recordAgentResponse({ messageTs: replyTs, channel, threadTs: conversationTs, question, answer: text });
    } else {
      await say({ text, thread_ts: conversationTs });
    }
  };

  // Swap the "thinking" reaction for a permanent outcome marker so Socrates' acknowledgement stays
  // visible on the question: :classical_building: when he answers, :warning: when something went wrong.
  const settleReaction = async (name: string): Promise<void> => {
    await client.reactions.remove({ channel, timestamp: messageTs, name: "eyes" }).catch(() => undefined);
    await client.reactions.add({ channel, timestamp: messageTs, name }).catch(() => undefined);
  };

  const history = toAgentMessages(getThreadState(channel, conversationTs));
  appendThreadMessage(channel, conversationTs, { role: "user", content: question });

  try {
    const messages = [...history, { role: "user" as const, content: question }];
    const answer = escapeBroadcasts(
      await askAgent(agent, messages, requestConfig({ userId, channel, threadTs: conversationTs })),
    );

    appendThreadMessage(channel, conversationTs, { role: "assistant", content: answer });
    await deliver(answer);
    await settleReaction("classical_building");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const reply = escapeBroadcasts(`Apologies — I stumbled while reasoning that one through: ${message}`);
    appendThreadMessage(channel, conversationTs, { role: "assistant", content: reply });
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

  app.message(async ({ message, say, client }) => {
    if (message.subtype || !("text" in message) || !message.text || !message.user) {
      return;
    }

    // Continue multi-turn conversations inside an existing thread.
    if (!message.thread_ts || message.thread_ts === message.ts) {
      return;
    }

    await handleUserQuestion({
      channel: message.channel,
      threadTs: message.thread_ts,
      userId: message.user,
      userText: message.text,
      say,
      client,
      messageTs: message.ts,
    });
  });

  // Capture 👍/👎 on Socrates' own answers as human feedback for the eval dataset. We only care about
  // thumbs reactions landing on a message Socrates authored (item_user === the bot).
  app.event("reaction_added", async ({ event, context }) => {
    if (event.item.type !== "message" || event.item_user !== context.botUserId) return;
    const sentiment = reactionSentiment(event.reaction);
    if (!sentiment) return;

    const recorded = recordFeedback({
      responseTs: event.item.ts,
      channel: event.item.channel,
      userId: event.user,
      sentiment,
    });
    if (recorded) {
      console.log(`Feedback: ${sentiment} on ${event.item.ts} from ${event.user}`);
    }
  });

  app.event("reaction_removed", async ({ event, context }) => {
    if (event.item.type !== "message" || event.item_user !== context.botUserId) return;
    const sentiment = reactionSentiment(event.reaction);
    if (!sentiment) return;

    removeFeedback({ responseTs: event.item.ts, userId: event.user, sentiment });
  });
}
